#!/usr/bin/env python3
"""Load a spatial v2 artifact through the production runtime and score one image."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import random
import sys

import numpy as np
from PIL import Image
import torch


BRIDGE_ROOT = Path(__file__).resolve().parents[1] / "apps" / "detector-bridge"
sys.path.insert(0, str(BRIDGE_ROOT))

from spatial_runtime import SpatialDetector  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", default=None, help="Omit to verify packaged-checkpoint discovery")
    parser.add_argument("--image", required=True)
    parser.add_argument("--cache-dir", required=True)
    parser.add_argument("--seed", type=int, default=1337)
    args = parser.parse_args()
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    detector = SpatialDetector(args.cache_dir, checkpoint_path=args.checkpoint)
    with Image.open(args.image) as image:
        probability = detector.analyze_image(image.convert("RGB"))
    print(
        json.dumps(
            {
                "seed": args.seed,
                "probability": probability,
                "threshold": detector.recommended_threshold,
                "encoder_contract": detector.checkpoint_metadata["encoder_contract"],
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
