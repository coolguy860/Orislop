#!/usr/bin/env python3
"""Create deterministic, disjoint validation/test manifests for calibration."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import random


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--validation-fraction", type=float, default=0.5)
    parser.add_argument("--seed", type=int, default=1337)
    args = parser.parse_args()
    if not 0 < args.validation_fraction < 1:
        raise ValueError("--validation-fraction must be between zero and one")
    rows = [json.loads(line) for line in Path(args.input).read_text(encoding="utf-8").splitlines() if line.strip()]
    grouped: dict[int, list[dict]] = {}
    for row in rows:
        grouped.setdefault(int(row["label"]), []).append(row)
    rng = random.Random(args.seed)
    validation, test = [], []
    for label, group in sorted(grouped.items()):
        rng.shuffle(group)
        count = round(len(group) * args.validation_fraction)
        if count <= 0 or count >= len(group):
            raise RuntimeError(f"Label {label} does not have enough samples for disjoint splits")
        validation.extend({**row, "split": "val"} for row in group[:count])
        test.extend({**row, "split": "test"} for row in group[count:])
    output = Path(args.output_dir).expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    for name, split_rows in (("validation", validation), ("test", test)):
        (output / f"{name}.jsonl").write_text(
            "".join(json.dumps(row, sort_keys=True) + "\n" for row in split_rows),
            encoding="utf-8",
        )
    print(
        json.dumps(
            {
                "validation": {"total": len(validation), "real": sum(row["label"] == 0 for row in validation)},
                "test": {"total": len(test), "real": sum(row["label"] == 0 for row in test)},
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
