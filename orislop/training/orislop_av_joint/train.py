#!/usr/bin/env python3
"""Train, calibrate, validate, and export orislop-av-joint-v1.

The release path deliberately accepts only prepared tensors tied to a rights
ledger. Raw-media preparation lives in ``prepare.py`` and shares the production
YuNet implementation. No pretrained AV checkpoint can be supplied: release
models are initialized from scratch.
"""

from __future__ import annotations

import argparse
from dataclasses import asdict
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import random
import tempfile
import time
from typing import Any, Iterable

import numpy as np
import torch
from torch import Tensor
from torch.nn import functional as F
from torch.utils.data import DataLoader, Dataset

try:
    from .model import AVJointConfig, CalibratedAVJointExport, OrislopAVJointV1
except ImportError:  # Direct script execution.
    from model import AVJointConfig, CalibratedAVJointExport, OrislopAVJointV1


TASKS = (
    "active_speaker",
    "sync_mismatch",
    "audio_spoof",
    "visual_forgery",
    "joint_forgery",
)
LOSS_WEIGHTS = {
    "joint_forgery": 1.0,
    "visual_forgery": 0.5,
    "audio_spoof": 0.5,
    "sync_mismatch": 0.5,
    "active_speaker": 0.25,
    "offset": 0.25,
    "segment_forgery": 0.2,
    "uncertainty": 0.1,
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def read_json(path: str | Path) -> dict[str, Any]:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_json(path: str | Path, payload: Any) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(payload, indent=2, default=json_default) + "\n", encoding="utf-8")


def json_default(value: Any) -> Any:
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, (np.integer, np.floating)):
        return value.item()
    if isinstance(value, np.ndarray):
        return value.tolist()
    raise TypeError(type(value).__name__)


