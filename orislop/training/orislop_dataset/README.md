# Orislop cross-platform detector dataset

This directory turns an auditable media catalog into leakage-safe train,
validation, and test splits for the Temporal MoE. It deliberately does not
turn arbitrary YouTube, TikTok, or Instagram links into training data. A clip
is eligible only when both its ground-truth label and commercial training
rights are documented.

The included cross-platform seed contains 13 references from the live audit.
They are useful for shadow evaluation, but all are quarantined from training
because Orislop does not own redistribution/training rights to them.

`PRODUCTION_DATASET_PLAN.md` is the go/no-go specification.
`DATASET_SOURCE_AUDIT.md`, `source_registry.json`, and
`generator_registry.json` record which external sources and generators can be
used, which require contracts, and which must stay quarantined. Source or model
status is never inferred from a repository's code license.

The checked-in discovery seed currently contains 300 Wikimedia video
candidates (about 77.3 GiB by source metadata) and 10 NASA video candidates
(about 26.8 GiB). Of the Commons records, 232 passed the default per-file
copyright-license filter. All 310 still have `training_eligible: 0` until
authenticity and personality/consent review is recorded; discovery volume is
not a substitute for ground truth.

## No-Drive web-to-Hugging-Face intake

`hf_web_ingest.py` is the preferred intake path when source media already lives
on approved web endpoints. It uses ephemeral worker storage and a private
Hugging Face dataset instead of Google Drive:

1. Build a deterministic plan of at most 50 GiB and 80 media files per batch.
2. Publish the plan to the private dataset repository.
3. Run worker IDs 0-3 in separate Colab/cloud runtimes.
4. Each worker downloads authorized media concurrently, computes SHA-256,
   uploads media plus catalog/manifest, verifies remote sizes, and uploads
   `BATCH_COMPLETE.json` last.
5. Local media is deleted only after the completion marker is downloaded and
   verified.
6. `finalize` merges batch catalogs, pins each row to its media commit, and
   publishes the final catalog and `DATASET_COMPLETE.json`.

The ready notebook is `orislop_hf_web_ingest_colab.ipynb`. Add a Hugging Face
write token as the private Colab secret `HF_TOKEN`; no Drive mount is used.

```bash
python training/orislop_dataset/hf_web_ingest.py plan \
  --catalog /content/approved-or-quarantine-catalog.jsonl \
  --output-root /content/orislop-hf-plan \
  --repo-id gonnerthetooner/orislop-web-corpus \
  --revision orislop-ingest-v1 --run-id orislop-web-v1 \
  --mode quarantine --workers 4 --max-batch-gib 50 --max-files 80

python training/orislop_dataset/hf_web_ingest.py publish-plan \
  --plan-root /content/orislop-hf-plan

python training/orislop_dataset/hf_web_ingest.py run-worker \
  --plan-root /content/orislop-hf-plan --worker-id 0 \
  --stage-root /content/orislop-hf-stage --download-threads 4

python training/orislop_dataset/hf_web_ingest.py status \
  --plan-root /content/orislop-hf-plan

python training/orislop_dataset/hf_web_ingest.py finalize \
  --plan-root /content/orislop-hf-plan
```

`quarantine` downloads only rows with approved acquisition rights while
preserving provisional/reference labels for review. `production` accepts only
the full production schema. Neither mode downloads media from YouTube, TikTok,
Instagram, or Facebook pages. Those APIs may supply metadata/reference records;
actual bytes require a creator master, official export/open-media API, licensed
Hub file, or authorized direct non-platform endpoint.

## Full rolling build with four workers

The rolling pipeline keeps each raw batch at or below 50 GiB. Four workers
download and precompute different batches, run the same frozen Temporal MoE
experts, and persist hash-verified expert caches to durable storage. Raw media
is deleted only after the durable cache has a `BATCH_COMPLETE.json` marker.
One final job merges those caches and retrains fusion/calibration once.

Do not train four unrelated copies of the fusion model on four data quarters.
That produces incompatible models and invalid global calibration.

### 1. Discover or import candidates

Use official source APIs for discovery:

```powershell
$python = ".\.venv-detector\Scripts\python.exe"

& $python training\orislop_dataset\discover_sources.py wikimedia `
  --category "Videos of interviews" `
  --category "Videos of speeches" `
  --limit-per-category 5000 `
  --output C:\orislop-data\commons-candidates.jsonl

& $python training\orislop_dataset\discover_sources.py nasa `
  --query "interview" --limit 2000 `
  --output C:\orislop-data\nasa-candidates.jsonl
```

These are candidates, not automatically training labels. Review them using a
ledger shaped like `catalogs/review_decisions.example.jsonl`:

```powershell
& $python training\orislop_dataset\discover_sources.py apply-reviews `
  --catalog C:\orislop-data\commons-candidates.jsonl `
  --decisions C:\orislop-data\commons-review-decisions.jsonl `
  --output C:\orislop-data\commons-approved.jsonl
