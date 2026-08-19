from __future__ import annotations

import argparse
import copy
import json
import math
from pathlib import Path
from typing import Any

import numpy as np
from sklearn.linear_model import LogisticRegression


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = ROOT / "configs" / "cloud_heavy_v1.json"


def probability_logit(values: np.ndarray) -> np.ndarray:
    clipped = np.clip(values.astype(np.float64), 1e-6, 1.0 - 1e-6)
    return np.log(clipped / (1.0 - clipped))


def sigmoid(values: np.ndarray) -> np.ndarray:
    positive = values >= 0
    output = np.empty_like(values, dtype=np.float64)
    output[positive] = 1.0 / (1.0 + np.exp(-values[positive]))
    exp_values = np.exp(values[~positive])
    output[~positive] = exp_values / (1.0 + exp_values)
    return output


def binary_log_loss(labels: np.ndarray, probabilities: np.ndarray) -> float:
    clipped = np.clip(probabilities, 1e-7, 1.0 - 1e-7)
    return float(-(labels * np.log(clipped) + (1.0 - labels) * np.log(1.0 - clipped)).mean())


def fit_temperature(raw_logits: np.ndarray, labels: np.ndarray) -> float:
    candidates = np.geomspace(0.05, 20.0, 600)
    losses = [binary_log_loss(labels, sigmoid(raw_logits / value)) for value in candidates]
    return float(candidates[int(np.argmin(losses))])


def metrics(labels: np.ndarray, predictions: np.ndarray) -> dict[str, float]:
    true_positive = int(np.sum((labels == 1) & predictions))
    false_positive = int(np.sum((labels == 0) & predictions))
    false_negative = int(np.sum((labels == 1) & ~predictions))
    true_negative = int(np.sum((labels == 0) & ~predictions))
    recall = true_positive / max(1, true_positive + false_negative)
    precision = true_positive / max(1, true_positive + false_positive)
    beta_squared = 4.0
    f2 = (1.0 + beta_squared) * precision * recall / max(1e-12, beta_squared * precision + recall)
    return {
        "recall": recall,
        "precision": precision,
        "f2": f2,
        "genuineHideRate": false_positive / max(1, false_positive + true_negative),
    }


def choose_consensus_thresholds(
    labels: np.ndarray,
    spatial: np.ndarray,
    motion: np.ndarray,
    minimum_recall: float,
) -> tuple[float, float, dict[str, float]]:
    spatial_candidates = sorted(set(np.round(np.concatenate(([0.5], spatial)), 4)))
    motion_candidates = sorted(set(np.round(np.concatenate(([0.5], motion)), 4)))
    best: tuple[float, float, dict[str, float]] | None = None
    for spatial_threshold in spatial_candidates:
        for motion_threshold in motion_candidates:
            result = metrics(labels, (spatial >= spatial_threshold) & (motion >= motion_threshold))
            if result["recall"] + 1e-12 < minimum_recall:
                continue
            candidate = (float(spatial_threshold), float(motion_threshold), result)
            if best is None or (result["f2"], -result["genuineHideRate"], spatial_threshold + motion_threshold) > (
                best[2]["f2"], -best[2]["genuineHideRate"], best[0] + best[1]
            ):
                best = candidate
    if best is None:
        raise RuntimeError(f"No two-modality threshold pair reached {minimum_recall:.1%} synthetic recall")
    return best


