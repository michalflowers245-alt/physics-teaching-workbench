"""Generate reviewed teaching DTOs only; no source solutions or learner identities accepted."""
import argparse
import base64
import io
import json
import os
import re
import sys
from xml.sax.saxutils import escape
from PIL import Image as PILImage


def text(value):
    return str(value) if isinstance(value, (str, int, float)) else ""


def image_stream(asset):
    if not asset.get("teachingSafe") or asset.get("kind") == "page":
        raise ValueError("Unreviewed teaching image")
    raw = base64.b64decode(asset["dataBase64"], validate=True)
    image = PILImage.open(io.BytesIO(raw))
    image.load()
    if image.width * image.height > 30_000_000:
        raise ValueError("Teaching image too large")
    # Stored assets are already cropped. bbox/crop are provenance, not a second crop.
    output = io.BytesIO()
    image.convert("RGB").save(output, format="PNG")
    output.seek(0)
    return output, image.width, image.height


def source_label(question):
    source = question.get("source", {})
    if question.get("generated"):
        return "本地参数化原创题 不计入中考频次"
    return f"{text(source.get('year'))}年{text(source.get('region'))} 第{text(source.get('questionNo'))}题 原卷第{text(source.get('pageNo'))}页"


def explanation_label(question):
    return "教师分步解析" if question.get("explanationOrigin") == "teacher" else "AI原创分步解析（已审核）"


def title(dto):
    suffix = "教师讲义" if dto["audience"] == "teacher" else "延时回测卷" if dto["section"] == "retest" else "学生训练卷"
    return re.sub(r"[·•：:，,。.!！?？/\\]", " ", text(dto["title"]) + " " + suffix)


def docx_export(dto, output):
    from docx import Document
    from docx.shared import Inches, Pt, RGBColor
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    doc = Document()
    section = doc.sections[0]
    section.page_width, section.page_height = Inches(8.5), Inches(11)
    section.top_margin = section.bottom_margin = Inches(.7)
    section.left_margin = section.right_margin = Inches(.75)
    for name in ("Normal", "Title", "Heading 1", "Heading 2"):
        style = doc.styles[name]
        style.font.name = "Songti SC"
        style.font.color.rgb = RGBColor(0, 0, 0)
        style._element.get_or_add_rPr().rFonts.set(qn("w:eastAsia"), "Songti SC")
        for key in ("asciiTheme", "hAnsiTheme", "eastAsiaTheme", "cstheme"):
            style._element.get_or_add_rPr().rFonts.attrib.pop(qn("w:" + key), None)
        style.font.size = Pt(11 if name == "Normal" else 18 if name == "Title" else 13)
    for style in doc.styles:
        for border in list(style._element.iter(qn("w:pBdr"))):
            border.getparent().remove(border)
    doc.styles["Normal"].paragraph_format.space_after = Pt(5)
    doc.styles["Normal"].paragraph_format.line_spacing = 1.15
    doc.add_paragraph(title(dto), "Title")
    doc.add_paragraph("本讲义按错误模型组织诊断、基础修补、真题、辨析、变式、迁移与延时回测。先完成前17题，再于训练后第3天和第7天独立完成回测。")
    if dto.get("isSynthetic"):
        doc.add_paragraph("合成测试资料 仅供软件验收 不代表真实长沙中考来源")
    previous_stage = None
    for item in dto["items"]:
        q = item["question"]
        start_paragraph = len(doc.paragraphs)
        if item["stage"] != previous_stage:
            doc.add_paragraph(re.sub(r"[·•]", " ", item["stage"]), "Heading 1")
            previous_stage = item["stage"]
        p = doc.add_paragraph(f"第{item['number']}题  {q.get('score', '')}分", "Heading 2")
        p.paragraph_format.keep_with_next = True
        p = doc.add_paragraph(text(q["stem"]))
        p.paragraph_format.keep_with_next = bool(q.get("imageAssets") or q.get("tables"))
        for option in q.get("options", []):
            doc.add_paragraph(text(option))
        for asset in q.get("imageAssets", []):
            stream, width, height = image_stream(asset)
            draw_width = min(6.5, width / 140, 3.5 * width / height)
            doc.add_picture(stream, width=Inches(draw_width))
        for table in q.get("tables", []):
            rows = [table.get("headers", [])] + table.get("rows", [])
            cols = max((len(row) for row in rows), default=0)
            if not cols:
                continue
            out = doc.add_table(rows=len(rows), cols=cols)
            out.style = "Table Grid"
            for ri, row in enumerate(rows):
                for ci, val in enumerate(row):
                    cell = out.cell(ri, ci)
                    cell.text = text(val)
                    props = cell._tc.get_or_add_tcPr()
                    borders = OxmlElement("w:tcBorders")
                    for side in ("top", "left", "bottom", "right", "insideH", "insideV"):
                        border = OxmlElement("w:" + side)
                        border.set(qn("w:val"), "single")
                        border.set(qn("w:sz"), "4")
                        border.set(qn("w:color"), "D9D9D9")
                        borders.append(border)
                    props.append(borders)
                    if ri == 0:
                        shade = OxmlElement("w:shd")
                        shade.set(qn("w:fill"), "E8EEF3")
                        props.append(shade)
        doc.add_paragraph("答案  " + text(q.get("answer")))
        doc.add_paragraph(explanation_label(q) + "  " + text(q.get("solution")))
        doc.add_paragraph("评分点  " + "；".join(q.get("rubric", [])))
        doc.add_paragraph("选入理由  " + text(item.get("reason")))
        doc.add_paragraph("检测漏洞  " + text(item.get("detects")))
        doc.add_paragraph("来源  " + source_label(q))
        for paragraph in doc.paragraphs[start_paragraph:-1]:
            paragraph.paragraph_format.keep_with_next = True
        doc.paragraphs[-1].paragraph_format.keep_with_next = False
    doc.core_properties.author = ""
    doc.core_properties.last_modified_by = ""
    doc.save(output)


