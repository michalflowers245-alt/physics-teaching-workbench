import io
import json
import os
import sys
import zipfile

from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor


def lesson_time(seconds):
    hours, remainder = divmod(int(seconds), 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


def set_style(document, name, size, color, *, bold=False, before=0, after=0):
    style = document.styles[name]
    style.font.name = "Arial Unicode MS"
    style.font.size = Pt(size)
    style.font.color.rgb = RGBColor.from_string(color)
    style.font.bold = bold
    style.font.italic = False
    run_properties = style.element.get_or_add_rPr()
    fonts = run_properties.rFonts
    fonts.attrib.clear()
    for attribute in ("ascii", "hAnsi", "eastAsia", "cs"):
        fonts.set(qn(f"w:{attribute}"), "Arial Unicode MS")
    language = run_properties.find(qn("w:lang"))
    if language is None:
        language = OxmlElement("w:lang")
        run_properties.append(language)
    language.set(qn("w:eastAsia"), "zh-CN")
    paragraph_properties = style.element.get_or_add_pPr()
    border = paragraph_properties.find(qn("w:pBdr"))
    if border is not None:
        paragraph_properties.remove(border)
    layout = style.paragraph_format
    layout.space_before = Pt(before)
    layout.space_after = Pt(after)
    layout.line_spacing = 1.18
    layout.keep_together = True
    return style


def numbered(document, entries):
    for index, entry in enumerate(entries, start=1):
        paragraph = document.add_paragraph()
        paragraph.paragraph_format.left_indent = Inches(0.24)
        paragraph.paragraph_format.first_line_indent = Inches(-0.24)
        paragraph.add_run(f"{index}. ").bold = True
        paragraph.add_run(entry)


def build_report(data):
    facts = data["facts"]
    document = Document()
    page = document.sections[0]
    page.page_width = Inches(8.5)
    page.page_height = Inches(11)
    page.left_margin = page.right_margin = Inches(0.8)
    page.top_margin = page.bottom_margin = Inches(0.65)

    set_style(document, "Normal", 11, "24324B", after=4)
    set_style(document, "Title", 23, "000000", bold=True, after=5)
    set_style(document, "Subtitle", 11, "4A5871", after=13)
    set_style(document, "Heading 1", 13, "243F67", bold=True, before=9, after=4)
    set_style(document, "Caption", 10, "4A5871", after=4)
    for name in ("Title", "Subtitle", "Heading 1"):
        document.styles[name].paragraph_format.keep_with_next = True

    title = f'{data["topic"]} 教育教培反馈'
    document.core_properties.title = title
    document.core_properties.author = "张老师物理工作台"
    document.core_properties.subject = "课堂学习反馈"
    document.add_paragraph(title, "Title")
    date = data["date"]
    if data["dateSource"] == "生成日期":
        date += "（生成日期，课次日期待确认）"
    document.add_paragraph(f'{data["grade"]}   ·   {date}', "Subtitle")
    if facts.get("hook"):
        document.add_paragraph(facts["hook"])

    document.add_heading("本课知识点", level=1)
    numbered(document, facts["knowledge"])

    methods = facts.get("methods") or []
    if facts.get("topicTypes"):
        document.add_heading("本课题型", level=1)
        numbered(document, facts["topicTypes"])

    if methods:
        document.add_heading("做题方法", level=1)
        numbered(document, methods)

    if facts.get("condition") and facts.get("steps"):
        document.add_heading("录音中可核对的例题与做题步骤", level=1)
        document.add_paragraph(facts["condition"])
        numbered(document, facts["steps"])
    elif facts.get("pendingReview"):
        document.add_heading("原题核对状态", level=1)
        document.add_paragraph("录音未能完整还原原题条件、步骤和结论；复习内容与新编自测仍可先使用，原题须对照试卷或讲义补核。")

    mistakes = list(dict.fromkeys([*(facts.get("mistakes") or []), *([facts["mistake"]] if facts.get("mistake") else [])]))
    if mistakes:
        document.add_heading("易错点", level=1)
        numbered(document, mistakes)

    if facts.get("reviewQuestions"):
        document.add_heading("课后自测（根据本课知识新编）", level=1)
        numbered(document, facts["reviewQuestions"])
        if facts.get("answerKey"):
            document.add_heading("教师核对要点", level=1)
            numbered(document, facts["answerKey"])

    document.add_heading("回家怎么复习", level=1)
    if facts.get("parent"):
        document.add_paragraph(f'请孩子不看答案，先用自己的话回答“{facts["parent"]}”')
    document.add_paragraph("请听孩子说清判断依据、公式中各量代表什么，再对照复习图订正；课堂没有出现的具体题目条件不从转写推测。")

    document.add_heading("课堂依据与待核事项", level=1)
    if data.get("factSource"):
        document.add_paragraph(data["factSource"] + "。", "Caption")
    ranges = data.get("ranges") or []
    if ranges:
        times = "、".join(f'{lesson_time(piece["start"])}–{lesson_time(piece["end"])}' for piece in ranges)
        document.add_paragraph("录音讲解位置 " + times, "Caption")
    if facts.get("pendingReview"):
        document.add_paragraph("待核事项：" + "；".join(facts["pendingReview"]), "Caption")
    document.add_paragraph("学生独立作答及掌握程度待教师核验。原卷题号和课堂作业待核对。", "Caption")
    return document


def save_report(document, destination):
    # Stable package bytes allow an interrupted save to recover the same version.
    buffer = io.BytesIO()
    document.save(buffer)
    with zipfile.ZipFile(buffer) as source, open(destination, "xb", opener=private_file) as output:
        with zipfile.ZipFile(output, "w") as target:
            for entry in source.infolist():
                content = source.read(entry)
                entry.date_time = (1980, 1, 1, 0, 0, 0)
                target.writestr(entry, content)
    with zipfile.ZipFile(destination) as result:
        required = {"[Content_Types].xml", "_rels/.rels", "word/document.xml"}
        if not required.issubset(result.namelist()) or result.testzip():
            raise ValueError("Word 文件结构校验失败")


def private_file(path, flags):
    return os.open(path, flags, 0o600)


if __name__ == "__main__":
    save_report(build_report(json.load(sys.stdin)), sys.argv[1])
