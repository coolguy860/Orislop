# Orislop Temporal MoE retraining on Colab

This workflow retrains the part that currently needs retraining: Stage 2 fusion/router and Stage 3 calibration. It reuses and freezes the four existing temporal experts (`micro`, `mid`, `long`, and corrected `extra_long`). That is faster, cheaper, and safer than retraining the vision backbones from scratch.

Open `orislop_temporal_fusion_v5_colab.ipynb` in Google Colab, choose a T4 GPU, add an `HF_TOKEN` secret with read/write access to the model repository, and run the cells from top to bottom. The notebook installs only the extra dependencies; it keeps Colab's CUDA-enabled PyTorch.

## Build the input dataset first

Use `training/orislop_dataset/build_dataset.py` to validate provenance and
rights, create linked train/validation/test splits, precompute the four frame
views, and package them into tar shards. See
`training/orislop_dataset/README.md` for exact commands and the catalog
contract. The resulting `packaged` directory already contains the
`archive_path` + `member_path` manifests consumed by this retrainer.

For Colab, upload or mount the whole packaged directory, set
`data.local_root` to that directory, leave `data.dataset_repo` empty, and set
the three manifest paths to `manifests/train.jsonl`,
`manifests/validation.jsonl`, and `manifests/test.jsonl`. Do not train from the
included cross-platform shadow seed; its platform references are deliberately
rights-quarantined.

## What the pipeline does

1. Downloads the selected Hugging Face dataset shards to fast Colab storage.
2. Creates separate train, validation, and test manifests and rejects duplicate sample identities across them.
3. Runs each frozen expert once and persists the small embeddings/logits cache to Google Drive.
4. Trains a new fusion/router from the cached expert outputs with class balancing and expert dropout.
5. Fits temperature calibration and selects the automatic-hide threshold using validation only.
6. Evaluates once on the untouched test cache.
7. Produces a hashed deployment bundle and optionally uploads it to Hugging Face.

The full dataset is about 59 GiB before working headroom. Colab needs roughly 68 GiB free in `/content`. The large frame-view shards stay on Colab's local disk; resumable expert outputs and checkpoints live in Drive. If the runtime disconnects after caching, restart at `train` instead of downloading or running the experts again.

## Fast smoke test

In the notebook, set `SMOKE_SHARDS = 1`. This downloads one shard and confirms that the entire pipeline is wired correctly. Smoke results are never production evidence.

For the full run, set `SMOKE_SHARDS = 0` and run:

```bash
python training/orislop_temporal_retrain/colab_retrain.py run \
  --config /content/temporal_fusion_v5_config.json
```

Resume at any stage:

```bash
python training/orislop_temporal_retrain/colab_retrain.py run \
  --config /content/temporal_fusion_v5_config.json \
  --start-at train
```

Valid stages are `prepare`, `validate`, `cache`, `train`, `calibrate`, `evaluate`, and `package`. Use `--stop-after` to stop after a specific stage.

## Optional joint AV expert

Keep `av.enabled` false for this Temporal-only v5 run. After `orislop-av-joint-v1` is trained, add `av_prepared_path` to every manifest row, set `av.enabled` true, and set `av.lip_checkpoint`. AV mode deliberately uses the direct frozen-expert path instead of the four-expert cache because it needs synchronized audio, face tracks, masks, and quality metadata. Spatial remains outside Temporal MoE and is not included in this phase.

## Release safety

The current frame-view dataset has disjoint sample hashes, but its rows do not provide reliable subject/person and generator grouping fields. The validator warns about that because identity- or generator-level leakage cannot yet be ruled out. Confirm the commercial rights and rebuild grouped splits before calling the checkpoint production-trained.

Even when offline gates pass, the generated `release_candidate.json` intentionally sets `productionEligible` to false. Orislop still requires at least 10,000 reviewed shadow decisions, calibration/integrity checks, latency gates, and the 0.1% genuine-hide ceiling before automatic filtering can be enabled.

Run local contract checks with:

```powershell
.\.venv-detector\Scripts\python.exe training\orislop_temporal_retrain\colab_retrain.py self-test
.\.venv-detector\Scripts\python.exe training\orislop_temporal_retrain\tests\test_cached_fusion_pipeline.py
```
