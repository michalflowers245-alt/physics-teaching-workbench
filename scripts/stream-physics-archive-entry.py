#!/usr/bin/env python3
"""Stream one already-indexed ZIP entry to stdout without extracting paths."""

from __future__ import annotations

import shutil
import sys
import zipfile


def display_name(info: zipfile.ZipInfo) -> str:
    if info.flag_bits & 0x800:
        return info.filename
    try:
        raw = info.filename.encode("cp437")
    except UnicodeEncodeError:
        return info.filename
    for encoding in ("gb18030", "gbk"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            pass
    return info.filename


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit(2)
    archive, requested = sys.argv[1:]
    with zipfile.ZipFile(archive) as bundle:
        info = next((item for item in bundle.infolist() if not item.is_dir() and display_name(item).replace("\\", "/") == requested.replace("\\", "/")), None)
        if info is None:
            raise SystemExit(3)
        with bundle.open(info) as source:
            shutil.copyfileobj(source, sys.stdout.buffer, length=1024 * 1024)


if __name__ == "__main__":
    main()