def read_jsonl(path: str | Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for line_number, raw in enumerate(Path(path).read_text(encoding="utf-8").splitlines(), start=1):
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        try:
            records.append(json.loads(raw))
        except json.JSONDecodeError as exc:
            raise ValueError(f"Invalid JSON on line {line_number}: {exc}") from exc
    return records


def rights_report(manifest: Iterable[dict[str, Any]], ledger: dict[str, Any]) -> dict[str, Any]:
    sources = dict(ledger.get("sources") or {})
    failures: list[str] = []
    speakers: set[str] = set()
    total_seconds = 0.0
    release_records = 0
    speaker_splits: dict[str, set[str]] = {}
    content_splits: dict[str, set[str]] = {}
    generator_splits: dict[str, set[str]] = {}
    for index, record in enumerate(manifest):
        if record.get("releaseEligible", True) is not True:
            continue
        release_records += 1
        source_id = str(record.get("rightsSourceId") or "")
        source = sources.get(source_id)
        prefix = f"record[{index}]"
        if not source_id or not isinstance(source, dict):
            failures.append(f"{prefix}: missing rights ledger source")
            continue
        required_true = ("commercialUse", "modelTraining", "derivatives", "documentedConsent", "approved")
        for key in required_true:
            if source.get(key) is not True:
                failures.append(f"{prefix}: {source_id}.{key} must be true")
        if not str(source.get("license") or "").strip():
            failures.append(f"{prefix}: {source_id}.license is required")
        if not str(source.get("evidenceUri") or "").strip():
            failures.append(f"{prefix}: {source_id}.evidenceUri is required")
        if source.get("revoked") is True:
            failures.append(f"{prefix}: {source_id} was revoked")
        speaker = str(record.get("speakerId") or "")
        split = str(record.get("split") or "")
        content_id = str(record.get("contentSha256") or record.get("sourceVideoId") or "")
        generator = str(record.get("generatorFamily") or "")
        media_class = str(record.get("mediaClass") or "").lower()
        labels = dict(record.get("labels") or {})
        if media_class in {"legitimate_dubbing", "legitimate_delay"}:
            joint_values = np.asarray(labels.get("joint_forgery", []), dtype=np.float32).reshape(-1)
            sync_values = np.asarray(labels.get("sync_mismatch", []), dtype=np.float32).reshape(-1)
            if joint_values.size == 0 or np.any(joint_values > 0):
                failures.append(f"{prefix}: legitimate dubbing/delay must have joint_forgery=0")
            if sync_values.size == 0 or not np.any(sync_values > 0):
                failures.append(f"{prefix}: legitimate dubbing/delay must have sync_mismatch=1")
        speakers.add(speaker)
        if speaker:
            speaker_splits.setdefault(speaker, set()).add(split)
        if content_id:
            content_splits.setdefault(content_id, set()).add(split)
        if generator and generator != "genuine":
            generator_splits.setdefault(generator, set()).add(split)
        total_seconds += max(0.0, float(record.get("durationSeconds") or 0.0))
    speakers.discard("")
    for speaker, splits in speaker_splits.items():
        if len(splits) > 1:
            failures.append(f"speaker leakage across splits: {speaker}")
    for content_id, splits in content_splits.items():
        if len(splits) > 1:
            failures.append(f"source-video leakage across splits: {content_id}")
    held_out_generators = sorted(
        generator for generator, splits in generator_splits.items()
        if "test" in splits and "train" not in splits
    )
    if release_records == 0:
        failures.append("manifest has no release-eligible records")
    return {
        "passed": not failures,
        "failures": failures,
        "releaseRecords": release_records,
        "commercialSpeakers": len(speakers),
        "commercialHours": round(total_seconds / 3600.0, 4),
        "heldOutGeneratorFamilies": held_out_generators,
        "ledgerVersion": ledger.get("version"),
    }


class PreparedAVDataset(Dataset):
    def __init__(self, manifest_path: str | Path, split: str) -> None:
        self.manifest_path = Path(manifest_path).resolve()
        self.records = [
            record for record in read_jsonl(self.manifest_path)
            if record.get("split") == split and record.get("releaseEligible", True) is True
        ]
        if not self.records:
            raise ValueError(f"No release-eligible {split!r} records in {self.manifest_path}")

    def __len__(self) -> int:
        return len(self.records)

    def __getitem__(self, index: int) -> dict[str, Tensor]:
        record = self.records[index]
        cache_path = Path(str(record["preparedPath"]))
        if not cache_path.is_absolute():
            cache_path = self.manifest_path.parent / cache_path
        payload = np.load(cache_path, allow_pickle=False)
        mouth = np.asarray(payload["mouth_tracks"], dtype=np.float32)
        if mouth.ndim != 5:
            raise ValueError(f"{cache_path}: mouth_tracks must be [F,3,T,H,W]")
        sample = {
            "mouth_tracks": torch.from_numpy(mouth),
            "waveform": torch.from_numpy(np.asarray(payload["waveform"], dtype=np.float32)),
            "track_mask": torch.from_numpy(np.asarray(payload["track_mask"], dtype=np.float32)),
            "quality": torch.from_numpy(np.asarray(payload["quality"], dtype=np.float32)),
        }
        faces, frames = mouth.shape[0], mouth.shape[2]
        for task in TASKS:
            sample[task] = torch.from_numpy(label_array(payload, task, faces))
            sample[f"{task}_mask"] = torch.from_numpy(mask_array(payload, f"{task}_mask", faces))
        sample["offset"] = torch.from_numpy(np.asarray(payload.get("offset", np.zeros(faces)), dtype=np.int64))
        sample["offset_mask"] = torch.from_numpy(mask_array(payload, "offset_mask", faces))
        sample["segment_forgery"] = torch.from_numpy(
            np.asarray(payload.get("segment_forgery", np.zeros((faces, frames))), dtype=np.float32)
        )
        sample["segment_forgery_mask"] = torch.from_numpy(
            np.asarray(payload.get("segment_forgery_mask", np.zeros((faces, frames))), dtype=np.float32)
        )
        return sample


def label_array(payload: Any, name: str, faces: int) -> np.ndarray:
    return np.asarray(payload.get(name, np.full(faces, -1.0)), dtype=np.float32).reshape(faces)


def mask_array(payload: Any, name: str, faces: int) -> np.ndarray:
    return np.asarray(payload.get(name, np.zeros(faces, dtype=np.float32)), dtype=np.float32).reshape(faces)


def masked_bce(logits: Tensor, labels: Tensor, mask: Tensor) -> Tensor:
    losses = F.binary_cross_entropy_with_logits(logits, labels.clamp(0, 1), reduction="none")
    return (losses * mask).sum() / mask.sum().clamp_min(1.0)


def multitask_loss(outputs: dict[str, Tensor], batch: dict[str, Tensor], max_offset: int) -> tuple[Tensor, dict[str, float]]:
    mapping = {
        "active_speaker": "active_speaker_logit",
        "sync_mismatch": "sync_mismatch_logit",
        "audio_spoof": "audio_spoof_logit",
        "visual_forgery": "visual_forgery_logit",
        "joint_forgery": "joint_forgery_logit",
    }
    parts: dict[str, Tensor] = {}
    for task, output_name in mapping.items():
        parts[task] = masked_bce(outputs[output_name], batch[task], batch[f"{task}_mask"])
    offset_targets = (batch["offset"] + max_offset).clamp(0, max_offset * 2)
    offset_losses = F.cross_entropy(outputs["offset_logits"].flatten(0, 1), offset_targets.flatten(), reduction="none")
    parts["offset"] = (offset_losses * batch["offset_mask"].flatten()).sum() / batch["offset_mask"].sum().clamp_min(1.0)
    parts["segment_forgery"] = masked_bce(
        outputs["segment_forgery_logits"], batch["segment_forgery"], batch["segment_forgery_mask"]
    )
    joint_error = torch.abs(torch.sigmoid(outputs["joint_forgery_logit"]) - batch["joint_forgery"].clamp(0, 1)).detach()
    uncertainty_target = joint_error + (1.0 - batch["joint_forgery_mask"])
    parts["uncertainty"] = F.smooth_l1_loss(outputs["uncertainty"], uncertainty_target)
    total = sum(parts[name] * LOSS_WEIGHTS[name] for name in parts)
    return total, {name: float(value.detach().cpu()) for name, value in parts.items()}


def move_batch(batch: dict[str, Tensor], device: torch.device) -> dict[str, Tensor]:
    return {name: value.to(device) for name, value in batch.items()}


def build_model(config_path: str | Path | None = None) -> OrislopAVJointV1:
    values: dict[str, Any] = {}
    if config_path:
        raw = read_json(config_path)
        values = dict(raw.get("model") or {})
    allowed = set(AVJointConfig.__dataclass_fields__)
    config = AVJointConfig(**{key: value for key, value in values.items() if key in allowed})
    model = OrislopAVJointV1(config)
    model._training_config = config.to_dict()
    return model


def save_checkpoint(path: Path, model: OrislopAVJointV1, optimizer: torch.optim.Optimizer, epoch: int, metrics: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    torch.save(
        {
            "modelVersion": "orislop-av-joint-v1",
            "trainedFromScratch": True,
            "modelConfig": getattr(model, "_training_config", asdict(AVJointConfig())),
            "model_state": model.state_dict(),
            "optimizer_state": optimizer.state_dict(),
            "epoch": epoch,
            "metrics": metrics,
        },
        path,
    )


def command_validate_rights(args: argparse.Namespace) -> None:
    report = rights_report(read_jsonl(args.manifest), read_json(args.rights_ledger))
    if args.output:
        write_json(args.output, report)
    print(json.dumps(report, indent=2))
    if not report["passed"]:
        raise SystemExit(2)


def command_train(args: argparse.Namespace) -> None:
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    rights = rights_report(read_jsonl(args.manifest), read_json(args.rights_ledger))
    if not rights["passed"]:
        raise ValueError("Rights validation failed; run validate-rights for details")
    if not args.allow_corpus_smoke and (rights["commercialSpeakers"] < 100 or rights["commercialHours"] < 50):
        raise ValueError("Release training requires at least 100 approved speakers and 50 approved hours")
    if not args.allow_corpus_smoke and not rights["heldOutGeneratorFamilies"]:
        raise ValueError("Release training requires at least one generator family held out exclusively for test")
    device = torch.device(args.device if args.device != "auto" else ("cuda" if torch.cuda.is_available() else "cpu"))
    model = build_model(args.config).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate, weight_decay=args.weight_decay)
    loader = DataLoader(PreparedAVDataset(args.manifest, "train"), batch_size=args.batch_size, shuffle=True, num_workers=args.workers)
    history: list[dict[str, Any]] = []
    for epoch in range(args.epochs):
        model.train()
        total = 0.0
        count = 0
        for raw_batch in loader:
            batch = move_batch(raw_batch, device)
            optimizer.zero_grad(set_to_none=True)
            output = model(batch["mouth_tracks"], batch["waveform"], batch["track_mask"], batch["quality"])
            loss, parts = multitask_loss(output, batch, model.max_offset_frames)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 2.0)
            optimizer.step()
            total += float(loss.detach().cpu())
            count += 1
        metrics = {"epoch": epoch, "loss": total / max(1, count), "parts": parts}
        history.append(metrics)
        save_checkpoint(Path(args.output), model, optimizer, epoch, {"history": history, "rights": rights})
        print(json.dumps(metrics))


