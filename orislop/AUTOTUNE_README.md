# First-run full-stack autotuning

Orislop 1.3 measures the real detector on the first representative Heavy video instead of selecting concurrency from GPU marketing specifications alone. The default setting is:

```text
ORISLOP_AUTOTUNE_MODE=first-run
```

The result is stored at `ORISLOP_DETECTOR_CACHE/execution-autotune-v1.json`. In the Vast package that cache lives under `/models/orislop-cache`, so it survives a container restart when `/models` uses persistent instance storage.

## Layouts tested

Subject to live VRAM safety limits, the first run compares:

1. `sequential` — temporal/AV, then all visual components one at a time.
2. `temporal_visual_overlap` — temporal/AV beside the visual bundle.
3. `visual_components_2` — temporal first, then two visual experts at once.
4. `full_overlap_2` — temporal/AV beside two visual experts.
5. `visual_components_3` and `full_overlap_3` — only exposed on GPUs with at least 44 GiB and adequate free headroom.

It performs one unmeasured warm-up, measures each valid layout twice by default, records peak allocated/reserved VRAM, and picks the lowest median wall time.

This is intentionally stricter than choosing the smallest number. A layout is rejected if it:

- raises or internally recovers from CUDA OOM;
- loses temporal, AV, spatial, public-frame, or motion availability;
- changes a detector probability by more than `ORISLOP_AUTOTUNE_OUTPUT_TOLERANCE`;
- fails to complete all configured repeats; or
- runs past the global benchmark budget.

After selection, Orislop runs the winning layout once normally for the user's actual decision. Benchmark probes do not contaminate AV rollout counters.

## Settings

```text
ORISLOP_AUTOTUNE_MODE=first-run  # first-run, always, or off
ORISLOP_AUTOTUNE_REPEATS=2       # 1-3 measured passes per layout
ORISLOP_AUTOTUNE_MAX_SECONDS=240 # 30-1800 second global budget
ORISLOP_AUTOTUNE_WARMUP=1        # unmeasured model/kernel warm-up
ORISLOP_AUTOTUNE_OUTPUT_TOLERANCE=0.002
ORISLOP_AUTOTUNE_RESET=0         # set to 1 for one launch to ignore/replace cache
ORISLOP_AUTOTUNE_CACHE=          # optional explicit JSON path
```

`first-run` is recommended. `always` repeats the full benchmark once after every service restart and will waste time and GPU money. `off` uses the live-headroom heuristic from 1.2. Explicit `ORISLOP_EXECUTION_MODE=sequential` or `concurrent` is treated as a manual override and disables autotuning.

## When the cache is invalidated

The fingerprint covers GPU name/VRAM, CPU count, system RAM, CUDA compute capability, PyTorch/CUDA versions, bridge version, complete-stack revision, promoted Temporal revision/weight hash, AV revision, YuNet hash, upstream expert IDs, and Heavy configuration hash. Any change causes a fresh benchmark automatically.

## Observe the result

```bash
curl -s http://127.0.0.1:4317/health | python -m json.tool
```

Inspect `execution_scheduler.autotune`. It exposes state, fingerprint, selected strategy, per-layout samples, peak VRAM, rejection reasons, and the cache path. Each first-run Heavy result also includes its full benchmark report under `execution.autotune`.

The first Heavy decision will be deliberately slow because it runs multiple complete passes. The extension may retain its fail-open Local Fast result while that benchmark finishes. Later videos use only the winner. Use a normal representative video for the first run—not an unusually tiny, corrupt, or hour-long file.
