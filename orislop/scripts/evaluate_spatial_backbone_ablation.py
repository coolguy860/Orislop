#!/usr/bin/env python3
"""Evaluate borrowed spatial signals against Orislop's learned fusion.

This is intentionally not described as a "personal-only" spatial model.  The
learned FusionDetector consumes frozen ViT embeddings and auxiliary borrowed
model scores, so those trained weights have no valid standalone input space.
The useful ablation is therefore:

* borrowed AI/CLIP scores without the Orislop fusion head; and
* the complete detector with the learned Orislop fusion head.

The input manifest is a JSON array with ``path`` and binary ``label`` fields,
where 0 is genuine and 1 is synthetic.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path
from typing import Iterable, Sequence

import cv2
import numpy as np
from PIL import Image
import torch
from transformers import (
    AutoImageProcessor,
    AutoModel,
    AutoModelForImageClassification,
    CLIPModel,
    CLIPProcessor,
)


ROOT = Path(__file__).resolve().parents[1]
BRIDGE_ROOT = ROOT / "apps" / "detector-bridge"
if str(BRIDGE_ROOT) not in sys.path:
    sys.path.insert(0, str(BRIDGE_ROOT))

from spatial_runtime import FusionDetector  # noqa: E402


VISION_MODEL_ID = "google/vit-base-patch16-224"
AI_MODEL_ID = "umm-maybe/AI-image-detector"
CLIP_MODEL_ID = "openai/clip-vit-base-patch32"
TEXT_PROMPTS = ["a real photograph", "an AI generated image"]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--fusion-checkpoint", required=True)
    parser.add_argument(
        "--clip-model-path",
        default=CLIP_MODEL_ID,
        help="Model ID or complete local CLIP snapshot (useful for strict offline evaluation).",
    )
    parser.add_argument("--output", required=True)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument(
        "--limit-per-class",
        type=int,
        default=None,
        help="Deterministically use at most this many samples from each class.",
    )
    parser.add_argument("--device", choices=["cpu", "cuda"], default="cpu")
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--seed", type=int, default=1337)
    return parser.parse_args()


def load_rows(path: Path, limit_per_class: int | None) -> list[dict[str, object]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, list):
        raise ValueError("spatial ablation manifest must be a JSON array")
    rows: list[dict[str, object]] = []
    counts = {0: 0, 1: 0}
    for raw in payload:
        label = int(raw["label"])
        if label not in counts:
            raise ValueError(f"unsupported label: {label}")
        if limit_per_class is not None and counts[label] >= limit_per_class:
            continue
        image_path = Path(str(raw["path"]))
        if not image_path.is_file():
            raise FileNotFoundError(image_path)
        rows.append({"path": str(image_path), "label": label})
        counts[label] += 1
    if not rows or not all(counts.values()):
        raise ValueError(f"evaluation requires both classes; got {counts}")
    return rows


def chunks(items: Sequence[dict[str, object]], size: int) -> Iterable[Sequence[dict[str, object]]]:
    for start in range(0, len(items), max(1, size)):
        yield items[start : start + max(1, size)]


def synthetic_class_index(model: torch.nn.Module) -> int:
    mapping = getattr(model.config, "id2label", {})
    for raw_index, raw_label in mapping.items():
        label = str(raw_label).lower()
        if any(token in label for token in ("fake", "ai", "synthetic", "generated", "artificial")):
            return int(raw_index)
    raise RuntimeError(f"could not identify synthetic class from labels: {mapping}")


def texture_scores(images: Sequence[Image.Image]) -> torch.Tensor:
    values = []
    for image in images:
        grayscale = np.array(image.convert("L"))
        variance = float(np.var(cv2.Laplacian(grayscale, cv2.CV_64F)))
        values.append(float(np.clip(variance / 500.0, 0.0, 1.0)))
    return torch.tensor(values, dtype=torch.float32)


def rank_auc(labels: Sequence[int], probabilities: Sequence[float]) -> float | None:
    positives = sum(label == 1 for label in labels)
    negatives = len(labels) - positives
    if positives == 0 or negatives == 0:
        return None
    ordered = sorted(enumerate(probabilities), key=lambda item: item[1])
    rank_sum = 0.0
    index = 0
    while index < len(ordered):
        end = index + 1
        while end < len(ordered) and ordered[end][1] == ordered[index][1]:
            end += 1
        average_rank = (index + 1 + end) / 2.0
        rank_sum += average_rank * sum(labels[ordered[pos][0]] == 1 for pos in range(index, end))
        index = end
    return (rank_sum - positives * (positives + 1) / 2.0) / (positives * negatives)


def expected_calibration_error(labels: Sequence[int], probabilities: Sequence[float], bins: int = 10) -> float:
    total = max(1, len(labels))
    result = 0.0
    for index in range(bins):
        lower = index / bins
        upper = (index + 1) / bins
        members = [
            (label, probability)
            for label, probability in zip(labels, probabilities)
            if probability >= lower and (probability < upper or (index == bins - 1 and probability <= upper))
        ]
        if not members:
            continue
        confidence = sum(probability for _, probability in members) / len(members)
        prevalence = sum(label for label, _ in members) / len(members)
        result += len(members) / total * abs(confidence - prevalence)
    return result


def metrics(labels: Sequence[int], probabilities: Sequence[float], threshold: float = 0.5) -> dict[str, object]:
    tp = fp = tn = fn = 0
    for label, probability in zip(labels, probabilities):
        predicted = int(probability >= threshold)
        if label == 1 and predicted == 1:
            tp += 1
        elif label == 0 and predicted == 1:
            fp += 1
        elif label == 0:
            tn += 1
        else:
            fn += 1
    recall = tp / max(1, tp + fn)
    specificity = tn / max(1, tn + fp)
    precision = tp / max(1, tp + fp)
    return {
        "n": len(labels),
        "threshold": threshold,
        "accuracy": (tp + tn) / max(1, len(labels)),
        "balanced_accuracy": (recall + specificity) / 2.0,
        "precision": precision,
        "fake_recall": recall,
        "real_specificity": specificity,
        "real_false_positive_rate": fp / max(1, fp + tn),
        "f1": 2 * precision * recall / max(1e-12, precision + recall),
        "roc_auc": rank_auc(labels, probabilities),
        "brier_score": sum((probability - label) ** 2 for label, probability in zip(labels, probabilities))
        / max(1, len(labels)),
        "ece": expected_calibration_error(labels, probabilities),
        "confusion_matrix": [[tn, fp], [fn, tp]],
    }


def main() -> None:
    args = parse_args()
    if args.device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA was requested but is unavailable")
    torch.manual_seed(int(args.seed))
    device = torch.device(args.device)
    rows = load_rows(Path(args.manifest), args.limit_per_class)

    load_options = {"local_files_only": bool(args.offline)}
    ai_processor = AutoImageProcessor.from_pretrained(AI_MODEL_ID, **load_options)
    ai_model = AutoModelForImageClassification.from_pretrained(AI_MODEL_ID, **load_options).to(device).eval()
    ai_index = synthetic_class_index(ai_model)
    vision_processor = AutoImageProcessor.from_pretrained(VISION_MODEL_ID, **load_options)
    vision_model = AutoModel.from_pretrained(VISION_MODEL_ID, **load_options).to(device).eval()
    vision_dim = int(getattr(vision_model.config, "hidden_size", 768))
    clip_processor = CLIPProcessor.from_pretrained(args.clip_model_path, **load_options)
    clip_model = CLIPModel.from_pretrained(args.clip_model_path, **load_options).to(device).eval()
    fusion = FusionDetector(vision_dim, aux_dim=3).to(device).eval()
    try:
        state = torch.load(args.fusion_checkpoint, map_location=device, weights_only=True)
    except TypeError:
        state = torch.load(args.fusion_checkpoint, map_location=device)
    fusion.load_state_dict(state, strict=True)

    labels: list[int] = []
    ai_scores: list[float] = []
    clip_scores: list[float] = []
    texture_values: list[float] = []
    full_scores: list[float] = []
    feature_seconds = 0.0
    fusion_seconds = 0.0
    started = time.perf_counter()

    with torch.inference_mode():
        batches = list(chunks(rows, args.batch_size))
        for batch_index, batch in enumerate(batches, 1):
            images = [Image.open(str(row["path"])).convert("RGB") for row in batch]
            labels.extend(int(row["label"]) for row in batch)
            feature_started = time.perf_counter()

            ai_inputs = ai_processor(images=images, return_tensors="pt").to(device)
            ai_probability = ai_model(**ai_inputs).logits.softmax(dim=-1)[:, ai_index]

            clip_inputs = clip_processor(text=TEXT_PROMPTS, images=images, return_tensors="pt", padding=True).to(device)
            clip_probability = clip_model(**clip_inputs).logits_per_image.softmax(dim=-1)[:, 1]

            vision_inputs = vision_processor(images=images, return_tensors="pt").to(device)
            vision_output = vision_model(**vision_inputs)
            embedding = (
                vision_output.pooler_output
                if getattr(vision_output, "pooler_output", None) is not None
                else vision_output.last_hidden_state[:, 0]
            ).float()
            texture = texture_scores(images).to(device)
            feature_seconds += time.perf_counter() - feature_started

            fusion_started = time.perf_counter()
            auxiliary = torch.stack((ai_probability, clip_probability, texture), dim=1).float()
            fused_probability = torch.sigmoid(fusion(torch.cat((embedding, auxiliary), dim=1))).flatten()
            fusion_seconds += time.perf_counter() - fusion_started

            ai_scores.extend(ai_probability.detach().cpu().tolist())
            clip_scores.extend(clip_probability.detach().cpu().tolist())
            texture_values.extend(texture.detach().cpu().tolist())
            full_scores.extend(fused_probability.detach().cpu().tolist())
            for image in images:
                image.close()
            print(f"[spatial-ablation] batch {batch_index}/{len(batches)}", flush=True)

    borrowed_mean = [(ai + clip) / 2.0 for ai, clip in zip(ai_scores, clip_scores)]
    borrowed_with_texture = [
        (ai + clip + texture) / 3.0
        for ai, clip, texture in zip(ai_scores, clip_scores, texture_values)
    ]
    result = {
        "schema_version": 1,
        "comparison": {
            "external_ai_only": metrics(labels, ai_scores),
            "external_clip_only": metrics(labels, clip_scores),
            "external_ai_clip_mean": metrics(labels, borrowed_mean),
            "external_ai_clip_texture_mean": metrics(labels, borrowed_with_texture),
            "complete_orislop_fusion": metrics(labels, full_scores),
        },
        "sample_counts": {"real": labels.count(0), "fake": labels.count(1)},
        "seed": int(args.seed),
        "timing": {
            "wall_seconds": time.perf_counter() - started,
            "borrowed_feature_seconds": feature_seconds,
            "orislop_fusion_head_seconds": fusion_seconds,
        },
        "notes": [
            "The trained Orislop spatial head is not a standalone raw-image model.",
            "It requires the same frozen ViT/AI/CLIP feature space used during training.",
            "The external-only rows are fixed, untrained score combinations and are not threshold-calibrated.",
        ],
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2, sort_keys=True), encoding="utf-8")
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
