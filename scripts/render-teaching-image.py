"""Render a phone-readable review sheet or a standalone lesson video card."""
import json
import math
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


FONT = "/System/Library/Fonts/STHeiti Medium.ttc"
palette = (Path(__file__).resolve().parents[1] / "production.css").read_text(encoding="utf-8")
def brand(name):
    match = re.search(r"--brand-" + name + r":(#[0-9A-Fa-f]{6})", palette)
    if not match:
        raise ValueError("缺少品牌配色 " + name)
    return match.group(1)
INK, GREEN, MUTED = brand("ink"), brand("accent"), brand("muted")
PALE, WHITE, BORDER = brand("bg"), brand("paper"), brand("line")
UNIT = r"(?:kPa|Pa|m²|cm²|mm²|m³|cm³|kg|cm|mm|N|J|Ω|V|W|A)"
NUMBER = r"\d+(?:\.\d+)?"
QUANTITY = rf"{NUMBER}\s*{UNIT}"
WRAP_TOKEN = re.compile(
    rf"{QUANTITY}\s*[×*/÷]\s*{QUANTITY}\s*=\s*{QUANTITY}"
    rf"|[A-Za-zρΔ][A-Za-zρΔ0-9_]*\s*=\s*[A-Za-zρΔ0-9().]+(?:\s*[*/×÷+·^-]\s*[A-Za-zρΔ0-9().²³]+)*(?:\s*{UNIT})?"
    rf"|[A-Za-zρΔ0-9]+/[A-Za-zρΔ0-9]+|{QUANTITY}|."
)


def wrap(draw, text, font, width):
    lines = []
    for paragraph in text.splitlines():
        line = ""
        for token in WRAP_TOKEN.findall(paragraph):
            if line and draw.textlength(line + token, font=font) > width:
                if token in "，。！？”、；：）" and draw.textlength(line + token, font=font) <= width + font.size:
                    line += token
                    continue
                lines.append(line.rstrip())
                line = ""
            line += token if line else token.lstrip()
        if line:
            lines.append(line)
    return lines


def draw_lines(draw, lines, xy, font, gap, fill):
    x, y = xy
    for line in lines:
        draw.text((x, y), line, font=font, fill=fill, anchor="lt")
        y += gap
    return y


MARGIN = 104
PAGE_WIDTH = 1600
SERIF = "/System/Library/Fonts/Supplemental/Songti.ttc"
NUMERAL = "/System/Library/Fonts/Supplemental/Baskerville.ttc"
BRONZE = brand("bronze")
REVIEW_LABELS = {"核心知识", "题型归类", "做题方法", "录音例题", "课堂例题", "易错提醒", "课后自测"}


def masthead(draw, label, lesson):
    font = ImageFont.truetype(FONT, 42)
    brand_label = "张老师物理  ·  " + label
    draw.text((MARGIN, 80), brand_label, font=font, fill=INK, anchor="lt")
    lesson_width = PAGE_WIDTH - 2 * MARGIN - draw.textlength(brand_label, font=font) - 32
    size = min(42, max(22, int(42 * lesson_width / max(1, draw.textlength(lesson, font=font)))))
    draw.text((PAGE_WIDTH - MARGIN, 80), lesson, font=ImageFont.truetype(FONT, size), fill=INK, anchor="rt")
    draw.line((MARGIN, 153, PAGE_WIDTH - MARGIN, 153), fill=GREEN, width=3)
    draw.polygon([(MARGIN, 143), (MARGIN + 106, 143), (MARGIN + 125, 155), (MARGIN, 155)], fill=GREEN)


def chapter(draw, y, number, label, heading):
    draw.text((MARGIN, y), number, font=ImageFont.truetype(NUMERAL, 63), fill=GREEN, anchor="lt")
    draw.text((MARGIN + 155, y), label, font=heading, fill=INK, anchor="lt")


