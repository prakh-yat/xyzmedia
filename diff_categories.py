#!/usr/bin/env python3
"""
Find category additions and removals between old.csv and new.csv.

Scans the Category1..Category6 columns in each file, builds a set of unique
category strings per file, and reports:
  - ADDED:   categories that appear in new.csv but not old.csv
  - REMOVED: categories that appear in old.csv but not new.csv

Output:
  - prints the diff to stdout
  - writes category_changes.csv (Category, Status, OldCount, NewCount)
    where Status is one of ADDED / REMOVED / UNCHANGED
"""

import csv
from collections import Counter
from pathlib import Path

HERE = Path(__file__).parent
NEW_FILE = HERE / "new.csv"
OLD_FILE = HERE / "old.csv"
OUT_FILE = HERE / "category_changes.csv"

CATEGORY_COLS = [f"Category{i}" for i in range(1, 7)]


def category_counts(path: Path) -> Counter:
    """Count how many times each category string appears across Category1..6."""
    counts: Counter = Counter()
    with path.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            row = {k: (v or "") for k, v in row.items() if k and k.strip()}
            for col in CATEGORY_COLS:
                value = (row.get(col, "") or "").strip()
                if value:
                    counts[value] += 1
    return counts


def main() -> int:
    old_counts = category_counts(OLD_FILE)
    new_counts = category_counts(NEW_FILE)

    old_set = set(old_counts)
    new_set = set(new_counts)

    added = sorted(new_set - old_set)
    removed = sorted(old_set - new_set)
    unchanged = sorted(new_set & old_set)

    print(f"Unique categories in old.csv: {len(old_set)}")
    print(f"Unique categories in new.csv: {len(new_set)}")
    print()

    print(f"ADDED ({len(added)}) — in new.csv, not in old.csv:")
    for c in added:
        print(f"  + {c}    (used {new_counts[c]}x)")
    print()

    print(f"REMOVED ({len(removed)}) — in old.csv, not in new.csv:")
    for c in removed:
        print(f"  - {c}    (was used {old_counts[c]}x)")
    print()

    with OUT_FILE.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["Category", "Status", "OldCount", "NewCount"])
        for c in added:
            writer.writerow([c, "ADDED", 0, new_counts[c]])
        for c in removed:
            writer.writerow([c, "REMOVED", old_counts[c], 0])
        for c in unchanged:
            writer.writerow([c, "UNCHANGED", old_counts[c], new_counts[c]])

    print(f"Wrote full breakdown to {OUT_FILE.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
