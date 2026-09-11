#!/usr/bin/env python3
"""make_xlsx.py — writes verifications.xlsx from the rows build.cjs hands it.

Usage: python3 tools/make_xlsx.py <input.json> <output.xlsx>

The input is {"columns": [...], "rows": [[...], ...]}, the same rows and
columns as verifications.csv. Needs openpyxl (3.1.5 produced the published
file).
"""
import datetime
import io
import json
import re
import sys
import zipfile

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill

# Fixed, so a rebuild from the same data keeps the published creation time.
DOC_TIMESTAMP = datetime.datetime(2026, 9, 10, 20, 37, 53)
MAX_WIDTH = 48

# openpyxl stamps the "modified" property and every zip entry time with the wall
# clock at save, so two builds of identical rows would never be byte-identical.
# After saving, both are rewritten with the values the published workbook
# carries (2026-09-10), which makes a rebuild from the same data reproduce the
# published file byte for byte. An entry not listed here is refused rather than
# given a guessed time, so an openpyxl that writes a different set of parts
# fails the build loudly instead of silently changing the file.
DOC_MODIFIED = "2026-09-10T20:37:53Z"
ENTRY_TIMES = {
    "docProps/app.xml": (2026, 9, 10, 16, 37, 52),
    "docProps/core.xml": (2026, 9, 10, 16, 37, 52),
    "xl/theme/theme1.xml": (2026, 9, 10, 16, 37, 52),
    "xl/worksheets/sheet1.xml": (2026, 9, 10, 16, 37, 52),
    "xl/styles.xml": (2026, 9, 10, 16, 37, 54),
    "_rels/.rels": (2026, 9, 10, 16, 37, 54),
    "xl/workbook.xml": (2026, 9, 10, 16, 37, 54),
    "xl/_rels/workbook.xml.rels": (2026, 9, 10, 16, 37, 54),
    "[Content_Types].xml": (2026, 9, 10, 16, 37, 54),
}
MODIFIED_RE = re.compile(rb"(<dcterms:modified[^>]*>)[^<]*(</dcterms:modified>)")


def restamp(raw):
    """Rewrite the saved workbook with the fixed times; content is untouched."""
    src = zipfile.ZipFile(io.BytesIO(raw))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as dst:
        for info in src.infolist():
            if info.filename not in ENTRY_TIMES:
                raise SystemExit(f"make_xlsx.py: no fixed time declared for workbook part {info.filename}")
            data = src.read(info.filename)
            if info.filename == "docProps/core.xml":
                data, n = MODIFIED_RE.subn(rb"\g<1>" + DOC_MODIFIED.encode() + rb"\g<2>", data)
                if n != 1:
                    raise SystemExit("make_xlsx.py: docProps/core.xml has no single modified stamp to fix")
            fixed = zipfile.ZipInfo(info.filename, date_time=ENTRY_TIMES[info.filename])
            fixed.compress_type = info.compress_type
            fixed.external_attr = info.external_attr
            fixed.create_system = info.create_system
            dst.writestr(fixed, data)
    return out.getvalue()


def main(src, dest):
    with open(src, encoding="utf-8") as fh:
        data = json.load(fh)
    columns, rows = data["columns"], data["rows"]
    headers = [c.replace("_", " ").title() for c in columns]

    wb = Workbook()
    ws = wb.active
    ws.title = "Verifications"
    ws.append(headers)
    for r in rows:
        # A missing value is an empty cell with an empty string, the same as the
        # CSV, rather than no cell at all.
        ws.append(["" if v is None else v for v in r])

    head_font = Font(bold=True, color="E2D243")
    head_fill = PatternFill("solid", fgColor="0A0724")
    for cell in ws[1]:
        cell.font = head_font
        cell.fill = head_fill
        cell.alignment = Alignment(vertical="center")

    # Width fits the longest value in the column, header included, capped so a
    # list of URLs does not produce a column wider than the screen.
    for i, h in enumerate(headers):
        longest = max([len(h)] + [len("" if r[i] is None else str(r[i])) for r in rows])
        ws.column_dimensions[ws.cell(row=1, column=i + 1).column_letter].width = min(MAX_WIDTH, longest + 2)

    ws.freeze_panes = "A2"
    ws.auto_filter.ref = ws.dimensions
    wb.properties.created = DOC_TIMESTAMP
    buf = io.BytesIO()
    wb.save(buf)
    with open(dest, "wb") as fh:
        fh.write(restamp(buf.getvalue()))
    print(f"verifications.xlsx   {len(rows)} rows x {len(columns)} columns (openpyxl)")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: make_xlsx.py <input.json> <output.xlsx>")
    main(sys.argv[1], sys.argv[2])
