# Orislop complete-stack v10

This is a new copy. The earlier launch folder, the v8 training PYZ, every Google
Drive training run, and the already-published Temporal HF repository remain
untouched.

V10 replaces the stale Hugging Face mirror revision used for YuNet with OpenCV
Zoo's canonical Git LFS object at commit
`f12e12798e8314f7c074a6656816c048dcc95b7a`. The publisher requires exactly
232,589 bytes and SHA-256
`8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4`
before the face detector can enter the release.

Before copying the large model stack, V10 also resolves all six remaining
upstream repositories to full commit SHAs and proves every requested filename
exists. A stale dependency therefore fails in the fast `[preflight]` stage,
not after gigabytes of downloads.

## What “complete” means here

The Colab publisher builds one private HF model repository containing:

- promoted Temporal MoE: micro, mid, long, extra-long, fusion, and temperature;
- the fingerprint-matched trained temporal spatial expert embedded into that
  package as `spatial.stub.*`;
- the fingerprint-matched joint audio/video TorchScript expert;
- the exact stage-two fusion and stage-three calibration states, proven tensor
  for tensor to equal the promoted package;
- YuNet face detection and its MIT provenance;
- the separate deterministic standalone spatial fusion checkpoint;
- pinned lightweight AI-image, ViT, public deepfake-frame, AEGIS motion,
  faster-whisper-tiny, and Qwen 2.5 1.5B Q4_K_M weights;
- the complete extension/server/runtime/training source tree;
- `orislop_retrain_sigkill_safe_v8.pyz` with SHA-256
  `0a22f3bb64042531abcc902d82f7c166298cd239b39b0a365f78fd9da85f9ace`;
- a byte size and SHA-256 for every uploaded file.

The publisher tries two Hugging Face API paths to resolve
`gonnerthetooner/orislop-youtube-prepared-v2` to an immutable dataset commit and
records the result in `MODEL_INVENTORY.json`. If dataset metadata is temporarily
unavailable, that fact and both API errors are recorded without blocking model
publication. It does not duplicate roughly 248 GB of training data into an
inference model repository.

The OpenAI CLIP ViT-B/32 weights are pinned to immutable revision
`3d74acf9a28c67741b2f4f2ea7635f0aaf6f0268` and downloaded from their original
HF repository. They are not copied into your repository because that HF weight
repository does not state an explicit weight license. Therefore the stack is
one-command runnable but intentionally not labeled fully offline.

Packaging also does not falsify release gates. The joint AV model will run in
shadow/testing mode, but automatic actions remain disabled until the commercial
speaker/hour, calibration, false-hide, recall, latency, and shadow-decision
gates actually pass.

## Publish from a fresh Colab runtime

1. Upload `orislop_complete_stack_hf_v10.zip` to `/content`.
2. Open `scripts/COLAB_ONE_CELL_BUILD_PUBLISH_COMPLETE_STACK.py` from this ZIP,
   paste the whole file into one cell, and run it.
3. Enter a Hugging Face write token when prompted.

The default private destination is
`gonnerthetooner/orislop-complete-stack-v1`. The script only reads and hashes
Drive inputs. It stages copies under `/content`; it performs no Drive deletes,
renames, moves, or writes.

The final output prints a full immutable HF revision. Save that revision.

## Start on Vast/RTX 3090 or RTX 5090

This production copy already pins the published revision and manifest receipt.
Provide a newly rotated read-only `HF_TOKEN` through the private instance
environment, then run from the extracted source directory:

```bash
bash scripts/start-vast-extension-test.sh "$PWD"
```

The noninteractive launcher downloads the one HF release resumably, verifies
the full manifest, creates an Ollama model from the bundled verified GGUF, and
starts detached strict full-stack readiness checks. It will refuse startup if
a required artifact or hash is wrong. See `VAST_PRODUCTION_DEPLOY.md` for exact
rental, lifecycle, and private-tunnel commands.

## Model boundaries that must not be confused

- `orislop/spatial/standalone/fusion_model_cls_v2.pt` is the heavyweight frame
  detector used by the server.
- `spatial.stub.*` inside the Temporal MoE is the trained temporal spatial
  expert. It is not a replacement for the standalone checkpoint.
- `orislop/av/orislop_av_joint_v1.ts` is the mouth-track/audio expert.
- `orislop/temporal/phase2_av/*` is the AV-aware fusion/calibration pair. The
  publisher proves these states equal the promoted package before upload.

## Main scripts

- `scripts/colab_build_publish_complete_stack.py`: copy-only Drive assembler,
  verifier, upstream downloader, and HF uploader.
- `scripts/materialize_complete_stack.py`: pinned HF downloader, full hash
  verifier, and model environment generator.
- `scripts/vast3090-complete-bootstrap.sh`: one-command Vast startup.
- `scripts/COLAB_ONE_CELL_BUILD_PUBLISH_COMPLETE_STACK.py`: fresh-Colab
  launcher.
