# Orislop AV Joint v1

This package builds the Phase 1 joint audio-visual expert while preserving
`training/orislop_avsync` as the synchronization-only baseline. The new model
jointly predicts active speaker, AV offset/mismatch, audio spoofing, speaking-face
forgery, forged time segments, final forgery probability, and uncertainty.

## Release safety

Release training is from scratch. `train.py` has no base-checkpoint argument and
refuses a release run unless every release-eligible record is backed by a rights
ledger granting commercial use, model training, derivatives, documented consent,
and approval. It also requires at least 100 distinct speakers and 50 approved
hours unless `--allow-corpus-smoke` is explicitly used for a non-promotable test.

Legitimate dubbing, translation, and ordinary AV delay should be labeled with
`sync_mismatch=1` and `joint_forgery=0`. This teaches the model that a timing
mismatch is a diagnostic, not proof of forgery.

## Workflow

```bash
python training/orislop_av_joint/train.py validate-rights --manifest manifest.jsonl --rights-ledger rights.json
python training/orislop_av_joint/prepare.py --manifest manifest.jsonl --data-root data --output-root prepared --yunet-model face_detection_yunet.onnx
python training/orislop_av_joint/train.py train --manifest prepared/prepared_manifest.jsonl --rights-ledger rights.json --output runs/av_joint.pt
python training/orislop_av_joint/train.py evaluate --manifest prepared/prepared_manifest.jsonl --checkpoint runs/av_joint.pt --output runs/test_metrics.json
python training/orislop_av_joint/train.py calibrate --manifest prepared/prepared_manifest.jsonl --checkpoint runs/av_joint.pt --output runs/temperatures.json
python training/orislop_av_joint/train.py export --checkpoint runs/av_joint.pt --temperatures runs/temperatures.json --output-dir artifacts/av_joint_v1
```

Use a T4 only for `self-test`, data-pipeline smoke tests, and one-batch training.
Use an A100 for real corpus training and calibration. Keep identity, source video,
and generator families disjoint across train/validation/test. Non-English samples
may be evaluated, but remain shadow-only during the English-first beta.

The exporter always writes `promoted: false`. Promotion requires the separate
release gate to pass: AV recall >=95%, fused recall >=90%, genuine hide rate
<=0.1%, latency budgets, rights/corpus requirements, and at least 10,000 shadow
decisions. The bridge independently rechecks that metadata and fails back to
shadow mode.
