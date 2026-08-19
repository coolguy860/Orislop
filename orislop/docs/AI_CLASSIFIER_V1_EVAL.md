# Orislop AI Classifier v1 Evaluation

This report is generated from the starter seed dataset. It is useful for smoke-testing the training path, but it is not a production accuracy claim.

- Dataset: `data/slop_training_seed.csv`
- Train examples: 80
- Test examples: 31
- Threshold: 0.58

## Metrics

- Accuracy: 100.0%
- Precision: 100.0%
- Recall: 100.0%
- F1: 100.0%

## Confusion Matrix

| | Predicted slop | Predicted not slop |
| --- | ---: | ---: |
| Actual slop | 18 | 0 |
| Actual not slop | 0 | 13 |

## False Positives

False positives are especially dangerous for Orislop because good videos disappear from the user's feed.

No false positives in this split.

## False Negatives

No false negatives in this split.

## Notes

- This is a tiny seed dataset; real recall/precision require more labeled examples.
- Review false positives before raising model weight or lowering thresholds.
- The browser and extension use the exported JSON model only; no external API is required.
