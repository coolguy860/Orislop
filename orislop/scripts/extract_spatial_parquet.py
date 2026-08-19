#!/usr/bin/env python3
"""Extract Hugging Face image Parquet rows into deterministic local manifests."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
from pathlib import Path

from PIL import Image
import pyarrow.parquet as pq


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--parquet", required=True)
    parser.add_argument("--split", required=True, choices=("train", "val", "test"))
    parser.add_argument("--output-root", required=True)
    return parser.parse_args()


def image_bytes(value: object) -> bytes:
    if isinstance(value, bytes):
        return value
    if isinstance(value, dict):
        payload = value.get("bytes")
        if isinstance(payload, bytes):
            return payload
        source = value.get("path")
        if source:
            return Path(str(source)).read_bytes()
    raise ValueError(f"Unsupported image cell: {type(value).__name__}")


def main() -> None:
    args = parse_args()
    parquet_path = Path(args.parquet).expanduser().resolve()
    output_root = Path(args.output_root).expanduser().resolve()
    image_dir = output_root / args.split / "images"
    image_dir.mkdir(parents=True, exist_ok=True)
    rows = pq.read_table(parquet_path).to_pylist()
    manifest_path = output_root / f"{args.split}.jsonl"
    manifest_rows = []
    for index, row in enumerate(rows):
        payload = image_bytes(row["image"])
        digest = hashlib.sha256(payload).hexdigest()
        target = image_dir / f"{index:07d}-{digest[:16]}.png"
        if not target.is_file():
            with Image.open(io.BytesIO(payload)) as image:
                image.convert("RGB").save(target, format="PNG", optimize=True)
        manifest_rows.append(
            {
                "path": str(target),
                "label": int(row["label"]),
                "split": args.split,
                "content_sha256": digest,
                "source_parquet": str(parquet_path),
                "source_row": index,
            }
        )
    manifest_path.write_text(
        "".join(json.dumps(row, sort_keys=True) + "\n" for row in manifest_rows),
        encoding="utf-8",
    )
    print(json.dumps({"manifest": str(manifest_path), "rows": len(manifest_rows)}, indent=2))


if __name__ == "__main__":
    main()