```

Social-platform search scraping and downloading are disabled. A social post is
retained only as `reference_url`; the creator must separately provide a local
master or an authorized direct non-platform file. Import those permission and
media records with `catalogs/youtube_permission_ledger.example.jsonl`:

```powershell
& $python training\orislop_dataset\discover_sources.py permission-urls `
  --ledger C:\orislop-data\creator-media-ledger.jsonl `
  --output C:\orislop-data\creator-approved.jsonl
```

Register synthetic derivatives from an approved generator log. The command
keeps every fake linked to its genuine source so they cannot cross splits:

```powershell
& $python training\orislop_dataset\discover_sources.py generated-outputs `
  --source-catalog C:\orislop-data\owned-approved.jsonl `
  --generation-log C:\orislop-data\generation-log.jsonl `
  --output C:\orislop-data\synthetic-approved.jsonl `
  --require-media
```

Use `catalogs/generation_log.example.jsonl` as the log contract. Generator
weights and code must themselves be commercially approved; the importer
requires a `generator_registry_id`, rejects prohibited or unknown registry
entries, and then requires artifact-specific commercial approval evidence. It
never assumes an open-source code license covers weights, training data,
inputs, outputs, or performer likenesses.

### 2. Combine and create the global leakage-safe split

```powershell
& $python training\orislop_dataset\build_dataset.py combine `
  --catalog C:\orislop-data\owned-approved.jsonl `
  --catalog C:\orislop-data\commons-approved.jsonl `
  --catalog C:\orislop-data\synthetic-approved.jsonl `
  --output C:\orislop-data\production-catalog.jsonl

& $python training\orislop_dataset\build_dataset.py split `
  --catalog C:\orislop-data\production-catalog.jsonl `
  --policy training\orislop_dataset\dataset_policy.json `
  --output-root C:\orislop-data\global-splits
```

The split must happen globally before batching. That keeps the same source,
creator, subject, or generator family from leaking between train, validation,
and test even when different workers handle the files.

### 3. Create 50 GiB batches for four workers

```powershell
& $python training\orislop_dataset\rolling_pipeline.py plan `
  --split-root C:\orislop-data\global-splits `
  --output-root C:\orislop-data\rolling-plan `
  --workers 4 --max-batch-gib 50
```

The plan uses file sizes from source metadata when available and records which
sizes are estimates. Its default working-set recommendation is 1.5 times the
raw batch size because raw media and prepared views briefly coexist.

### 4. Run four Colab workers

Mount the same Google Drive on four runtimes. Give each one a different
`--worker-id` from 0 through 3:

The ready-to-open notebook is
`training/orislop_dataset/orislop_four_worker_rolling_colab.ipynb`.

```bash
python training/orislop_dataset/rolling_pipeline.py run-worker \
  --plan-root /content/drive/MyDrive/orislop-data/rolling-plan \
  --worker-id 0 \
  --stage-root /content/orislop-stage \
  --durable-root /content/drive/MyDrive/orislop-data/durable-caches \
  --base-config training/orislop_temporal_retrain/temporal_fusion_v5_config.example.json \
  --execute --confirm-rights --cleanup
```

Rerunning a worker is safe: completed durable batches are skipped, incomplete
batches resume without being counted as complete.

### 5. Merge caches and train once

After `status` reports `ready_to_merge: true`:

```bash
python training/orislop_dataset/rolling_pipeline.py status \
  --plan-root /content/drive/MyDrive/orislop-data/rolling-plan \
  --durable-root /content/drive/MyDrive/orislop-data/durable-caches

python training/orislop_dataset/rolling_pipeline.py merge-run \
  --plan-root /content/drive/MyDrive/orislop-data/rolling-plan \
  --durable-root /content/drive/MyDrive/orislop-data/durable-caches \
  --output-root /content/drive/MyDrive/orislop-data/merged-expert-cache

python training/orislop_dataset/rolling_pipeline.py render-final-config \
  --base-config training/orislop_temporal_retrain/temporal_fusion_v5_config.example.json \
  --merged-cache /content/drive/MyDrive/orislop-data/merged-expert-cache \
  --run-root /content/drive/MyDrive/orislop-data/final-temporal-run \
  --output /content/drive/MyDrive/orislop-data/final-temporal-config.json

python training/orislop_temporal_retrain/colab_retrain.py run \
  --config /content/drive/MyDrive/orislop-data/final-temporal-config.json \
  --start-at train
```

The final command retrains fusion, calibrates on validation, evaluates once on
the untouched test cache, and builds the deployment bundle.

## Quick start

Use the detector virtual environment when it exists; regular `python` also
works for catalog validation and splitting.

```powershell
$python = ".\.venv-detector\Scripts\python.exe"

& $python training\orislop_dataset\build_dataset.py validate `
  --catalog training\orislop_dataset\catalogs\cross_platform_shadow_seed.jsonl `
  --report .cache\orislop_dataset\shadow_seed_report.json