def load_checkpoint_model(path: str | Path, device: torch.device) -> OrislopAVJointV1:
    payload = torch.load(path, map_location=device, weights_only=False)
    config = AVJointConfig(**dict(payload.get("modelConfig") or {}))
    model = OrislopAVJointV1(config).to(device)
    model.load_state_dict(payload["model_state"], strict=True)
    return model


@torch.no_grad()
def collect_outputs(model: OrislopAVJointV1, loader: DataLoader, device: torch.device) -> dict[str, np.ndarray]:
    output: dict[str, list[np.ndarray]] = {"logit": [], "label": [], "mask": [], "uncertainty": []}
    model.eval()
    for raw_batch in loader:
        batch = move_batch(raw_batch, device)
        prediction = model(batch["mouth_tracks"], batch["waveform"], batch["track_mask"], batch["quality"])
        output["logit"].append(prediction["joint_forgery_logit"].detach().cpu().numpy().reshape(-1))
        output["label"].append(batch["joint_forgery"].detach().cpu().numpy().reshape(-1))
        output["mask"].append(batch["joint_forgery_mask"].detach().cpu().numpy().reshape(-1))
        output["uncertainty"].append(prediction["uncertainty"].detach().cpu().numpy().reshape(-1))
    return {name: np.concatenate(values) for name, values in output.items()}


