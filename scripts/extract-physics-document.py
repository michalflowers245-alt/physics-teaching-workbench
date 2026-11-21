#!/usr/bin/env python3
"""Read-only text and question extraction for the local physics corpus.

The helper deliberately never writes beside a source document.  It emits one
JSON object to stdout so the Node importer can own classification, provenance,
deduplication and database writes.
"""

from __future__ import annotations

import html
import json
import re
import subprocess
import sys
from pathlib import Path


HEADER_RE = re.compile(r"^\s*第\s*\d+\s*页\s*[（(]共\s*\d+\s*页[）)]\s*$")
# A full-width question delimiter can legitimately precede a year, e.g.
# "7．2009年…". An ASCII decimal point followed by a digit is not such a
# delimiter. PDF text may insert a space inside a decimal, so also reject
# fractional numbers followed by units, arithmetic or end punctuation.
QUESTION_RE = re.compile(
    r"^\s*(?:[（(]多选[）)]\s*)?([1-9]\d{0,2})\s*"
    r"(?:[．、]|\.(?!\d)(?![ \t]*\d+(?:[ \t]+\d+)*[ \t]*(?:[A-Za-zµμΩ℃°×·%％，,。；;）)]|$)))\s*(.*)$"
)
SECTION_RE = re.compile(r"^\s*[一二三四五六七八九十]+\s*[、.．]\s*(.+)$")
SECTION_TITLE_RE = re.compile(r"^(?:单项选择|多项选择|不定项选择|选择|填空|实验与探究|实验探究|实验|科学探究|探究|计算|综合|解答|作图|简答|判断|连线)题")
PAPER_TITLE_RE = re.compile(r"^\s*(?:19|20)\d{2}\s*年[^\n]{0,60}(?:中考|学业水平考试)[^\n]{0,20}物理(?:试卷|试题)(?:[（(][^）)]*[）)])?\s*$")
ANSWER_MARK_RE = re.compile(r"参考答案与试题解析|参考答案及解析|答案与解析|参考答案|试题解析")


