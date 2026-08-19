# Joint AV, Temporal MoE, and Spatial Rollout

## Current safety state

The code paths for all three phases are implemented. In the Vast full-stack copy,
joint AV inference is enabled and `/ready` fails unless its real model, YuNet,
and verified Phase 2 artifacts load. Source code still cannot substitute for a
commercially approved 100-speaker/50-hour corpus, trained weights, held-out
evaluation, calibration, or 10,000 real shadow decisions.

Local Fast remains unchanged. Cloud Heavy owns joint AV inference. Missing audio,
no face, closed lips, insufficient visible speech, poor audio, a missing artifact,
an integrity mismatch, an unpromoted checkpoint, a non-English sample, or a failed
runtime gate all abstain or fall back to the existing temporal pipeline.

## Phase 1 — train the joint artifact

Use `training/orislop_av_joint`. It preserves `training/orislop_avsync` as the
baseline and exports a TorchScript model with this stable contract:

- inputs: four bounded lower-face tracks, synchronized 16 kHz mono audio, masks,
  and quality metadata;
- outputs: active speaker, offset/sync mismatch, audio spoof, visual speaking-face
  forgery, joint forgery, forged segments, embedding, and uncertainty.

Run `validate-rights` before preparation or training. Release records must have a
ledger entry explicitly granting commercial use, model training, derivatives,
documented consent, and approval. The trainer blocks fewer than 100 speakers or
50 hours, except for an explicitly non-promotable smoke run.

Legitimate dubbing and ordinary delay must use `sync_mismatch=1` with
`joint_forgery=0`. A synchronization mismatch is not a fake label.

## Phase 2 — retrain Temporal MoE fusion

Add each AV cache to the Temporal MoE JSONL row as `av_prepared_path`, then train
fusion with the joint artifact in the existing `lip_sync` position:

```text
--mode train_stage2
--use-lip true
--lip-checkpoint /models/av/orislop_av_joint_v1.ts
--require-av-context true
--use-spatial false
```

Run Stage 3 calibration against the same expert set. Put the resulting fusion and
calibration artifacts in `ORISLOP_TEMPORAL_AV_FUSION_PATH` and
`ORISLOP_TEMPORAL_AV_CALIBRATION_PATH`. The bridge returns both baseline
`temporal_probability` and spatial-free `temporal_av_probability`.
Record both artifact hashes as `phase2FusionSha256` and
`phase2CalibrationSha256` in the promoted AV metadata; unverified Phase 2 files
remain shadow-only.

YuNet tracks at most four faces. Inference starts at two seconds and escalates to
four or eight seconds only on uncertainty or head disagreement. The popup shows a
short status and expandable scores, offset, localization, gates, and rollout mode.

Automatic filtering remains impossible until the AV metadata is promoted and all
gates pass: >=95% AV recall, >=90% fused recall, <=0.1% genuine hide rate, latency
budgets, <=3% expected calibration error, integrity, corpus requirements, and
>=10,000 shadow decisions. Even then,
an AV/temporal signal requires agreement from the independent `orislop-fusion`
spatial detector.

## Phase 3 — spatial-aware experiment

Only after Phase 2 offline and shadow gates pass, set a dedicated experimental
checkpoint and opt in with:

```text
ORISLOP_EXPERIMENTAL_SPATIAL_TEMPORAL=1
ORISLOP_EXPERIMENTAL_SPATIAL_CHECKPOINT=/models/temporal/spatial-wrapper.pt
```

The bridge emits three distinct values:

- `temporal_probability` / `temporal_av_probability`, excluding spatial;
- top-level independent `spatial.ai_probability`;
- `spatial_aware_fusion_probability`, for experiment reporting only.

The third value is never counted as another vote alongside the same spatial
score. Promotion requires improved held-out-generator recall without exceeding
the 0.1% genuine-hide ceiling or regressing latency/calibration.
Use `train.py compare-spatial-experiment` with Phase 2 and experimental metrics
to record recall, genuine-hide, p95 latency, expected calibration error, and
held-out-generator recall deltas. The command fails unless recall improves and
the genuine-hide ceiling holds.

## Cloud artifact layout

Mount the Compose `orislop-av-artifacts` volume at `/models`, copy reviewed model
files into `/models/av` and `/models/temporal`, then set
`ORISLOP_AV_JOINT_ENABLED=1` (already the Vast default). Do not bake private corpus data or license evidence
into the public image. The bridge verifies the AV SHA-256 against metadata before
the release guard can leave shadow mode.