def binary_metrics(logits: np.ndarray, labels: np.ndarray, mask: np.ndarray, threshold: float = 0.5) -> dict[str, float | int]:
    valid = mask > 0
    labels = labels[valid].astype(np.int64)
    probabilities = 1.0 / (1.0 + np.exp(-np.clip(logits[valid], -30, 30)))
    predictions = probabilities >= threshold
    positives = labels == 1
    negatives = labels == 0
    true_positive = int(np.sum(predictions & positives))
    false_positive = int(np.sum(predictions & negatives))
    calibration_error = 0.0
    for lower in np.linspace(0.0, 0.9, 10):
        upper = lower + 0.1
        in_bin = (probabilities >= lower) & (probabilities < upper if upper < 1.0 else probabilities <= upper)
        if np.any(in_bin):
            calibration_error += float(np.mean(in_bin)) * abs(
                float(np.mean(probabilities[in_bin])) - float(np.mean(labels[in_bin]))
            )
    return {
        "samples": int(labels.size),
        "recall": true_positive / max(1, int(np.sum(positives))),
        "genuineFalsePositiveRate": false_positive / max(1, int(np.sum(negatives))),
        "accuracy": float(np.mean(predictions == labels)) if labels.size else 0.0,
        "expectedCalibrationError": calibration_error,
    }