def sheet(data):
    if not 2 <= len(data.get("sections", [])) <= 7:
        raise ValueError("课堂复习图需要两到七个按内容生成的版块")
    if any(section.get("label") not in REVIEW_LABELS for section in data["sections"]):
        raise ValueError("课堂复习图包含不支持的版块")

    right = PAGE_WIDTH - MARGIN
    content = MARGIN + 155
    body = ImageFont.truetype(FONT, 55)
    heading = ImageFont.truetype(SERIF, 70)
    title = ImageFont.truetype(SERIF, 116)
    marker = ImageFont.truetype(NUMERAL, 52)
    scratch = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    title_rows = wrap(scratch, data["title"], title, right - MARGIN)
    y = 200 + len(title_rows) * 144 + 18
    blocks = []
    for index, section in enumerate(data["sections"], 1):
        has_markers = section.get("numbered", False) or len(section["items"]) > 1
        inset = 66 if has_markers else 0
        items = [(str(i + 1) if section.get("numbered") else "·", wrap(scratch, item, body, right - content - inset - 10))
                 for i, item in enumerate(section["items"])]
        intro = wrap(scratch, "题设  " + section["intro"], body, right - content - 10) if section.get("intro") else []
        if not items or any(not rows for _, rows in items):
            continue
        height = 119 + (len(intro) * 77 + 23 if intro else 0) + sum(len(rows) * 77 + 23 for _, rows in items)
        blocks.append((index, section["label"], y, intro, items, inset, height))
        y += height + 27

    height = y + 88
    if height > 14000:
        raise ValueError("课堂内容超过单张复习图承载上限，请分成两张课次复习图")
    image = Image.new("RGB", (PAGE_WIDTH, height), PALE)
    draw = ImageDraw.Draw(image)
    masthead(draw, "课堂反馈", data["lesson"])
    draw_lines(draw, title_rows, (MARGIN, 200), title, 144, INK)
    for index, label, y, intro, items, inset, block_height in blocks:
        if label == "录音例题":
            draw.rectangle((MARGIN, y, right, y + block_height), fill=WHITE)
        draw.line((MARGIN, y, right, y), fill=GREEN if index == 1 else BORDER, width=3)
        chapter(draw, y + 28, f"{index:02}", label, heading)
        cursor = y + 119
        if intro:
            cursor = draw_lines(draw, intro, (content, cursor), body, 77, MUTED) + 23
        for mark, rows in items:
            if inset:
                draw.text((content, cursor + 2), mark, font=marker, fill=BRONZE, anchor="lt")
            cursor = draw_lines(draw, rows, (content + inset, cursor), body, 77, INK) + 23
    draw.line((MARGIN, height - 66, right, height - 66), fill=GREEN, width=3)
    return image


def promo(data):
    right = PAGE_WIDTH - MARGIN
    scratch = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    topic_font = ImageFont.truetype(FONT, 51)
    headline = ImageFont.truetype(SERIF, 100)
    heading = ImageFont.truetype(SERIF, 65)
    body = ImageFont.truetype(FONT, 55)
    topic = wrap(scratch, data["title"], topic_font, right - MARGIN)
    hook = wrap(scratch, data["hook"], headline, right - MARGIN)
    headline_y = 221 + 68 * len(topic)
    y = headline_y + 122 * len(hook) + 44
    blocks = []
    groups = [("本课讲解", data.get("knowledge") or [])]
    if data.get("methods"):
        groups.append(("做题方法", data["methods"]))
    groups.append(("回家可以问", [data["parent"]]))
    for label, parts in groups:
        rows = [wrap(scratch, item, body, right - MARGIN - 155) for item in parts]
        blocks.append((y, label, rows))
        y += 123 + sum(76 * len(row) + 17 for row in rows)
    image = Image.new("RGB", (PAGE_WIDTH, max(1040, y + 80)), PALE)
    draw = ImageDraw.Draw(image)
    masthead(draw, "课后回顾", data["lesson"])
    draw_lines(draw, topic, (MARGIN, 205), topic_font, 68, GREEN)
    draw_lines(draw, hook, (MARGIN, headline_y), headline, 122, INK)
    for i, (top, label, rows) in enumerate(blocks, 1):
        draw.line((MARGIN, top, right, top), fill=BORDER, width=3)
        chapter(draw, top + 25, f"{i:02}", label, heading)
        cursor = top + 111
        for group in rows:
            cursor = draw_lines(draw, group, (MARGIN + 155, cursor), body, 76, INK) + 17
    draw.line((MARGIN, image.height - 58, right, image.height - 58), fill=GREEN, width=3)
    return image