def load_rows(path: Path) -> list[dict[str, Any]]:
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    if len(rows) < 40:
        raise RuntimeError("Calibration requires at least 40 labeled samples")
    splits = {str(row.get("split") or "") for row in rows}
    if not {"calibration", "validation"}.issubset(splits):
        raise RuntimeError("Every score row needs split=calibration or split=validation, with both splits present")
    for split in ("calibration", "validation"):
        labels = {int(row["label"]) for row in rows if row.get("split") == split}
        if labels != {0, 1}:
            raise RuntimeError(f"{split} must contain both genuine (0) and synthetic (1) labels")
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description="Fit calibration-only Cloud Heavy v1 fusion")
    parser.add_argument("--scores-jsonl", type=Path, required=True)
    parser.add_argument("--base-config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--output", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--provenance-approved", action="store_true")
    args = parser.parse_args()

    rows = load_rows(args.scores_jsonl)
    calibration_rows = [row for row in rows if row.get("split") == "calibration"]
    validation_rows = [row for row in rows if row.get("split") == "validation"]
    calibration_labels = np.asarray([int(row["label"]) for row in calibration_rows], dtype=np.int64)
    calibration_features = np.column_stack((
        probability_logit(np.asarray([float(row["customSpatialProbability"]) for row in calibration_rows])),
        probability_logit(np.asarray([float(row["publicFrameProbability"]) for row in calibration_rows])),
    ))
    calibration_motion = np.asarray([float(row["motionRawLogit"]) for row in calibration_rows])
    logistic = LogisticRegression(C=1e6, solver="lbfgs", max_iter=2000).fit(calibration_features, calibration_labels)
    temperature = fit_temperature(calibration_motion, calibration_labels.astype(np.float64))

    labels = np.asarray([int(row["label"]) for row in validation_rows], dtype=np.int64)
    validation_ids = [
        str(row.get("videoId") or row.get("itemId") or row.get("id") or "").strip()
        for row in validation_rows
    ]
    unique_validation_videos = len({value for value in validation_ids if value})
    human_reviewed_videos = sum(
        row.get("humanReviewed") is True and str(row.get("mediaType") or "").lower() == "video"
        for row in validation_rows
    )
    validation_features = np.column_stack((
        probability_logit(np.asarray([float(row["customSpatialProbability"]) for row in validation_rows])),
        probability_logit(np.asarray([float(row["publicFrameProbability"]) for row in validation_rows])),
    ))
    raw_motion = np.asarray([float(row["motionRawLogit"]) for row in validation_rows])
    spatial_probability = logistic.predict_proba(validation_features)[:, 1]
    motion_probability = sigmoid(raw_motion / temperature)

    config = copy.deepcopy(json.loads(args.base_config.read_text(encoding="utf-8")))
    minimum_recall = float(config["thresholds"]["minimumValidationSyntheticRecall"])
    spatial_threshold, motion_threshold, validation = choose_consensus_thresholds(
        labels, spatial_probability, motion_probability, minimum_recall
    )
    provenance_ok = bool(args.provenance_approved)
    minimum_validation = int(config["thresholds"].get("minimumValidationVideos", 1000))
    minimum_genuine = int(config["thresholds"].get("minimumValidationGenuineVideos", minimum_validation // 2))
    minimum_synthetic = int(config["thresholds"].get("minimumValidationSyntheticVideos", minimum_validation // 2))
    genuine_samples = int(np.sum(labels == 0))
    synthetic_samples = int(np.sum(labels == 1))
    sample_gate = (
        len(validation_rows) >= minimum_validation
        and unique_validation_videos >= minimum_validation
        and genuine_samples >= minimum_genuine
        and synthetic_samples >= minimum_synthetic
        and human_reviewed_videos == len(validation_rows)
    )
    beta_gate = validation["recall"] >= minimum_recall and provenance_ok and sample_gate
    public_gate = beta_gate and validation["genuineHideRate"] <= float(config["thresholds"]["publicGenuineHideCeiling"])
    config["calibrated"] = True
    config["betaGatePassed"] = beta_gate
    config["releaseGatePassed"] = public_gate
    config["calibration"]["spatialLogistic"] = {
        "intercept": float(logistic.intercept_[0]),
        "customCoefficient": float(logistic.coef_[0, 0]),
        "publicCoefficient": float(logistic.coef_[0, 1]),
    }
    config["calibration"]["motionTemperature"] = temperature
    config["thresholds"]["aggressiveSpatial"] = spatial_threshold
    config["thresholds"]["aggressiveMotion"] = motion_threshold
    config["validation"] = {
        **validation,
        "calibrationSamples": len(calibration_rows),
        "validationSamples": len(validation_rows),
        "genuineSamples": genuine_samples,
        "syntheticSamples": synthetic_samples,
        "uniqueVideoSamples": unique_validation_videos,
        "humanReviewedVideoSamples": human_reviewed_videos,
        "minimumValidationVideos": minimum_validation,
        "sampleGatePassed": sample_gate,
        "provenanceApproved": provenance_ok,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "output": str(args.output),
        "betaGatePassed": beta_gate,
        "publicGatePassed": public_gate,
        "thresholds": {"spatial": spatial_threshold, "motion": motion_threshold},
        "validation": validation,
    }, indent=2))


if __name__ == "__main__":
    main()