@torch.no_grad()
def measure_latency(
    model: OrislopAVJointV1,
    dataset: PreparedAVDataset,
    device: torch.device,
    sample_limit: int,
) -> dict[str, float]:
    timings: dict[str, list[float]] = {"initial": [], "escalated": []}
    model.eval()
    for index in range(min(len(dataset), max(1, sample_limit))):
        sample = move_batch(dataset[index], device)
        for name, frame_limit, audio_limit in (
            ("initial", 50, 32_000),
            ("escalated", 200, 128_000),
        ):
            mouth = sample["mouth_tracks"][:, :, :frame_limit].unsqueeze(0)
            waveform = sample["waveform"][:audio_limit].unsqueeze(0)
            track_mask = sample["track_mask"][:, :frame_limit].unsqueeze(0)
            quality = sample["quality"].unsqueeze(0)
            if device.type == "cuda":
                torch.cuda.synchronize(device)
            started = time.perf_counter()
            model(mouth, waveform, track_mask, quality)
            if device.type == "cuda":
                torch.cuda.synchronize(device)
            timings[name].append((time.perf_counter() - started) * 1000.0)
    return {
        "initialLatencyP95Ms": float(np.percentile(timings["initial"], 95)),
        "escalatedLatencyP95Ms": float(np.percentile(timings["escalated"], 95)),
    }


def command_evaluate(args: argparse.Namespace) -> None:
    device = torch.device(args.device if args.device != "auto" else ("cuda" if torch.cuda.is_available() else "cpu"))
    model = load_checkpoint_model(args.checkpoint, device)
    dataset = PreparedAVDataset(args.manifest, args.split)
    loader = DataLoader(dataset, batch_size=args.batch_size, shuffle=False)
    collected = collect_outputs(model, loader, device)
    metrics = binary_metrics(collected["logit"], collected["label"], collected["mask"], args.threshold)
    metrics.update(measure_latency(model, dataset, device, args.latency_samples))
    metrics.update({"split": args.split, "checkpoint": str(Path(args.checkpoint).resolve())})
    write_json(args.output, metrics)
    print(json.dumps(metrics, indent=2))


def fit_temperature(logits: np.ndarray, labels: np.ndarray, mask: np.ndarray) -> float:
    valid = mask > 0
    logits_tensor = torch.tensor(logits[valid], dtype=torch.float32)
    labels_tensor = torch.tensor(labels[valid], dtype=torch.float32)
    log_temperature = torch.nn.Parameter(torch.zeros(()))
    optimizer = torch.optim.LBFGS([log_temperature], lr=0.1, max_iter=80)

    def closure() -> Tensor:
        optimizer.zero_grad()
        loss = F.binary_cross_entropy_with_logits(logits_tensor / log_temperature.exp().clamp(0.05, 20), labels_tensor)
        loss.backward()
        return loss

    optimizer.step(closure)
    return float(log_temperature.exp().detach().clamp(0.05, 20))


def fit_uncertainty_scale(raw: np.ndarray, logits: np.ndarray, labels: np.ndarray, mask: np.ndarray) -> float:
    valid = mask > 0
    raw = np.clip(raw[valid], 0.0, 20.0)
    probabilities = 1.0 / (1.0 + np.exp(-np.clip(logits[valid], -30, 30)))
    target = np.abs(probabilities - labels[valid])
    candidates = np.logspace(-2, 2, 161)
    losses = [float(np.mean((1.0 - np.exp(-raw / scale) - target) ** 2)) for scale in candidates]
    return float(candidates[int(np.argmin(losses))])


def command_calibrate(args: argparse.Namespace) -> None:
    device = torch.device(args.device if args.device != "auto" else ("cuda" if torch.cuda.is_available() else "cpu"))
    model = load_checkpoint_model(args.checkpoint, device)
    loader = DataLoader(PreparedAVDataset(args.manifest, "val"), batch_size=args.batch_size, shuffle=False)
    collected = collect_outputs(model, loader, device)
    temperature = fit_temperature(collected["logit"], collected["label"], collected["mask"])
    uncertainty_scale = fit_uncertainty_scale(
        collected["uncertainty"], collected["logit"], collected["label"], collected["mask"]
    )
    result = {
        "joint": temperature,
        "sync": 1.0,
        "audio": 1.0,
        "visual": 1.0,
        "active_speaker": 1.0,
        "uncertainty": uncertainty_scale,
    }
    write_json(args.output, result)
    print(json.dumps(result, indent=2))


