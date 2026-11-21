"""Render the student-only DTO. Never load a question database or original PDF."""
import argparse
import base64
import io
import json
import os
import sys
import warnings
from xml.sax.saxutils import escape

from PIL import Image as PILImage, ImageChops
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Image, Table, TableStyle, KeepTogether

PILImage.MAX_IMAGE_PIXELS = 30_000_000
warnings.simplefilter("error", PILImage.DecompressionBombWarning)
# Embed the glyph subset so the downloaded file does not depend on a PDF
# viewer's optional Adobe CJK language pack or font substitution.
FONT_PATHS = [os.environ.get("EXAM_EXPORT_FONT", ""), "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
              "/usr/share/fonts/truetype/arphic/uming.ttc", "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"]
FONT = "StudentSheetCJK"
for font_path in FONT_PATHS:
    if font_path and os.path.isfile(font_path):
        try:
            pdfmetrics.registerFont(TTFont(FONT, font_path))
            break
        except Exception:
            continue
else:
    raise RuntimeError("PDF Chinese font missing: configure EXAM_EXPORT_FONT with a CJK TrueType font")
WIDTH = A4[0] - 30 * mm
BODY = ParagraphStyle("body", fontName=FONT, fontSize=11, leading=18, spaceAfter=5, wordWrap="CJK")
HEADING = ParagraphStyle("question", parent=BODY, fontSize=11, leading=17, spaceBefore=7, spaceAfter=6)
CELL = ParagraphStyle("cell", parent=BODY, fontSize=9, leading=13, spaceAfter=0)
TITLE = ParagraphStyle("title", parent=BODY, fontSize=18, leading=25, alignment=TA_CENTER, spaceAfter=12)


def paragraph(value, style=BODY):
    value = str(value) if isinstance(value, (str, int, float)) else ""
    return Paragraph(escape(value).replace("\n", "<br/>"), style)


def trim_vertical_white_borders(image, padding=8):
    """Layout-only crop: retain full width and every non-white pixel row.

    Using the darkest channel as grayscale also preserves almost-white colour
    marks that luminance conversion might round to 255. Threshold 255 is
    deliberately conservative: even a value of 254 is treated as content.
    The returned image is in memory; saved source crops are never modified.
    """
    rgb = image.convert("RGB")
    red, green, blue = rgb.split()
    gray = ImageChops.darker(ImageChops.darker(red, green), blue)
    bounds = gray.point(lambda value: 255 if value < 255 else 0).getbbox()
    if not bounds:
        return rgb
    top = max(0, bounds[1] - padding)
    bottom = min(rgb.height, bounds[3] + padding)
    return rgb.crop((0, top, rgb.width, bottom))


def drawing(asset, pixel_budget):
    raw = base64.b64decode(asset["dataBase64"], validate=True)
    with PILImage.open(io.BytesIO(raw)) as image:
        pixels = image.width * image.height
        pixel_budget[0] += pixels
        if pixels > 30_000_000 or pixel_budget[0] > 120_000_000 or max(image.width, image.height) > 30000:
            raise ValueError("image too large")
        image.load()
        layout_image = trim_vertical_white_borders(image)
        stream = io.BytesIO()
        layout_image.save(stream, "PNG")
        stream.seek(0)
        scale = min(WIDTH / layout_image.width, (A4[1] - 67 * mm) / layout_image.height)
        result = Image(stream, width=layout_image.width * scale, height=layout_image.height * scale)
        result.hAlign = "LEFT"
        return result


def footer(canvas, doc):
    canvas.saveState()
    canvas.setFont(FONT, 9)
    canvas.setFillColor(colors.HexColor("#555555"))
    canvas.drawCentredString(A4[0] / 2, 10 * mm, f"第 {doc.page} 页")
    canvas.restoreState()


def export(dto, output):
    pixel_budget = [0]
    document = SimpleDocTemplate(output, pagesize=A4, leftMargin=15 * mm, rightMargin=15 * mm,
                                 topMargin=15 * mm, bottomMargin=17 * mm,
                                 title=dto["title"], author="物理教学工作台", pageCompression=1)
    story = [paragraph(dto["title"], TITLE), paragraph("班级：________________    姓名：________________    日期：________________"), Spacer(1, 5 * mm)]
    for number, question in enumerate(dto["questions"], 1):
        score = f"  （{question['score']:g}分）" if question.get("score") else ""
        original = f"  原题号 {question['questionNo']}" if question.get("questionNo") else ""
        heading = f"第 {number} 题{score}{original}"
        if question["contentMode"] == "original":
            if not question["images"]:
                raise ValueError("original image missing")
            for segment, asset in enumerate(question["images"], 1):
                label = heading if segment == 1 else f"第 {number} 题（续题 {segment}/{len(question['images'])}）"
                story.append(KeepTogether([paragraph(label, HEADING), drawing(asset, pixel_budget), Spacer(1, 3 * mm)]))
        else:
            title = paragraph(heading, HEADING)
            title.keepWithNext = True
            story.extend([title, paragraph(question["stem"])])
            for option in question["options"]:
                story.append(paragraph(f"{option['label']}. {option['text']}"))
            for table in question["tables"]:
                rows = ([table["headers"]] if table["headers"] else []) + table["rows"]
                columns = max((len(row) for row in rows), default=0)
                if not columns:
                    continue
                data = [[paragraph(row[column] if column < len(row) else "", CELL) for column in range(columns)] for row in rows]
                out = Table(data, colWidths=[WIDTH / columns] * columns, repeatRows=1 if table["headers"] else 0, hAlign="LEFT")
                out.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), .4, colors.grey), ("VALIGN", (0, 0), (-1, -1), "TOP"),
                                         ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                                         ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5)]))
                story.extend([out, Spacer(1, 4 * mm)])
            for asset in question["images"]:
                story.extend([drawing(asset, pixel_budget), Spacer(1, 3 * mm)])
        story.append(Spacer(1, 10 * mm))
    document.build(story, onFirstPage=footer, onLaterPages=footer)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    source = sys.stdin.buffer.read(92 * 1024 * 1024)
    if len(source) >= 92 * 1024 * 1024:
        raise ValueError("payload too large")
    export(json.loads(source), args.output)