def pdf_export(dto, output):
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, Image, KeepTogether
    from reportlab.lib.pagesizes import letter
    candidates = [os.environ.get("EXAM_EXPORT_FONT", ""), "/System/Library/Fonts/Supplemental/Songti.ttc", "/System/Library/Fonts/Supplemental/Arial Unicode.ttf", "/usr/share/fonts/truetype/arphic/uming.ttc"]
    font_path = next((path for path in candidates if path and os.path.isfile(path)), None)
    if not font_path:
        raise ValueError("缺少可嵌入中文字体，请配置EXAM_EXPORT_FONT，禁止生成缺字PDF")
    font_index = int(os.environ.get("EXAM_EXPORT_FONT_INDEX", "6" if font_path.endswith("Songti.ttc") else "0"))
    pdfmetrics.registerFont(TTFont("TrainingChinese", font_path, subfontIndex=font_index))
    styles = {
        "title": ParagraphStyle("title", fontName="TrainingChinese", fontSize=17, leading=23, spaceAfter=12, textColor=colors.black),
        "body": ParagraphStyle("body", fontName="TrainingChinese", fontSize=11, leading=17, spaceAfter=7, wordWrap="CJK"),
        "heading": ParagraphStyle("heading", fontName="TrainingChinese", fontSize=12, leading=18, spaceBefore=8, spaceAfter=5, keepWithNext=True),
        "small": ParagraphStyle("small", fontName="TrainingChinese", fontSize=9, leading=13, spaceAfter=5),
    }
    para = lambda value, style="body": Paragraph(escape(text(value)).replace("\n", "<br/>"), styles[style])
    story = [para(title(dto), "title")]
    teacher = dto["audience"] == "teacher"
    if dto.get("isSynthetic"):
        story.append(para("合成测试资料 仅供软件验收 不代表真实长沙中考来源"))
    if teacher:
        story.append(para("共19题。前17题用于训练，后2题在训练后第3天和第7天独立完成。答案与选题理由仅供教师使用。"))
    else:
        story.append(para(f"共{len(dto['items'])}题。请独立作答，写清物理依据和必要步骤。"))
    for item in dto["items"]:
        q = item["question"]
        block = [para(f"第{item['number']}题  {q.get('score', '')}分", "heading"), para(q["stem"])]
        block += [para(option) for option in q.get("options", [])]
        for asset in q.get("imageAssets", []):
            stream, width, height = image_stream(asset)
            scale = min(468 / width, 230 / height, .6)
            block.append(Image(stream, width=width * scale, height=height * scale))
        for table in q.get("tables", []):
            rows = [table.get("headers", [])] + table.get("rows", [])
            cols = max((len(row) for row in rows), default=0)
            if cols:
                rows = [[para(v, "small") for v in row] + [""] * (cols - len(row)) for row in rows]
                t = Table(rows, colWidths=[468 / cols] * cols, repeatRows=1)
                t.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), .5, colors.HexColor("#D9D9D9")), ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#E8EEF3")), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LEFTPADDING", (0, 0), (-1, -1), 7), ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6)]))
                block.append(t)
        # Keep stem and required figures together. Oversize blocks can split naturally.
        if teacher:
            for label, value in [("答案", q.get("answer")), (explanation_label(q), q.get("solution")), ("评分点", "；".join(q.get("rubric", []))), ("选入理由", item.get("reason")), ("检测漏洞", item.get("detects")), ("来源", source_label(q))]:
                block.append(para(label + "  " + text(value)))
            story.append(KeepTogether(block))
        else:
            story.append(KeepTogether(block))
            story.append(Spacer(1, 52))
    def footer(canvas, doc):
        canvas.setFont("TrainingChinese", 9)
        canvas.drawCentredString(letter[0] / 2, 24, f"{doc.page}")
    SimpleDocTemplate(output, pagesize=letter, rightMargin=54, leftMargin=54, topMargin=42, bottomMargin=42, title=title(dto), author="").build(story, onFirstPage=footer, onLaterPages=footer)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--format", choices=["docx", "pdf"], required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    dto = json.load(sys.stdin)
    expected = 19 if dto["section"] == "all" else 2 if dto["section"] == "retest" else 17
    if len(dto["items"]) != expected:
        raise ValueError("Training item count mismatch")
    if args.format == "docx":
        if dto["audience"] != "teacher":
            raise ValueError("Editable lecture notes require teacher DTO")
        docx_export(dto, args.output)
    else:
        pdf_export(dto, args.output)


if __name__ == "__main__":
    main()