& $python training\orislop_dataset\build_dataset.py acquire `
  --catalog C:\path\to\approved_training_catalog.jsonl `
  --output-root .cache\orislop_dataset\acquired `
  --execute --confirm-rights

& $python training\orislop_dataset\build_dataset.py split `
  --catalog .cache\orislop_dataset\acquired\acquired_catalog.jsonl `
  --policy training\orislop_dataset\dataset_policy.json `
  --output-root .cache\orislop_dataset\splits `
  --require-media

& $python training\orislop_dataset\build_dataset.py precompute `
  --split-root .cache\orislop_dataset\splits `
  --media-root .cache\orislop_dataset\acquired `
  --output-root .cache\orislop_dataset\prepared

& $python training\orislop_dataset\build_dataset.py pack `
  --prepared-root .cache\orislop_dataset\prepared `
  --output-root .cache\orislop_dataset\packaged
```

Run `acquire` without `--execute` first to produce a dry-run report. Then run
the commands above in order. Acquisition accepts only production-approved
training or safety rows and requires the explicit `--confirm-rights`
acknowledgement. It supports local masters, licensed Hub files, and approved
direct media URLs. It contains no social-platform downloader, cookies, browser
automation, or access-control bypass.

## Catalog contract

Start with `catalogs/training_catalog.example.jsonl`, copy it outside the repo,
and add one JSON object per source segment.

Required for every row:

- `sample_id`: stable, file-safe identity.
- `label`: `0` for genuine or `1` for synthetic/manipulated.
- `platform`: `youtube`, `tiktok`, `instagram`, `local`, `open_dataset`, or
  `generated`.
- `source_path` or `source_url`.
- For licensed private Hub data, `hf_repo_id` plus `hf_path` may replace those;
  pin `hf_revision` for reproducibility.
- `group_id`: groups related originals and derivatives.
- `usage`, `rights_status`, and `label_status`.
- `label_evidence`: human-verifiable provenance, never a detector prediction.

Additional requirements for training and genuine safety evaluation:

- `usage` must be `training` or `safety_eval_only`.
- `authenticity_label`, `media_origin`, `transformation_types`, and
  `sync_status` must agree with the binary label.
- `rights_status` must be `approved`, with structured `rights_evidence`
  explicitly granting download, commercial ML training, derivatives, and
  trained-model distribution.
- Complete and separate `rights_review` and `provenance_review` records.
- `label_status` must be `verified`.
- `acquisition_method` and boolean `contains_identifiable_people`.
- `content_profile`: `short_form_feed`, `general_video`, or `negative_control`.
- Short-form rows also require `primary_feed_context` (`youtube_shorts`,
  `tiktok_feed`, or `instagram_reels`), `visual_format`, `content_styles`, and a
  2-30 second `clip_duration_seconds` value.
- Identifiable people require a performer release; synthetic face/voice use
  requires explicit face-manipulation, voice-clone, and synthetic-media consent.
  The release must also explicitly cover biometric processing, commercial ML
  training, retention, and trained-model distribution. Identifiable minors and
  uncertain-capacity subjects are excluded from the current production corpus.
- Synthetic rows must specify `generator_id` and `generator_family_id`.

Use `source_asset_id` to connect a real clip to all synthetic derivatives.
Use `creator_id`, plus `subject_id`/`person_id`/`identity_id`, `voice_id`, and
`scene_id` when applicable. The splitter joins every connected identifier, so
the same source, creator, person, voice, or scene cannot leak across train,
validation, and test. Put at least two unseen families in
`heldout_generator_family_ids` in `dataset_policy.json`; they are forced into
the sealed test split.

## Labels and evaluation

Do not label a clip fake because the current model predicts fake. Human visual
judgment alone is also insufficient. Verified genuine rows need capture,
creator, approved dataset, government archive, or reviewed open-archive
provenance. Verified synthetic rows need generation logs or separately approved
ground truth. Compression, crops, captions, filters, screen recordings,
legitimate dubbing, and ordinary delay do not change genuine media into fake.

Only validation may choose architecture, calibration, or thresholds. The core
test, held-out generator families, and `safety_eval_only` genuine corpus remain
sealed until the model and thresholds are frozen.

The production policy intentionally requires a large genuine test set. At a
0.1% false-hide ceiling, a tiny test set cannot establish safety. The split
report lists every unmet minimum—including per-feed short-form, vertical-video,
and content-style coverage—and remains `production_ready: false` until all
gates are met. Feed-context tags describe rights-cleared creator masters or
licensed/controlled media; they never enable platform downloading.

## Outputs

- `split`: clean `train.jsonl`, `validation.jsonl`, `test.jsonl`, quarantined
  `reference.jsonl`, and `split_report.json`.
- `precompute`: deterministic `micro`, `mid`, `long`, and `extra_long` uint8
  frame views in compressed NPZ files, plus Temporal MoE manifests.
- `pack`: deterministic tar shards, SHA-256 hashes, and manifests using the
  `archive_path` + `member_path` contract accepted by the Colab retrainer.

Run the local contract tests with:

```powershell
python training\orislop_dataset\build_dataset.py self-test
python training\orislop_dataset\tests\test_build_dataset.py
.\.venv-detector\Scripts\python.exe -m unittest discover -s training\orislop_dataset\tests -p test_*.py -v
```
