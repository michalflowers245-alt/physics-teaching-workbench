#!/usr/bin/env python3
"""Read-only geometry helper for the local physics-exam page-asset backfill.

The importer that created the first batch intentionally retained only pypdf's
plain text.  This helper never changes a source PDF.  It returns enough text
layout information to make a conservative, auditable question-region crop.

It also provides a small local JPEG crop subcommand.  The Node backfill owns
all writes to the immutable exam asset store and to EngineStore.
"""

from __future__ import annotations

import json
import math
import re
import sys
from pathlib import Path


ANSWER_MARK_RE = re.compile(r"参考答案与试题解析|参考答案及解析|答案与解析|参考答案|试题解析")


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def printable(value: str) -> str:
    """Keep one visual text run while discarding control-only visitor calls."""
    return re.sub(r"[\r\n\t]+", " ", value or "").strip()


def transformed_origin(cm: list[float], tm: list[float]) -> tuple[float, float]:
    """Apply text matrix then current transformation matrix (PDF affine form)."""
    x = tm[4] * cm[0] + tm[5] * cm[2] + cm[4]
    y = tm[4] * cm[1] + tm[5] * cm[3] + cm[5]
    return x, y


def page_blocks(page) -> dict:
    width = float(page.mediabox.width or 1)
    height = float(page.mediabox.height or 1)
    tokens: list[dict] = []

    def visitor(text, cm, tm, _font, font_size):
        value = printable(text)
        if not value:
            return
        try:
            x, y = transformed_origin(cm, tm)
            size = max(4.0, min(72.0, abs(float(font_size or 10))))
        except (IndexError, TypeError, ValueError):
            return
        # pypdf does not expose a reliable glyph-width callback for every
        # embedded Chinese font.  This intentionally generous approximation
        # is used only to group nearby chunks into visual lines; crops are
        # later bounded by the next confirmed question heading.
        glyphs = max(1, len(re.sub(r"\s+", "", value)))
        estimated_width = max(size * 0.55, glyphs * size * 0.62)
        tokens.append({"text": value, "x": x, "y": y, "size": size, "width": estimated_width})

    try:
        page.extract_text(visitor_text=visitor)
    except Exception:
        # A page image can still be useful even if its text layer is broken.
        return {"width": width, "height": height, "blocks": [], "text": ""}

    tokens.sort(key=lambda item: (-item["y"], item["x"]))
    rows: list[dict] = []
    for token in tokens:
        tolerance = max(2.0, token["size"] * 0.42)
        row = next((candidate for candidate in rows if abs(candidate["y"] - token["y"]) <= tolerance), None)
        if row is None:
            row = {"y": token["y"], "tokens": []}
            rows.append(row)
        row["tokens"].append(token)

    blocks: list[dict] = []
    for row in rows:
        ordered = sorted(row["tokens"], key=lambda item: item["x"])
        # Split only at a very large horizontal gap.  This preserves headings
        # that pypdf emits as many small chunks while still separating columns.
        groups: list[list[dict]] = [[]]
        previous_right = None
        for token in ordered:
            if previous_right is not None and token["x"] - previous_right > width * 0.16:
                groups.append([])
            groups[-1].append(token)
            previous_right = max(previous_right or token["x"], token["x"] + token["width"])
        for group in groups:
            if not group:
                continue
            text = "".join(item["text"] for item in group).strip()
            if not text:
                continue
            left = clamp(min(item["x"] for item in group), 0.0, width)
            right = clamp(max(item["x"] + item["width"] for item in group), left + 1.0, width)
            baseline = sum(item["y"] for item in group) / len(group)
            size = max(item["size"] for item in group)
            # Convert to the browser's normalized top-left coordinate system.
            top = clamp(1.0 - (baseline + size * 0.9) / height, 0.0, 1.0)
            bottom = clamp(1.0 - (baseline - size * 0.35) / height, top + 0.001, 1.0)
            blocks.append({
                "text": text,
                "bbox": [
                    round(left / width, 6),
                    round(top, 6),
                    round((right - left) / width, 6),
                    round(bottom - top, 6),
                ],
            })

    blocks.sort(key=lambda item: (item["bbox"][1], item["bbox"][0]))
    answer_marker = next((item["bbox"] for item in blocks if ANSWER_MARK_RE.search(item["text"])), None)
    return {
        "width": width,
        "height": height,
        "blocks": blocks,
        "text": "\n".join(item["text"] for item in blocks),
        "answerMarkerBBox": answer_marker,
    }


def geometry(pdf_path: Path) -> None:
    from pypdf import PdfReader
    import pdfplumber

    reader = PdfReader(str(pdf_path), strict=False)
    page_count = len(reader.pages)
    answer_start_page = None
    plain_pages: list[str] = []
    for index, page in enumerate(reader.pages, 1):
        try:
            text = page.extract_text() or ""
        except Exception:
            text = ""
        plain_pages.append(text)
        if answer_start_page is None and ANSWER_MARK_RE.search(text):
            answer_start_page = index

    # Match the existing extraction convention: a mixed question/answer page
    # remains available, while later pure answer pages are deliberately not
    # returned to the caller.
    exam_page_count = answer_start_page or page_count
    pages = []
    with pdfplumber.open(str(pdf_path)) as visual_pdf:
        for index in range(1, exam_page_count + 1):
            layout = page_blocks(reader.pages[index - 1])
            visual_page = visual_pdf.pages[index - 1]
            # Raster figures are often placed on the following page with no
            # text at all. Preserve their actual PDF geometry so the caller
            # can prove ownership of an otherwise invisible continuation.
            image_boxes = []
            for item in visual_page.images:
                left = float(item["x0"]) / visual_page.width
                top = float(item["top"]) / visual_page.height
                width = float(item["x1"] - item["x0"]) / visual_page.width
                height = float(item["bottom"] - item["top"]) / visual_page.height
                if 0 <= left < 1 and 0 <= top < 1 and width > 0 and height > 0 and left + width <= 1.002 and top + height <= 1.002:
                    image_boxes.append([round(left, 6), round(top, 6), round(width, 6), round(height, 6)])
            pages.append({"pageNo": index, **layout, "imageBBoxes": image_boxes})
    payload = {
        "pageCount": page_count,
        "examPageCount": exam_page_count,
        "answerStartPage": answer_start_page,
        "pages": pages,
    }
    json.dump(payload, sys.stdout, ensure_ascii=False, separators=(",", ":"))


def crop_jpeg(input_path: Path, output_path: Path, x: int, y: int, width: int, height: int) -> None:
    from PIL import Image

    with Image.open(input_path) as image:
        source = image.convert("RGB")
        left = clamp(x, 0, source.width - 1)
        top = clamp(y, 0, source.height - 1)
        right = clamp(x + width, left + 1, source.width)
        bottom = clamp(y + height, top + 1, source.height)
        if right <= left or bottom <= top:
            raise ValueError("crop outside image bounds")
        cropped = source.crop((int(left), int(top), int(right), int(bottom)))
        cropped.save(output_path, "JPEG", quality=90, optimize=True)


def main() -> None:
    if len(sys.argv) == 2:
        geometry(Path(sys.argv[1]).resolve())
        return
    if len(sys.argv) == 8 and sys.argv[1] == "crop":
        _, _, source, target, x, y, width, height = sys.argv
        crop_jpeg(Path(source), Path(target), int(x), int(y), int(width), int(height))
        return
    raise SystemExit("usage: extract-physics-page-geometry.py PDF | crop INPUT.jpg OUTPUT.jpg X Y WIDTH HEIGHT")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
