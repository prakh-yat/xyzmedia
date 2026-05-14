#!/usr/bin/env python3
"""
Compare new.csv vs old.csv and emit a single 'changes.csv' containing:
  - Every item that exists in new.csv but not in old.csv  (ChangeType=NEW)
  - Every item that exists in both but has any column change (ChangeType=UPDATED)

Items are matched by the 'Code' column.

Notes on comparison:
  - Columns that exist on only one side (e.g. 'Status' in old, 'Sizing 1-3' in new)
    are ignored when checking for changes.
  - Category1..Category6 are compared as a SET, not positionally — the source
    data lists the same categories in different orders for the same Code, and
    treating that as a "change" would flag thousands of rows for no real reason.
    If categories are added/removed for a code, that is still flagged as a change
    under the synthetic field name 'Categories'.
  - Whitespace is stripped before comparing values.
  - When both sides of a cell parse as numbers, they are compared numerically.
    This avoids flagging '14' vs '14.00' as a change.
"""

import csv
import sys
from pathlib import Path

HERE = Path(__file__).parent
NEW_FILE = HERE / "new.csv"
OLD_FILE = HERE / "old.csv"
OUT_FILE = HERE / "changes.csv"

CATEGORY_COLS = [f"Category{i}" for i in range(1, 7)]


def read_csv(path: Path):
    """Return (fieldnames, {code: row}). Drops blank-named columns (new.csv has a leading empty col)."""
    with path.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        fieldnames = [c for c in (reader.fieldnames or []) if c and c.strip()]
        by_code: dict[str, dict] = {}
        for row in reader:
            clean = {k: (v or "") for k, v in row.items() if k and k.strip()}
            code = clean.get("Code", "").strip()
            if code:
                by_code[code] = clean
        return fieldnames, by_code


def category_set(row: dict) -> frozenset:
    return frozenset(row.get(c, "").strip() for c in CATEGORY_COLS if row.get(c, "").strip())


def values_equal(a: str, b: str) -> bool:
    """Compare two raw cell strings, treating numeric strings as numerically equal."""
    a, b = (a or "").strip(), (b or "").strip()
    if a == b:
        return True
    try:
        return float(a) == float(b)
    except ValueError:
        return False


def diff_row(new_row: dict, old_row: dict, common_cols: list[str]) -> list[str]:
    """Names of columns whose value changed between old and new."""
    changed = []
    for col in common_cols:
        if col in CATEGORY_COLS:
            continue
        if not values_equal(new_row.get(col, ""), old_row.get(col, "")):
            changed.append(col)
    if category_set(new_row) != category_set(old_row):
        changed.append("Categories")
    return changed


def main() -> int:
    if not NEW_FILE.exists() or not OLD_FILE.exists():
        print(f"Missing input file: need {NEW_FILE.name} and {OLD_FILE.name} next to this script.", file=sys.stderr)
        return 1

    new_cols, new_data = read_csv(NEW_FILE)
    old_cols, old_data = read_csv(OLD_FILE)

    common_cols = [c for c in new_cols if c in old_cols]

    new_codes = set(new_data) - set(old_data)
    common_codes = set(new_data) & set(old_data)
    dropped_codes = set(old_data) - set(new_data)

    updated: list[tuple[str, list[str]]] = []
    for code in common_codes:
        changes = diff_row(new_data[code], old_data[code], common_cols)
        if changes:
            updated.append((code, changes))

    out_cols = new_cols + ["ChangeType", "ChangedFields"]
    with OUT_FILE.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=out_cols, extrasaction="ignore")
        writer.writeheader()

        for code in sorted(new_codes):
            row = dict(new_data[code])
            row["ChangeType"] = "NEW"
            row["ChangedFields"] = ""
            writer.writerow(row)

        for code, changes in sorted(updated):
            row = dict(new_data[code])
            row["ChangeType"] = "UPDATED"
            row["ChangedFields"] = "; ".join(changes)
            writer.writerow(row)

    print(f"new.csv rows:       {len(new_data)}")
    print(f"old.csv rows:       {len(old_data)}")
    print(f"  NEW       (only in new.csv): {len(new_codes)}")
    print(f"  UPDATED   (changed values):  {len(updated)}")
    print(f"  UNCHANGED (identical):       {len(common_codes) - len(updated)}")
    print(f"  DROPPED   (only in old.csv): {len(dropped_codes)}    [not in output]")
    print(f"Wrote {len(new_codes) + len(updated)} rows -> {OUT_FILE.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
