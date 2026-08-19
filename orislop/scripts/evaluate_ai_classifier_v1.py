#!/usr/bin/env python3
"""Evaluate Orislop AI Classifier v1 on the seed dataset."""

from __future__ import annotations

import argparse
import importlib.util
import math
import random
import sys
from pathlib import Path
from typing import List, Sequence, Tuple

DEFAULT_DATASET = Path("data/slop_training_seed.csv")
DEFAULT_REPORT = Path("docs/AI_CLASSIFIER_V1_EVAL.md")


def load_training_module():
    script_path = Path(__file__).with_name("train_ai_classifier_v1.py")
    spec = importlib.util.spec_from_file_location("orislop_train_ai_classifier_v1", script_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load training module from {script_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def split_examples(examples: Sequence[object], test_ratio: float, seed: int) -> Tuple[List[object], List[object]]:
    shuffled = list(examples)
    random.Random(seed).shuffle(shuffled)
    test_count = max(1, round(len(shuffled) * test_ratio))
    return shuffled[test_count:], shuffled[:test_count]


def safe_div(numerator: float, denominator: float) -> float:
    return 0.0 if denominator == 0 else numerator / denominator


def format_percent(value: float) -> str:
    return f"{value * 100:.1f}%"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, default=DEFAULT_DATASET)
    parser.add_argument("--output", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--test-ratio", type=float, default=0.28)
    parser.add_argument("--seed", type=int, default=860)
    args = parser.parse_args()

    trainer = load_training_module()
    examples = trainer.load_examples(args.input)
    train, test = split_examples(examples, args.test_ratio, args.seed)
    model = trainer.train_model(train)
    threshold = float(model["slopThreshold"])

    rows = []
    tp = tn = fp = fn = 0
    for example in test:
      probability = trainer.predict_probability(example, model)
      predicted_slop = probability >= threshold
      actual_slop = bool(example.is_slop)
      if predicted_slop and actual_slop:
          tp += 1
      elif predicted_slop and not actual_slop:
          fp += 1
      elif not predicted_slop and actual_slop:
          fn += 1
      else:
          tn += 1
      rows.append((example, probability, predicted_slop, actual_slop))

    total = len(test)
    accuracy = safe_div(tp + tn, total)
    precision = safe_div(tp, tp + fp)
    recall = safe_div(tp, tp + fn)
    f1 = safe_div(2 * precision * recall, precision + recall)
    false_positives = [(example, probability) for example, probability, predicted, actual in rows if predicted and not actual]
    false_negatives = [(example, probability) for example, probability, predicted, actual in rows if not predicted and actual]

    lines = [
        "# Orislop AI Classifier v1 Evaluation",
        "",
        "This report is generated from the starter seed dataset. It is useful for smoke-testing the training path, but it is not a production accuracy claim.",
        "",
        f"- Dataset: `{args.input.as_posix()}`",
        f"- Train examples: {len(train)}",
        f"- Test examples: {len(test)}",
        f"- Threshold: {threshold:.2f}",
        "",
        "## Metrics",
        "",
        f"- Accuracy: {format_percent(accuracy)}",
        f"- Precision: {format_percent(precision)}",
        f"- Recall: {format_percent(recall)}",
        f"- F1: {format_percent(f1)}",
        "",
        "## Confusion Matrix",
        "",
        "| | Predicted slop | Predicted not slop |",
        "| --- | ---: | ---: |",
        f"| Actual slop | {tp} | {fn} |",
        f"| Actual not slop | {fp} | {tn} |",
        "",
        "## False Positives",
        "",
        "False positives are especially dangerous for Orislop because good videos disappear from the user's feed.",
        "",
    ]

    if false_positives:
        lines.extend([
            "| Probability | Label | Title |",
            "| ---: | --- | --- |",
        ])
        for example, probability in false_positives:
            lines.append(f"| {probability:.3f} | {example.label} | {escape_cell(example.title)} |")
    else:
        lines.append("No false positives in this split.")

    lines.extend(["", "## False Negatives", ""])
    if false_negatives:
        lines.extend([
            "| Probability | Label | Title |",
            "| ---: | --- | --- |",
        ])
        for example, probability in false_negatives:
            lines.append(f"| {probability:.3f} | {example.label} | {escape_cell(example.title)} |")
    else:
        lines.append("No false negatives in this split.")

    lines.extend([
        "",
        "## Notes",
        "",
        "- This is a tiny seed dataset; real recall/precision require more labeled examples.",
        "- Review false positives before raising model weight or lowering thresholds.",
        "- The browser and extension use the exported JSON model only; no external API is required.",
        "",
    ])

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text("\n".join(lines), encoding="utf-8")
    print(f"wrote {args.output}")
    print(f"accuracy={accuracy:.3f} precision={precision:.3f} recall={recall:.3f} f1={f1:.3f}")
    print(f"false_positives={len(false_positives)} false_negatives={len(false_negatives)}")


def escape_cell(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", " ")


if __name__ == "__main__":
    main()
