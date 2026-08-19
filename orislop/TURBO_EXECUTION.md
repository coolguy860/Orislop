# Orislop 1.3 adaptive execution

Orislop 1.2 preserves the complete Heavy detector and changes how independent work is scheduled. It does not remove experts, frames, temporal views, AV windows, calibration, or corroboration rules to make a benchmark look faster.

## What now overlaps

- The promoted Temporal MoE plus joint AV/lip-sync branch runs beside the visual bundle when live VRAM headroom permits.
- Inside the visual bundle, custom spatial, the pinned public frame detector, and AEGIS motion use independent CUDA streams and a bounded worker pool.
- Spatial CPU auxiliaries run while the GPU CLIP/ViT branch is active.
- The first two-second AV feature preparation begins while temporal views are decoded and scored. Longer four/eight-second AV windows remain conditional.
- Independent spatial and temporal models load together on machines with enough headroom.
- Download workers are selected from live CPU and RAM instead of being fixed at four.
- In Hybrid + explicit Heavy, capable browsers submit Cloud Heavy immediately while local text/context work proceeds. Automatic remains selective so a clear Fast result does not waste a cloud request.

The decode work whose tensor layouts differ is intentionally not aliased. Sharing those buffers without retraining would silently change the promoted model's input contract.

## Resource decisions

The bridge reads current GPU memory before each Heavy job. A typical 24-32 GB GPU gets two top-level lanes when it has safe headroom. Larger GPUs may use three visual component workers. Low headroom forces sequential execution. A CUDA out-of-memory error opens a five-minute circuit breaker, clears the allocator cache, and retries the same full analysis sequentially rather than dropping a model.

Useful environment settings:

```text
ORISLOP_EXECUTION_MODE=auto          # auto, concurrent, or sequential
ORISLOP_GPU_RESERVE_GIB=3.5          # always leave this much VRAM unused
ORISLOP_GPU_RESERVE_FRACTION=0.12    # or this fraction, whichever is larger
ORISLOP_OOM_COOLDOWN_SECONDS=300
ORISLOP_LIGHTWEIGHT_WORKERS=auto
```

`auto` is the recommended mode. With `ORISLOP_AUTOTUNE_MODE=first-run`, live headroom determines which layouts may enter the first-video benchmark and measured median latency selects the winner. Forcing concurrent execution cannot create VRAM and may make a 24 GB card slower through allocator pressure.

## Prove the active path

After startup, inspect:

```bash
curl -s http://127.0.0.1:4317/health | python -m json.tool
```

The `execution_scheduler` object reports the selected mode, current VRAM snapshot, active OOM circuit, and completed/fallback run counts. Each Heavy decision also includes an `execution` block with branch and component timings.

Browser capability hints are deliberately coarse and are not a benchmark. Local preparation is enabled only with at least eight logical cores, adequate reported memory, and no data-saver/2G signal. It is metadata, text, and bounded context preparation; the extension does not secretly download a second full video or decode cross-origin frames on the user's machine.

## Performance boundary

This removes avoidable serialization, but it does not promise sub-second full-video analysis. End-to-end latency still includes the media CDN, bounded download, decode, face/audio extraction, all model branches, and queueing. Use the per-decision timings on the exact rented GPU and representative URLs before quoting latency.