def command_export(args: argparse.Namespace) -> None:
    device = torch.device("cpu")
    model = load_checkpoint_model(args.checkpoint, device).eval()
    temperatures = read_json(args.temperatures)
    scripted = torch.jit.script(CalibratedAVJointExport(model, temperatures).eval())
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    artifact_path = output_dir / "orislop_av_joint_v1.ts"
    scripted.save(str(artifact_path))
    digest = hashlib.sha256(artifact_path.read_bytes()).hexdigest()
    metadata = {
        "schemaVersion": 1,
        "modelId": "gonnerthetooner/orislop-av-joint",
        "modelVersion": "orislop-av-joint-v1",
        "createdAt": utc_now(),
        "trainedFromScratch": True,
        "sha256": digest,
        "phase2FusionSha256": "",
        "phase2CalibrationSha256": "",
        "integrityVerified": True,
        "promoted": False,
        "temperatures": temperatures,
        "releaseGate": {"passed": False, "metrics": {}},
        "outputContract": [
            "embedding", "logit", "joint_fake_probability", "active_speaker_probability",
            "sync_mismatch_probability", "offset_probabilities", "audio_spoof_probability",
            "visual_forgery_probability", "segment_forgery_probabilities", "uncertainty",
        ],
    }
    write_json(output_dir / "orislop_av_joint_v1.json", metadata)
    print(json.dumps(metadata, indent=2))


def command_release_gate(args: argparse.Namespace) -> None:
    config = read_json(args.config)["rollout"]
    rights = read_json(args.rights_report)
    av = read_json(args.av_metrics)
    fused = read_json(args.fused_metrics)
    shadow = read_json(args.shadow_metrics)
    metrics = {
        "commercialSpeakers": rights.get("commercialSpeakers", 0),
        "commercialHours": rights.get("commercialHours", 0),
        "shadowDecisions": shadow.get("decisions", 0),
        "avRecall": av.get("recall", 0),
        "endToEndRecall": fused.get("recall", 0),
        "genuineHideRate": fused.get("genuineHideRate", 1),
        "expectedCalibrationError": fused.get("expectedCalibrationError", 1),
        "initialLatencyP95Ms": av.get("initialLatencyP95Ms", math.inf),
        "escalatedLatencyP95Ms": av.get("escalatedLatencyP95Ms", math.inf),
    }
    failures = []
    requirements = {
        "commercialSpeakers": (config["minimumCommercialSpeakers"], "min"),
        "commercialHours": (config["minimumCommercialHours"], "min"),
        "shadowDecisions": (config["minimumShadowDecisions"], "min"),
        "avRecall": (config["minimumAvRecall"], "min"),
        "endToEndRecall": (config["minimumEndToEndRecall"], "min"),
        "genuineHideRate": (config["maximumGenuineHideRate"], "max"),
        "expectedCalibrationError": (config["maximumExpectedCalibrationError"], "max"),
        "initialLatencyP95Ms": (config["initialLatencyP95Ms"], "max"),
        "escalatedLatencyP95Ms": (config["escalatedLatencyP95Ms"], "max"),
    }
    for name, (boundary, direction) in requirements.items():
        if (direction == "min" and metrics[name] < boundary) or (direction == "max" and metrics[name] > boundary):
            failures.append(name)
    result = {"passed": not failures, "failures": failures, "metrics": metrics, "evaluatedAt": utc_now()}
    write_json(args.output, result)
    print(json.dumps(result, indent=2))
    if failures:
        raise SystemExit(2)


