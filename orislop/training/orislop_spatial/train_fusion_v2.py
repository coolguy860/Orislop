#!/usr/bin/env python3
"""Train the deterministic Orislop spatial CLS-token fusion checkpoint."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
from pathlib import Path
import sys
import time
from typing import Any

import cv2
import numpy as np
from PIL import Image
import torch
from torch import nn
from torch.utils.data import DataLoader, TensorDataset
from transformers import CLIPModel, CLIPProcessor, pipeline


REPO_ROOT = Path(__file__).resolve().parents[2]
BRIDGE_ROOT = REPO_ROOT / "apps" / "detector-bridge"
TEMPORAL_ROOT = REPO_ROOT / "core" / "temporal_detector"
for path in (str(BRIDGE_ROOT), str(TEMPORAL_ROOT)):
    if path not in sys.path:
        sys.path.insert(0, path)

from full_pipeline_utils import compute_binary_metrics, select_threshold  # noqa: E402
from spatial_runtime import (  # noqa: E402
    AI_MODEL_ID,
    AI_MODEL_REVISION,
    CLIP_MODEL_ID,
    CLIP_MODEL_REVISION,
    SPATIAL_CHECKPOINT_FORMAT,
    SPATIAL_ENCODER_CONTRACT,
    TEXT_PROMPTS,
    VISION_MODEL_ID,
    VISION_MODEL_REVISION,
    FusionDetector,
    VisionEncoder,
    classifier_ai_probability,
)


BACKBONE_FINGERPRINT = hashlib.sha256(
    f"{VISION_MODEL_REVISION}|{AI_MODEL_REVISION}|{CLIP_MODEL_REVISION}".encode()
).hexdigest()[:12]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--train-manifest", required=True)
    parser.add_argument("--validation-manifest", required=True)
    parser.add_argument("--test-manifest", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--feature-cache-dir", required=True)
    parser.add_argument("--device", default="auto", choices=("auto", "cpu", "cuda"))
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--train-batch-size", type=int, default=64)
    parser.add_argument("--epochs", type=int, default=40)
    parser.add_argument("--patience", type=int, default=8)
    parser.add_argument("--learning-rate", type=float, default=2e-4)
    parser.add_argument("--weight-decay", type=float, default=1e-4)
    parser.add_argument("--target-real-fpr", type=float, default=0.001)
    parser.add_argument("--seed", type=int, default=1337)
    parser.add_argument("--rebuild-features", action="store_true")
    parser.add_argument("--limit-per-class", type=int, default=None, help="Smoke-test limit applied independently to each split")
    parser.add_argument("--vision-model-path", default=VISION_MODEL_ID)
    parser.add_argument("--ai-model-path", default=AI_MODEL_ID)
    parser.add_argument("--clip-model-path", default=CLIP_MODEL_ID)
    return parser.parse_args()


def read_manifest(path: str | Path) -> list[dict[str, Any]]:
    manifest = Path(path).expanduser().resolve()
    text = manifest.read_text(encoding="utf-8").strip()
    rows = json.loads(text) if text.startswith("[") else [json.loads(line) for line in text.splitlines() if line.strip()]
    result = []
    for row in rows:
        image_path = Path(row["path"]).expanduser().resolve()
        if not image_path.is_file():
            raise FileNotFoundError(image_path)
        result.append({**row, "path": str(image_path), "label": int(row["label"])})
    if not result:
        raise RuntimeError(f"Manifest is empty: {manifest}")
    return result


def sample_identity(row: dict[str, Any]) -> str:
    return str(row.get("content_sha256") or Path(row["path"]).resolve()).lower()


def require_disjoint_splits(splits: dict[str, list[dict[str, Any]]]) -> None:
    identities = {name: {sample_identity(row) for row in rows} for name, rows in splits.items()}
    names = list(identities)
    for index, left in enumerate(names):
        for right in names[index + 1 :]:
            overlap = identities[left] & identities[right]
            if overlap:
                raise RuntimeError(f"Data leakage: {left} and {right} share {len(overlap)} samples")


def manifest_fingerprint(rows: list[dict[str, Any]]) -> str:
    payload = "\n".join(f"{sample_identity(row)}:{row['label']}" for row in rows).encode()
    return hashlib.sha256(payload).hexdigest()


def limit_per_class(rows: list[dict[str, Any]], limit: int | None) -> list[dict[str, Any]]:
    if limit is None:
        return rows
    selected = []
    counts: dict[int, int] = {}
    for row in rows:
        label = int(row["label"])
        if counts.get(label, 0) >= limit:
            continue
        selected.append(row)
        counts[label] = counts.get(label, 0) + 1
    if set(counts) != {0, 1}:
        raise RuntimeError("Each limited split must contain both labels")
    return selected


def resolve_device(requested: str) -> torch.device:
    if requested == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA was requested but is unavailable")
    if requested == "cuda" or (requested == "auto" and torch.cuda.is_available()):
        return torch.device("cuda")
    return torch.device("cpu")


def texture_probability(image: Image.Image) -> float:
    grayscale = np.asarray(image.convert("L"))
    variance = float(np.var(cv2.Laplacian(grayscale, cv2.CV_64F)))
    return float(np.clip(variance / 500.0, 0.0, 1.0))


def normalize_classifier_batch(raw: Any, expected: int) -> list[list[dict[str, Any]]]:
    if expected == 1 and raw and isinstance(raw[0], dict):
        return [raw]
    if not isinstance(raw, list) or len(raw) != expected:
        raise RuntimeError("AI classifier returned an unexpected batch")
    return raw


def build_feature_models(
    device: torch.device,
    vision_model_path: str,
    ai_model_path: str,
    clip_model_path: str,
) -> tuple[VisionEncoder, Any, CLIPProcessor, CLIPModel]:
    vision = VisionEncoder(vision_model_path).to(device).eval()
    ai_classifier = pipeline("image-classification", model=ai_model_path, device=-1)
    clip_processor = CLIPProcessor.from_pretrained(clip_model_path)
    clip = CLIPModel.from_pretrained(clip_model_path).to(device).eval()
    return vision, ai_classifier, clip_processor, clip


@torch.no_grad()
def extract_features(
    rows: list[dict[str, Any]],
    cache_path: Path,
    device: torch.device,
    batch_size: int,
    rebuild: bool,
    models: tuple[VisionEncoder, Any, CLIPProcessor, CLIPModel] | None,
) -> tuple[torch.Tensor, torch.Tensor]:
    if cache_path.is_file() and not rebuild:
        with np.load(cache_path, allow_pickle=False) as payload:
            contract = str(payload["encoder_contract"].item())
            if contract != SPATIAL_ENCODER_CONTRACT:
                raise RuntimeError(f"Feature cache contract mismatch: {contract}")
            fingerprint = str(payload["backbone_fingerprint"].item())
            if fingerprint != BACKBONE_FINGERPRINT:
                raise RuntimeError(f"Feature cache backbone mismatch: {fingerprint}")
            return torch.from_numpy(payload["features"]), torch.from_numpy(payload["labels"])
    if models is None:
        raise RuntimeError("Feature models must be loaded when rebuilding a feature cache")
    vision, ai_classifier, clip_processor, clip = models
    feature_batches: list[torch.Tensor] = []
    label_batches: list[torch.Tensor] = []
    shard_dir = cache_path.with_suffix("")
    shard_dir.mkdir(parents=True, exist_ok=True)
    for start in range(0, len(rows), batch_size):
        batch_rows = rows[start : start + batch_size]
        shard_path = shard_dir / f"batch-{start:08d}.npz"
        if shard_path.is_file() and not rebuild:
            with np.load(shard_path, allow_pickle=False) as payload:
                if str(payload["encoder_contract"].item()) != SPATIAL_ENCODER_CONTRACT:
                    raise RuntimeError(f"Feature shard contract mismatch: {shard_path}")
                if str(payload["backbone_fingerprint"].item()) != BACKBONE_FINGERPRINT:
                    raise RuntimeError(f"Feature shard backbone mismatch: {shard_path}")
                if int(payload["start"].item()) != start or int(payload["count"].item()) != len(batch_rows):
                    raise RuntimeError(f"Feature shard range mismatch: {shard_path}")
                feature_batches.append(torch.from_numpy(payload["features"]))
                label_batches.append(torch.from_numpy(payload["labels"]))
            print(f"[features] reused {cache_path.stem}: {min(start + len(batch_rows), len(rows))}/{len(rows)}", flush=True)
            continue
        images = []
        for row in batch_rows:
            with Image.open(row["path"]) as image:
                images.append(image.convert("RGB"))
        classifier_rows = normalize_classifier_batch(
            ai_classifier(images, batch_size=max(1, len(images))),
            len(images),
        )
        ai_scores = [classifier_ai_probability(item) for item in classifier_rows]
        pixels = vision.processor(images=images, return_tensors="pt")["pixel_values"].to(device)
        embeddings = vision(pixels).to(dtype=torch.float32)
        clip_inputs = clip_processor(text=TEXT_PROMPTS, images=images, return_tensors="pt", padding=True).to(device)
        clip_scores = clip(**clip_inputs).logits_per_image.softmax(dim=1)[:, 1]
        texture_scores = torch.tensor([texture_probability(image) for image in images], device=device)
        auxiliary = torch.stack(
            [torch.tensor(ai_scores, device=device), clip_scores, texture_scores], dim=1
        ).to(dtype=torch.float32)
        batch_features = torch.cat([embeddings, auxiliary], dim=1).cpu()
        batch_labels = torch.tensor(
            [int(row["label"]) for row in batch_rows], dtype=torch.float32
        ).view(-1, 1)
        feature_batches.append(batch_features)
        label_batches.append(batch_labels)
        temp_path = shard_path.with_suffix(".partial")
        with temp_path.open("wb") as handle:
            np.savez_compressed(
                handle,
                features=batch_features.numpy(),
                labels=batch_labels.numpy(),
                encoder_contract=np.asarray(SPATIAL_ENCODER_CONTRACT),
                backbone_fingerprint=np.asarray(BACKBONE_FINGERPRINT),
                start=np.asarray(start),
                count=np.asarray(len(batch_rows)),
            )
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, shard_path)
        print(f"[features] {cache_path.stem}: {min(start + len(images), len(rows))}/{len(rows)}", flush=True)
    features = torch.cat(feature_batches, dim=0)
    label_tensor = torch.cat(label_batches, dim=0)
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        cache_path,
        features=features.numpy(),
        labels=label_tensor.numpy(),
        encoder_contract=np.asarray(SPATIAL_ENCODER_CONTRACT),
        backbone_fingerprint=np.asarray(BACKBONE_FINGERPRINT),
    )
    return features, label_tensor


def fit_temperature(logits: torch.Tensor, labels: torch.Tensor) -> float:
    log_temperature = nn.Parameter(torch.zeros((), dtype=torch.float64))
    optimizer = torch.optim.LBFGS([log_temperature], lr=0.1, max_iter=80, line_search_fn="strong_wolfe")
    raw = logits.detach().double().view(-1)
    target = labels.detach().double().view(-1)

    def closure() -> torch.Tensor:
        optimizer.zero_grad(set_to_none=True)
        loss = nn.functional.binary_cross_entropy_with_logits(raw / log_temperature.exp().clamp(0.05, 100), target)
        loss.backward()
        return loss

    optimizer.step(closure)
    return float(log_temperature.detach().exp().clamp(0.05, 100))


@torch.no_grad()
def probabilities(model: nn.Module, features: torch.Tensor, temperature: float = 1.0) -> list[float]:
    model.eval()
    return torch.sigmoid(model(features) / max(0.05, temperature)).view(-1).cpu().tolist()


def main() -> None:
    args = parse_args()
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    device = resolve_device(args.device)
    splits = {
        "train": limit_per_class(read_manifest(args.train_manifest), args.limit_per_class),
        "validation": limit_per_class(read_manifest(args.validation_manifest), args.limit_per_class),
        "test": limit_per_class(read_manifest(args.test_manifest), args.limit_per_class),
    }
    require_disjoint_splits(splits)
    cache_root = Path(args.feature_cache_dir).expanduser().resolve()
    tensors = {}
    feature_models = None
    for name, rows in splits.items():
        cache_path = cache_root / f"{name}-{SPATIAL_ENCODER_CONTRACT}-{BACKBONE_FINGERPRINT}.npz"
        if (not cache_path.is_file() or args.rebuild_features) and feature_models is None:
            feature_models = build_feature_models(
                device,
                args.vision_model_path,
                args.ai_model_path,
                args.clip_model_path,
            )
        tensors[name] = extract_features(
            rows,
            cache_path,
            device,
            args.batch_size,
            args.rebuild_features,
            feature_models,
        )
    train_x, train_y = tensors["train"]
    val_x, val_y = tensors["validation"]
    test_x, test_y = tensors["test"]
    model = FusionDetector(train_x.shape[1] - 3, aux_dim=3).to(device)
    positives = float(train_y.sum())
    negatives = float(train_y.numel() - positives)
    criterion = nn.BCEWithLogitsLoss(pos_weight=torch.tensor([negatives / max(1.0, positives)], device=device))
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate, weight_decay=args.weight_decay)
    generator = torch.Generator().manual_seed(args.seed)
    loader = DataLoader(
        TensorDataset(train_x, train_y),
        batch_size=args.train_batch_size,
        shuffle=True,
        generator=generator,
    )
    best_auc = -1.0
    best_state: dict[str, torch.Tensor] | None = None
    history = []
    stale = 0
    started = time.perf_counter()
    for epoch in range(args.epochs):
        model.train()
        losses = []
        for features, labels in loader:
            features, labels = features.to(device), labels.to(device)
            optimizer.zero_grad(set_to_none=True)
            loss = criterion(model(features), labels)
            loss.backward()
            optimizer.step()
            losses.append(float(loss.detach().cpu()))
        val_probs = probabilities(model, val_x.to(device))
        val_metrics = compute_binary_metrics(val_y.view(-1).long().tolist(), val_probs)
        auc = float(val_metrics.get("roc_auc") or 0.0)
        history.append({"epoch": epoch + 1, "loss": float(np.mean(losses)), "validation": val_metrics})
        print(f"[train] epoch={epoch + 1} loss={np.mean(losses):.5f} val_auc={auc:.5f}", flush=True)
        if auc > best_auc:
            best_auc = auc
            best_state = {name: value.detach().cpu().clone() for name, value in model.state_dict().items()}
            stale = 0
        else:
            stale += 1
            if stale >= args.patience:
                break
    if best_state is None:
        raise RuntimeError("Training did not produce a checkpoint")
    model.load_state_dict(best_state, strict=True)
    model.to(device).eval()
    with torch.no_grad():
        val_logits = model(val_x.to(device)).cpu()
    temperature = fit_temperature(val_logits, val_y)
    val_probs = torch.sigmoid(val_logits / temperature).view(-1).tolist()
    threshold = select_threshold(
        val_y.view(-1).long().tolist(),
        val_probs,
        method="target_real_fpr",
        target_real_fpr=args.target_real_fpr,
    )
    test_probs = probabilities(model, test_x.to(device), temperature)
    test_metrics = compute_binary_metrics(
        test_y.view(-1).long().tolist(),
        test_probs,
        threshold=float(threshold["threshold"]),
    )
    metadata = {
        "format_version": SPATIAL_CHECKPOINT_FORMAT,
        "encoder_contract": SPATIAL_ENCODER_CONTRACT,
        "vision_model_id": VISION_MODEL_ID,
        "vision_model_revision": VISION_MODEL_REVISION,
        "ai_model_id": AI_MODEL_ID,
        "ai_model_revision": AI_MODEL_REVISION,
        "clip_model_id": CLIP_MODEL_ID,
        "clip_model_revision": CLIP_MODEL_REVISION,
        "temperature": temperature,
        "threshold": float(threshold["threshold"]),
        "threshold_selection": threshold,
        "manifest_fingerprints": {name: manifest_fingerprint(rows) for name, rows in splits.items()},
        "sample_counts": {name: len(rows) for name, rows in splits.items()},
        "validation_metrics": compute_binary_metrics(
            val_y.view(-1).long().tolist(), val_probs, threshold=float(threshold["threshold"])
        ),
        "test_metrics": test_metrics,
        "training_seconds": time.perf_counter() - started,
        "seed": args.seed,
    }
    output = Path(args.output).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    torch.save({"metadata": metadata, "fusion_state_dict": best_state, "history": history}, output)
    output.with_suffix(".metrics.json").write_text(json.dumps(metadata, indent=2, sort_keys=True), encoding="utf-8")
    print(json.dumps({"checkpoint": str(output), "test": test_metrics}, indent=2), flush=True)


if __name__ == "__main__":
    main()