def clean_text(value: str) -> str:
    value = value.replace("\x00", " ").replace("\r", "\n")
    value = re.sub(r"[ \t\u00a0]+", " ", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value.strip()


def read_pdf(path: Path) -> tuple[list[str], int]:
    from pypdf import PdfReader

    reader = PdfReader(str(path), strict=False)
    pages = [clean_text(page.extract_text() or "") for page in reader.pages]
    return pages, len(reader.pages)


def read_docx(path: Path) -> tuple[list[str], int]:
    from docx import Document

    document = Document(str(path))
    chunks: list[str] = []
    for paragraph in document.paragraphs:
        if paragraph.text.strip():
            chunks.append(paragraph.text)
    for table in document.tables:
        for row in table.rows:
            cells = [cell.text.strip() for cell in row.cells]
            if any(cells):
                chunks.append("\t".join(cells))
    return [clean_text("\n".join(chunks))], 1


def read_legacy_doc(path: Path) -> tuple[list[str], int]:
    completed = subprocess.run(
        ["/usr/bin/textutil", "-convert", "txt", "-stdout", str(path)],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=90,
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.decode("utf-8", "replace")[:500] or "textutil failed")
    return [clean_text(completed.stdout.decode("utf-8", "replace"))], 1


def find_exam_cut(pages: list[str]) -> tuple[list[tuple[int, str]], str, int]:
    exam_pages: list[tuple[int, str]] = []
    answer_parts: list[str] = []
    in_answer = False
    cut_page = len(pages)
    for page_no, raw in enumerate(pages, 1):
        match = ANSWER_MARK_RE.search(raw)
        if not in_answer and match:
            before = raw[: match.start()].strip()
            after = raw[match.end() :].strip()
            if before:
                exam_pages.append((page_no, before))
            if after:
                answer_parts.append(after)
            in_answer = True
            cut_page = page_no
        elif in_answer:
            answer_parts.append(raw)
        else:
            exam_pages.append((page_no, raw))
    return exam_pages, clean_text("\n".join(answer_parts)), cut_page


def section_type(line: str, current: str) -> str:
    match = SECTION_RE.match(line)
    if not match:
        return current
    title = match.group(1)
    if "多项选择" in title:
        return "多项选择题"
    if "选择" in title:
        return "选择题"
    if "填空" in title:
        return "填空题"
    if "实验" in title or "探究" in title:
        return "实验探究题"
    if "计算" in title:
        return "计算题"
    if "综合" in title:
        return "综合题"
    return current


def is_section_heading(line: str) -> bool:
    match = SECTION_RE.match(line)
    return bool(match and SECTION_TITLE_RE.match(match.group(1)))


def split_numbered_blocks(text: str) -> dict[str, str]:
    result: dict[str, list[str]] = {}
    current: str | None = None
    for raw_line in text.splitlines():
        line = HEADER_RE.sub("", raw_line).strip()
        if not line:
            continue
        if is_section_heading(line) or PAPER_TITLE_RE.match(line):
            current = None
            continue
        match = QUESTION_RE.match(line)
        if match:
            current = str(int(match.group(1)))
            result.setdefault(current, []).append(match.group(2))
        elif current:
            result[current].append(line)
    return {key: clean_text("\n".join(value)) for key, value in result.items()}


def extract_answer(block: str) -> str:
    patterns = (
        r"故选\s*[：:]?\s*([A-D]{1,4})",
        r"故答案为\s*[：:]?\s*([^。\n]{1,180})",
        r"答\s*[：:]\s*([^。\n]{1,180})",
    )
    for pattern in patterns:
        match = re.search(pattern, block, re.I)
        if match:
            return re.sub(r"\s+", " ", match.group(1)).strip(" ；;。")
    return ""


def extract_options(stem: str) -> list[dict[str, str]]:
    flat = re.sub(r"\s+", " ", stem)
    markers = list(re.finditer(r"(?<![A-Za-z])([A-D])\s*[.．、]", flat))
    if len(markers) < 2:
        return []
    options: list[dict[str, str]] = []
    for index, marker in enumerate(markers):
        end = markers[index + 1].start() if index + 1 < len(markers) else len(flat)
        value = flat[marker.end() : end].strip()
        if value:
            options.append({"label": marker.group(1), "text": value[:1000]})
    return options if len(options) >= 2 else []


def parse_questions(exam_pages: list[tuple[int, str]], answer_text: str) -> list[dict]:
    answers = split_numbered_blocks(answer_text)
    questions: list[dict] = []
    current: dict | None = None
    current_type = "待人工确认"

    def finish() -> None:
        nonlocal current
        if not current:
            return
        stem = clean_text("\n".join(current.pop("chunks")))
        if len(stem) >= 8:
            # A later subquestion's allocation is not the total question
            # score. Only an explicit allocation in the question heading is
            # imported as the total; otherwise it remains unknown.
            score_match = re.match(r"[（(]\s*(\d+(?:\.\d+)?)\s*分\s*[）)]", stem)
            current["stem"] = stem
            current["originalExtraction"] = {
                "text": stem,
                "excludedSectionHeadings": current.pop("excludedSectionHeadings", []),
                "method": "pypdf-text-boundary-v2",
            }
            current["score"] = float(score_match.group(1)) if score_match else None
            current["options"] = extract_options(stem)
            current["answer"] = extract_answer(answers.get(current["questionNo"], ""))
            current["imageReviewRequired"] = bool(re.search(r"如图|图中|下图|图甲|图乙|如表|表格|电路图", stem))
            questions.append(current)
        current = None

    for page_no, page_text in exam_pages:
        visible_lines = [HEADER_RE.sub("", value).strip() for value in page_text.splitlines()]
        if current and not any(visible_lines) and current["sourceSpans"][-1]["pageNo"] != page_no:
            # A page with no extractable text may be a circuit or table.
            # Preserve it for visual review instead of dropping a whole page
            # from a question spanning the preceding and following pages.
            current["sourceSpans"].append({"pageNo": page_no, "bbox": None, "kind": "question", "requiresVisualReview": True})
        for raw_line in page_text.splitlines():
            line = HEADER_RE.sub("", raw_line).strip()
            if not line:
                continue
            if PAPER_TITLE_RE.match(line):
                # Answer appendices often repeat the paper title on a new
                # page before the answer marker. It is not a continuation of
                # the last question and must not add a spurious source page.
                continue
            if is_section_heading(line):
                if current:
                    current.setdefault("excludedSectionHeadings", []).append({"pageNo": page_no, "text": line})
                finish()
                current_type = section_type(line, current_type)
                continue
            match = QUESTION_RE.match(line)
            if match:
                finish()
                current = {
                    "questionNo": str(int(match.group(1))),
                    "pageNo": page_no,
                    "type": "多项选择题" if "多选" in line else current_type,
                    "chunks": [match.group(2)],
                    "sourceSpans": [{"pageNo": page_no, "bbox": None, "kind": "question"}],
                }
            elif current:
                current["chunks"].append(line)
                if current["sourceSpans"][-1]["pageNo"] != page_no:
                    current["sourceSpans"].append({"pageNo": page_no, "bbox": None, "kind": "question"})
    finish()
    return questions


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: extract-physics-document.py FILE")
    path = Path(sys.argv[1])
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        pages, page_count = read_pdf(path)
    elif suffix == ".docx":
        pages, page_count = read_docx(path)
    elif suffix == ".doc":
        pages, page_count = read_legacy_doc(path)
    else:
        raise RuntimeError(f"unsupported extension: {suffix}")

    full_text = clean_text("\n\n".join(pages))
    exam_pages, answer_text, cut_page = find_exam_cut(pages)
    questions = parse_questions(exam_pages, answer_text)
    result = {
        "pageCount": page_count,
        "examPageCount": cut_page if answer_text else page_count,
        "text": full_text,
        "examText": clean_text("\n".join(text for _, text in exam_pages)),
        "hasAnswerSection": bool(answer_text),
        "questions": questions,
        "questionCountEstimate": len(questions),
    }
    json.dump(result, sys.stdout, ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # Keep stdout machine-readable for the importer.
        json.dump({"error": str(error)}, sys.stdout, ensure_ascii=False)
        raise SystemExit(1)