def command_compare_spatial_experiment(args: argparse.Namespace) -> None:
    baseline = read_json(args.phase2_metrics)
    experiment = read_json(args.spatial_aware_metrics)
    ceiling = float(args.maximum_genuine_hide_rate)
    minimum_gain = float(args.minimum_recall_gain)

    def number(payload: dict[str, Any], name: str, default: float) -> float:
        value = payload.get(name, default)
        return float(value) if isinstance(value, (int, float)) else default

    baseline_recall = number(baseline, "recall", 0.0)
    experiment_recall = number(experiment, "recall", 0.0)
    experiment_false_hides = number(experiment, "genuineHideRate", 1.0)
    failures: list[str] = []
    if experiment_recall <= baseline_recall + minimum_gain:
        failures.append("recall_did_not_improve")
    if experiment_false_hides > ceiling:
        failures.append("genuine_hide_ceiling_exceeded")
    for required in ("latencyP95Ms", "expectedCalibrationError", "heldOutGeneratorRecall"):
        if required not in baseline or required not in experiment:
            failures.append(f"missing_{required}")
    result = {
        "passed": not failures,
        "promoteSpatialAwareFusion": not failures,
        "failures": failures,
        "maximumGenuineHideRate": ceiling,
        "deltas": {
            "recall": round(experiment_recall - baseline_recall, 8),
            "genuineHideRate": round(
                experiment_false_hides - number(baseline, "genuineHideRate", 0.0), 8
            ),
            "latencyP95Ms": round(
                number(experiment, "latencyP95Ms", 0.0) - number(baseline, "latencyP95Ms", 0.0), 4
            ),
            "expectedCalibrationError": round(
                number(experiment, "expectedCalibrationError", 0.0)
                - number(baseline, "expectedCalibrationError", 0.0), 8
            ),
            "heldOutGeneratorRecall": round(
                number(experiment, "heldOutGeneratorRecall", 0.0)
                - number(baseline, "heldOutGeneratorRecall", 0.0), 8
            ),
        },
        "phase2": baseline,
        "spatialAware": experiment,
        "evaluatedAt": utc_now(),
    }
    write_json(args.output, result)
    print(json.dumps(result, indent=2))
    if failures:
        raise SystemExit(2)


def write_synthetic_cache(path: Path, *, fake: float, frames: int = 20) -> None:
    rng = np.random.default_rng(7)
    faces = 2
    np.savez_compressed(
        path,
        mouth_tracks=rng.random((faces, 3, frames, 32, 32), dtype=np.float32),
        waveform=rng.standard_normal(16_000).astype(np.float32) * 0.03,
        track_mask=np.ones((faces, frames), dtype=np.float32),
        quality=np.full((faces, 6), 0.7, dtype=np.float32),
        active_speaker=np.asarray([1, 0], dtype=np.float32),
        active_speaker_mask=np.ones(faces, dtype=np.float32),
        sync_mismatch=np.full(faces, fake, dtype=np.float32),
        sync_mismatch_mask=np.ones(faces, dtype=np.float32),
        audio_spoof=np.full(faces, fake, dtype=np.float32),
        audio_spoof_mask=np.ones(faces, dtype=np.float32),
        visual_forgery=np.full(faces, fake, dtype=np.float32),
        visual_forgery_mask=np.ones(faces, dtype=np.float32),
        joint_forgery=np.full(faces, fake, dtype=np.float32),
        joint_forgery_mask=np.ones(faces, dtype=np.float32),
        offset=np.zeros(faces, dtype=np.int64),
        offset_mask=np.ones(faces, dtype=np.float32),
        segment_forgery=np.full((faces, frames), fake, dtype=np.float32),
        segment_forgery_mask=np.ones((faces, frames), dtype=np.float32),
    )


