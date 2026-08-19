#!/usr/bin/env python3
"""Train Orislop AI Classifier v1.

This is a small dependency-free TF-IDF + logistic-regression trainer.
It exports a JSON model that can run directly in TypeScript/browser code.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import random
import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Sequence, Tuple

SLOP_LABELS = {
    "slop",
    "reddit_story",
    "ai_voice",
    "repost_compilation",
    "scam_bait",
    "brainrot_format",
}

DEFAULT_DATASET = Path("data/slop_training_seed.csv")
DEFAULT_MODEL = Path("models/orislop_ai_classifier_v1.json")
TOKEN_RE = re.compile(r"[a-z0-9][a-z0-9_'-]*")
STOP_WORDS = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "by",
    "for",
    "from",
    "how",
    "i",
    "in",
    "is",
    "it",
    "my",
    "of",
    "on",
    "or",
    "the",
    "this",
    "to",
    "with",
    "you",
    "your",
}


@dataclass
class Example:
    row_id: int
    title: str
    description: str
    channel_name: str
    transcript: str
    duration_seconds: int
    is_short: bool
    heuristic_score: float
    matched_signals: str
    label: str

    @property
    def is_slop(self) -> int:
        return 1 if self.label in SLOP_LABELS else 0


def load_examples(path: Path) -> List[Example]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        examples: List[Example] = []
        for index, row in enumerate(reader):
            examples.append(
                Example(
                    row_id=index,
                    title=row.get("title", ""),
                    description=row.get("description", ""),
                    channel_name=row.get("channelName", ""),
                    transcript=row.get("transcript", ""),
                    duration_seconds=parse_int(row.get("durationSeconds", "")),
                    is_short=parse_bool(row.get("isShort", "")),
                    heuristic_score=parse_float(row.get("heuristicScore", "")),
                    matched_signals=row.get("matchedSignals", ""),
                    label=row.get("label", "").strip(),
                )
            )
    return examples


def parse_int(value: str) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return 0


def parse_float(value: str) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def parse_bool(value: str) -> bool:
    return str(value).strip().lower() in {"true", "1", "yes", "y"}


def normalize(value: str) -> str:
    return re.sub(r"\s+", " ", str(value or "").lower()).strip()


def tokenize(value: str) -> List[str]:
    tokens = [token for token in TOKEN_RE.findall(normalize(value)) if token not in STOP_WORDS and len(token) > 1]
    bigrams = [f"{tokens[index]}_{tokens[index + 1]}" for index in range(len(tokens) - 1)]
    return tokens + bigrams


def example_terms(example: Example) -> List[str]:
    text = " ".join([
        example.title,
        example.description,
        example.channel_name,
        example.transcript,
    ])
    terms = tokenize(text)

    terms.append("__short__" if example.is_short else "__watch__")
    if example.duration_seconds >= 1800:
        terms.append("__duration_long__")
    elif example.duration_seconds <= 75:
        terms.append("__duration_short__")
    else:
        terms.append("__duration_medium__")

    return terms


def build_vocabulary(examples: Sequence[Example], max_features: int) -> List[str]:
    doc_freq: Counter[str] = Counter()
    pos_freq: Counter[str] = Counter()
    neg_freq: Counter[str] = Counter()
    for example in examples:
        seen = set(example_terms(example))
        doc_freq.update(seen)
        if example.is_slop:
            pos_freq.update(seen)
        else:
            neg_freq.update(seen)

    def rank(term: str) -> Tuple[float, int, str]:
        contrast = abs(pos_freq[term] - neg_freq[term])
        return (contrast + doc_freq[term] * 0.35, doc_freq[term], term)

    return sorted(doc_freq, key=rank, reverse=True)[:max_features]


def compute_idf(examples: Sequence[Example], vocabulary: Sequence[str]) -> Dict[str, float]:
    vocab = set(vocabulary)
    doc_freq: Counter[str] = Counter()
    for example in examples:
        doc_freq.update(set(term for term in example_terms(example) if term in vocab))

    total = len(examples)
    return {
        term: math.log((1 + total) / (1 + doc_freq[term])) + 1
        for term in vocabulary
    }


def vectorize(example: Example, vocabulary: Sequence[str], idf: Dict[str, float]) -> Dict[str, float]:
    vocab = set(vocabulary)
    counts = Counter(term for term in example_terms(example) if term in vocab)
    if not counts:
        return {}

    total = sum(counts.values())
    values = {
        term: (count / total) * idf[term]
        for term, count in counts.items()
    }
    norm = math.sqrt(sum(value * value for value in values.values()))
    if norm <= 0:
        return values
    return {term: value / norm for term, value in values.items()}


def sigmoid(value: float) -> float:
    if value >= 0:
        z = math.exp(-value)
        return 1 / (1 + z)
    z = math.exp(value)
    return z / (1 + z)


def train_logistic(
    examples: Sequence[Example],
    vocabulary: Sequence[str],
    idf: Dict[str, float],
    epochs: int,
    learning_rate: float,
    l2: float,
) -> Tuple[Dict[str, float], float]:
    weights = {term: 0.0 for term in vocabulary}
    intercept = 0.0
    vectors = [(vectorize(example, vocabulary, idf), example.is_slop) for example in examples]

    rng = random.Random(860)
    for _epoch in range(epochs):
        rng.shuffle(vectors)
        for features, label in vectors:
            linear = intercept + sum(weights[term] * value for term, value in features.items())
            error = sigmoid(linear) - label
            intercept -= learning_rate * error
            for term, value in features.items():
                weights[term] -= learning_rate * (error * value + l2 * weights[term])

    return weights, intercept


def train_model(
    examples: Sequence[Example],
    max_features: int = 220,
    epochs: int = 850,
    learning_rate: float = 0.45,
    l2: float = 0.0008,
) -> dict:
    positive_examples = sum(example.is_slop for example in examples)
    vocabulary = build_vocabulary(examples, max_features)
    idf = compute_idf(examples, vocabulary)
    weights, intercept = train_logistic(examples, vocabulary, idf, epochs, learning_rate, l2)

    features = [
        {
            "term": term,
            "idf": round(idf[term], 6),
            "weight": round(weights[term], 6),
        }
        for term in vocabulary
        if abs(weights[term]) > 0.00001
    ]

    return {
        "schemaVersion": 1,
        "modelId": "orislop-ai-classifier-v1",
        "modelType": "tfidf_logistic_regression",
        "trainingExamples": len(examples),
        "positiveExamples": positive_examples,
        "negativeExamples": len(examples) - positive_examples,
        "trainedAt": datetime.now(timezone.utc).isoformat(),
        "trainingData": "data/slop_training_seed.csv",
        "positiveClass": "slop",
        "negativeClass": "not_slop",
        "slopThreshold": 0.58,
        "tokenizer": {
            "lowercase": True,
            "pattern": TOKEN_RE.pattern,
            "ngrams": [1, 2],
            "metadataFeatures": [
                "__short__",
                "__watch__",
                "__duration_short__",
                "__duration_medium__",
                "__duration_long__",
            ],
        },
        "intercept": round(intercept, 6),
        "features": features,
        "labelRules": [
            {"label": "reddit_story", "terms": ["reddit", "aita", "story", "stories", "minecraft", "parkour", "text_to"]},
            {"label": "ai_voice", "terms": ["ai", "voice", "synthetic", "tts", "deepfake", "generated"]},
            {"label": "repost_compilation", "terms": ["repost", "compilation", "clips", "source", "unknown", "credit"]},
            {"label": "scam_bait", "terms": ["guaranteed", "banks", "hate", "cure", "miracle", "secret"]},
            {"label": "brainrot_format", "terms": ["brainrot", "subway", "surfers", "split", "screen", "viral"]},
            {"label": "normal_educational", "terms": ["explains", "tutorial", "science", "history", "lesson", "education"]},
            {"label": "normal_creator", "terms": ["original", "creator", "walkthrough", "recipe", "repair", "commentary"]},
        ],
        "notes": [
            "Small seed model. Do not treat probabilities as ground truth.",
            "False positives are expensive for trust; review evaluation false positives before release.",
            "Heuristic scores and matched rule names remain in the dataset for audit, but are excluded from training so the AI score is independent evidence.",
            "Browser-safe inference uses exported TF-IDF weights and a sigmoid.",
        ],
    }


def predict_probability(example: Example, model: dict) -> float:
    vocabulary = [feature["term"] for feature in model["features"]]
    idf = {feature["term"]: feature["idf"] for feature in model["features"]}
    weights = {feature["term"]: feature["weight"] for feature in model["features"]}
    features = vectorize(example, vocabulary, idf)
    linear = model["intercept"] + sum(weights.get(term, 0.0) * value for term, value in features.items())
    return sigmoid(linear)


def write_model(model: dict, output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(model, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, default=DEFAULT_DATASET)
    parser.add_argument("--output", type=Path, default=DEFAULT_MODEL)
    parser.add_argument("--max-features", type=int, default=220)
    parser.add_argument("--epochs", type=int, default=850)
    args = parser.parse_args()

    examples = load_examples(args.input)
    if len(examples) < 20:
        raise SystemExit("Need at least 20 labeled examples to train a useful seed model.")

    model = train_model(examples, max_features=args.max_features, epochs=args.epochs)
    write_model(model, args.output)
    positives = sum(example.is_slop for example in examples)
    print(f"trained {model['modelId']} on {len(examples)} examples ({positives} slop, {len(examples) - positives} not_slop)")
    print(f"wrote {args.output}")


if __name__ == "__main__":
    main()
