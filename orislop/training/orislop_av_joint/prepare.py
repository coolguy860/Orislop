#!/usr/bin/env python3
"""Prepare rights-approved raw media with the production YuNet pipeline."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from core.av_joint import AVPreprocessor, YuNetFaceTracker  # noqa: E402


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--data-root", required=True)
    parser.add_argument("--output-root", required=True)
    parser.add_argument("--yunet-model", required=True)
    parser.add_argument("--seconds", type=int, choices=(2, 4, 8), default=8)
    args = parser.parse_args()
    manifest_path = Path(args.manifest).resolve()
    output_root = Path(args.output_root).resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    tracker = YuNetFaceTracker(args.yunet_model, max_faces=4, mouth_size=112)
    preprocessor = AVPreprocessor(tracker)
    output_records = []
    for record in read_jsonl(manifest_path):
        source_path = Path(record["videoPath"])
        if not source_path.is_absolute():
            source_path = Path(args.data_root).resolve() / source_path
        context = preprocessor.process(source_path, seconds=args.seconds, language=record.get("language", "unknown"))
        prepared_path = output_root / f"{record['id']}.npz"
        labels = dict(record.get("labels") or {})
        arrays = {
            "mouth_tracks": context.mouth_tracks,
            "waveform": context.waveform,
            "track_mask": context.track_mask,
            "quality": context.quality,
        }
        for name, value in labels.items():
            arrays[name] = np.asarray(value)
        np.savez_compressed(prepared_path, **arrays)
        output_records.append({
            **record,
            "preparedPath": prepared_path.relative_to(manifest_path.parent).as_posix()
            if prepared_path.is_relative_to(manifest_path.parent) else str(prepared_path),
            "avApplicable": context.applicable,
            "avGateReasons": context.gate_reasons,
        })
    output_manifest = output_root / "prepared_manifest.jsonl"
    output_manifest.write_text("".join(json.dumps(record) + "\n" for record in output_records), encoding="utf-8")
    print(output_manifest)


if __name__ == "__main__":
    main()