def command_self_test(_: argparse.Namespace) -> None:
    config = AVJointConfig(embedding_dim=48, transformer_layers=1, transformer_heads=4, max_faces=2)
    model = OrislopAVJointV1(config)
    mouth = torch.rand(1, 2, 3, 20, 32, 32)
    waveform = torch.rand(1, 16_000)
    mask = torch.ones(1, 2, 20)
    quality = torch.rand(1, 2, 6)
    output = model(mouth, waveform, mask, quality)
    batch = {
        name: torch.ones(1, 2) for name in TASKS
    }
    for name in TASKS:
        batch[f"{name}_mask"] = torch.ones(1, 2)
    batch.update({
        "offset": torch.zeros(1, 2, dtype=torch.long),
        "offset_mask": torch.ones(1, 2),
        "segment_forgery": torch.ones(1, 2, 20),
        "segment_forgery_mask": torch.ones(1, 2, 20),
    })
    loss, _ = multitask_loss(output, batch, config.max_offset_frames)
    loss.backward()
    scripted = torch.jit.script(CalibratedAVJointExport(model.eval(), {}).eval())
    exported = scripted(mouth, waveform, mask, quality)
    assert tuple(exported["embedding"].shape) == (1, 2, 48)
    assert torch.isfinite(exported["joint_fake_probability"]).all()
    print("orislop-av-joint-v1 self-test passed")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    rights = commands.add_parser("validate-rights")
    rights.add_argument("--manifest", required=True)
    rights.add_argument("--rights-ledger", required=True)
    rights.add_argument("--output")
    rights.set_defaults(func=command_validate_rights)

    train = commands.add_parser("train")
    train.add_argument("--manifest", required=True)
    train.add_argument("--rights-ledger", required=True)
    train.add_argument("--output", required=True)
    train.add_argument("--config")
    train.add_argument("--epochs", type=int, default=20)
    train.add_argument("--batch-size", type=int, default=4)
    train.add_argument("--workers", type=int, default=2)
    train.add_argument("--learning-rate", type=float, default=2e-4)
    train.add_argument("--weight-decay", type=float, default=1e-4)
    train.add_argument("--device", default="auto")
    train.add_argument("--seed", type=int, default=1337)
    train.add_argument("--allow-corpus-smoke", action="store_true", help="Testing only; exported artifacts still remain unpromoted")
    train.set_defaults(func=command_train)

    evaluate = commands.add_parser("evaluate")
    evaluate.add_argument("--manifest", required=True)
    evaluate.add_argument("--checkpoint", required=True)
    evaluate.add_argument("--output", required=True)
    evaluate.add_argument("--split", choices=("val", "test"), default="test")
    evaluate.add_argument("--threshold", type=float, default=0.5)
    evaluate.add_argument("--batch-size", type=int, default=4)
    evaluate.add_argument("--device", default="auto")
    evaluate.add_argument("--latency-samples", type=int, default=50)
    evaluate.set_defaults(func=command_evaluate)

    calibrate = commands.add_parser("calibrate")
    calibrate.add_argument("--manifest", required=True)
    calibrate.add_argument("--checkpoint", required=True)
    calibrate.add_argument("--output", required=True)
    calibrate.add_argument("--batch-size", type=int, default=4)
    calibrate.add_argument("--device", default="auto")
    calibrate.set_defaults(func=command_calibrate)

    export = commands.add_parser("export")
    export.add_argument("--checkpoint", required=True)
    export.add_argument("--temperatures", required=True)
    export.add_argument("--output-dir", required=True)
    export.set_defaults(func=command_export)

    gate = commands.add_parser("release-gate")
    gate.add_argument("--config", required=True)
    gate.add_argument("--rights-report", required=True)
    gate.add_argument("--av-metrics", required=True)
    gate.add_argument("--fused-metrics", required=True)
    gate.add_argument("--shadow-metrics", required=True)
    gate.add_argument("--output", required=True)
    gate.set_defaults(func=command_release_gate)

    experiment = commands.add_parser("compare-spatial-experiment")
    experiment.add_argument("--phase2-metrics", required=True)
    experiment.add_argument("--spatial-aware-metrics", required=True)
    experiment.add_argument("--output", required=True)
    experiment.add_argument("--minimum-recall-gain", type=float, default=0.0)
    experiment.add_argument("--maximum-genuine-hide-rate", type=float, default=0.001)
    experiment.set_defaults(func=command_compare_spatial_experiment)

    self_test = commands.add_parser("self-test")
    self_test.set_defaults(func=command_self_test)
    return parser


if __name__ == "__main__":
    parsed = build_parser().parse_args()
    parsed.func(parsed)