def teaching_video_card(data):
    width, height = data["width"], data["height"]
    image = Image.new("RGB", (width, height), PALE)
    draw = ImageDraw.Draw(image)
    left = round(width * .085)
    right = width - left
    accent_y = round(height * .20)
    line_height = max(2, round(height * .004))
    brand = ImageFont.truetype(FONT, max(10, round(min(width * .034, height * .05))))
    draw.text((left, round(height * .095)), "张老师物理  ·  " + data["label"], font=brand, fill=MUTED, anchor="lt")
    draw.line((left, accent_y, right, accent_y), fill=GREEN, width=line_height)
    draw.polygon([(left, accent_y - 3 * line_height), (left + round(width * .09), accent_y - 3 * line_height),
                  (left + round(width * .106), accent_y), (left, accent_y)], fill=GREEN)
    y = round(height * .285)
    topic = data.get("topic")
    if topic:
        draw_lines(draw, wrap(draw, topic, brand, right - left), (left, y), brand, round(height * .062), GREEN)
        y += round(height * .105)
    size = max(10, round(min(width * .087, height * .123)))
    while size > 9:
        font = ImageFont.truetype(SERIF, size)
        rows = wrap(draw, data["title"], font, right - left)
        gap = round(size * 1.31)
        if y + len(rows) * gap <= height * .87:
            break
        size -= 1
    draw_lines(draw, rows, (left, y), font, gap, INK)
    draw.line((left, round(height * .91), right, round(height * .91)), fill=BORDER, width=line_height)
    return image


def title_card(data):
    width, height = data["width"], data["height"]
    overlay = data["kind"] == "video-overlay"
    image = Image.new("RGBA", (width, height), (0, 0, 0, 0)) if overlay else Image.new("RGB", (width, height), INK)
    draw = ImageDraw.Draw(image)
    left = int(.085 * width)
    size = max(10, int(min(width * .077, height * .133)))
    while size > 9:
        font = ImageFont.truetype(FONT, size)
        rows = wrap(draw, data["title"], font, width - 2 * left)
        if len(rows) * size * 1.35 <= height * .63:
            break
        size -= 1
    marker = ImageFont.truetype(FONT, max(9, int(min(width * .032, height * .055))))
    if overlay:
        draw.rounded_rectangle((int(.06 * width), int(.16 * height), int(.94 * width), int(.88 * height)),
                               radius=int(.025 * height), fill=(16, 45, 37, 220))
        draw.text((left, int(.235 * height)), data["label"], fill="#B0EBD4", font=marker, anchor="lt")
    else:
        draw.rectangle((left, int(.15 * height), left + int(.075 * width), int(.162 * height)), fill="#69D3AD")
        draw.text((left, int(.20 * height)), data["label"], fill="#B0EBD4", font=marker, anchor="lt")
    y = max(int(height * .37), math.floor((height - len(rows)*size*1.35)*.5))
    draw_lines(draw, rows, (left, y), font, int(size * 1.35), WHITE)
    return image


def main():
    request = json.load(sys.stdin)
    render = {"video": teaching_video_card, "video-overlay": title_card, "promo": promo, "sheet": sheet}
    image = render[request["kind"]](request)
    image.save(sys.argv[1], format="PNG", optimize=True)
    with Image.open(sys.argv[1]) as check:
        check.load()
        if check.format != "PNG" or check.size != image.size:
            raise ValueError("PNG 写入验证失败")


if __name__ == "__main__":
    main()
