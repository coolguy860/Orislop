#!/usr/bin/env python3
"""
Temporal Deepfake MoE for Google Colab Pro / Pro+.

This is a single-file, restart-safe PyTorch training script for a streaming
multimodal temporal deepfake detector. It is designed to train from local
Colab paths and/or Hugging Face dataset repositories without decoding or
caching complete datasets in memory.

Typical Colab setup:

    !pip install -U torch torchvision transformers huggingface_hub safetensors \
        opencv-python scikit-learn

Colab Pro A100 scratch-path examples:

    # HF_TOKEN can be set from a Colab secret or directly in the notebook:
    #   import os
    #   os.environ["HF_TOKEN"] = "hf_..."
    #
    # Smoke scan:
    # python /content/temporal_deepfake_moe_hf_colab.py \
    #   --mode scan \
    #   --data-roots \
    #   /mnt/local-scratch/deepfake_moe/data/dfdc \
    #   /mnt/local-scratch/deepfake_moe/data/celebdf \
    #   /mnt/local-scratch/deepfake_moe/data/faceforensics \
    #   /mnt/local-scratch/deepfake_moe/data/deepfake_eval \
    #   --local-cache-dir /mnt/local-scratch/deepfake_moe/cache \
    #   --limit-records 50 \
    #   --rebuild-manifest
    #
    # Micro smoke test:
    # python /content/temporal_deepfake_moe_hf_colab.py \
    #   --mode train_stage1 \
    #   --expert micro \
    #   --data-roots \
    #   /mnt/local-scratch/deepfake_moe/data/dfdc \
    #   /mnt/local-scratch/deepfake_moe/data/celebdf \
    #   /mnt/local-scratch/deepfake_moe/data/faceforensics \
    #   /mnt/local-scratch/deepfake_moe/data/deepfake_eval \
    #   --hf-repo-id USERNAME/deepfake-temporal-moe \
    #   --local-cache-dir /mnt/local-scratch/deepfake_moe/cache \
    #   --limit-records 50 \
    #   --max-steps-per-epoch 5 \
    #   --batch-size 1 \
    #   --grad-accum-steps 2 \
    #   --precision bf16 \
    #   --rebuild-manifest
    #
    # Mid smoke test:
    # python /content/temporal_deepfake_moe_hf_colab.py \
    #   --mode train_stage1 \
    #   --expert mid \
    #   --data-roots \
    #   /mnt/local-scratch/deepfake_moe/data/dfdc \
    #   /mnt/local-scratch/deepfake_moe/data/celebdf \
    #   /mnt/local-scratch/deepfake_moe/data/faceforensics \
    #   /mnt/local-scratch/deepfake_moe/data/deepfake_eval \
    #   --hf-repo-id USERNAME/deepfake-temporal-moe \
    #   --local-cache-dir /mnt/local-scratch/deepfake_moe/cache \
    #   --limit-records 20 \
    #   --max-steps-per-epoch 3 \
    #   --batch-size 1 \
    #   --grad-accum-steps 2 \
    #   --clip-frame-chunk-size 8 \
    #   --freeze-clip \
    #   --precision bf16 \
    #   --rebuild-manifest

The script intentionally persists checkpoints and final artifacts to the
Hugging Face Hub, not Google Drive.

Kaggle credentials are not required by this script. A Kaggle token is only
needed if you separately download datasets with Kaggle's API before running
training. This script reads local paths and Hugging Face dataset repos.
"""

from __future__ import annotations

import argparse
import contextlib
import csv
import dataclasses
from dataclasses import dataclass, field
import datetime as _dt
import gc
import hashlib
import io
import json
import math
import os
from pathlib import Path
import random
import shutil
import statistics
import subprocess
import sys
import threading
import time
import traceback
from typing import Any, Dict, Iterable, Iterator, List, Optional, Sequence, Tuple
import warnings

from final_pipeline_core import (
    CorruptNPZError,
    TarHandleCache,
    WallTimeBudget,
    atomic_write_json,
    bounded_epoch_range,
    decode_npz_bundle,
    decode_npz_views,
    manifest_digest,
)
from full_pipeline_utils import (
    checkpoint_fingerprint,
    compute_binary_metrics,
    recover_completed_cache_shards,
    repeat_cached_probe_batch,
    select_threshold,
    validate_expert_cache,
)

import numpy as np
import torch
from torch import Tensor, nn
import torch.nn.functional as F
from torch.utils.data import DataLoader, IterableDataset, get_worker_info

PACKAGE_ROOT = Path(__file__).resolve().parent.parent
if str(PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(PACKAGE_ROOT))
from unified.resource_autotune import (  # noqa: E402
    autotune_cuda_batch_size,
    configure_torch_for_throughput,
    ram_budgeted_prefetch,
    ram_limited_batch_cap,
    repeat_batch_tree,
    tensor_tree_nbytes,
)

try:
    from tqdm.auto import tqdm as tqdm_auto
except Exception:  # tqdm is optional; plain progress logs still work.
    tqdm_auto = None

try:
    import cv2  # type: ignore

    CV2_AVAILABLE = True
except Exception:
    cv2 = None
    CV2_AVAILABLE = False

try:
    from huggingface_hub import HfApi, create_repo, hf_hub_download, upload_file, upload_folder

    HF_AVAILABLE = True
except Exception:
    HfApi = None
    create_repo = None
    hf_hub_download = None
    upload_file = None
    upload_folder = None
    HF_AVAILABLE = False

try:
    from safetensors.torch import save_file as safetensors_save_file

    SAFETENSORS_AVAILABLE = True
except Exception:
    safetensors_save_file = None
    SAFETENSORS_AVAILABLE = False

try:
    from sklearn.metrics import (
        accuracy_score,
        confusion_matrix,
        f1_score,
        precision_score,
        recall_score,
        roc_auc_score,
    )

    SKLEARN_AVAILABLE = True
except Exception:
    SKLEARN_AVAILABLE = False

try:
    from transformers import CLIPVisionModel

    TRANSFORMERS_AVAILABLE = True
except Exception:
    CLIPVisionModel = None
    TRANSFORMERS_AVAILABLE = False

try:
    import clip as openai_clip  # type: ignore

    OPENAI_CLIP_AVAILABLE = True
except Exception:
    openai_clip = None
    OPENAI_CLIP_AVAILABLE = False


VIDEO_EXTENSIONS = {".mp4", ".avi", ".mov", ".mkv", ".webm", ".m4v"}
MANIFEST_VERSION = 2
DEFAULT_IMAGE_SIZE = 224
EXPERT_ORDER = ["micro", "mid", "long", "extra_long", "spatial", "lip_sync"]
TEMPORAL_EXPERTS = {"mid", "long", "extra_long"}


def default_local_cache_dir() -> str:
    if Path("/mnt/local-scratch").exists():
        return "/mnt/local-scratch/deepfake_moe/cache"
    return "/content/deepfake_moe_cache"


DEFAULT_LOCAL_CACHE = default_local_cache_dir()


# ---------------------------------------------------------------------------
# Configuration and runtime detection
# ---------------------------------------------------------------------------


@dataclass
class RuntimeInfo:
    device: str
    gpu_name: str = "CPU"
    total_vram_gb: float = 0.0
    capability: Tuple[int, int] = (0, 0)
    supports_bf16: bool = False
    recommended_precision: str = "fp32"
    runtime_note: str = ""


@dataclass
class ScriptConfig:
    mode: str
    expert: Optional[str]
    data_roots: List[str] = field(default_factory=list)
    hf_dataset_repos: List[str] = field(default_factory=list)
    hf_repo_id: Optional[str] = None
    hf_token: Optional[str] = None
    hf_private: bool = False
    hf_checkpoint_dir: str = "."
    local_cache_dir: str = DEFAULT_LOCAL_CACHE
    batch_size: int = 1
    grad_accum_steps: int = 4
    precision: str = "auto"
    embedding_dim: int = 256
    clip_frame_chunk_size: Any = "auto"
    freeze_clip: bool = True
    unfreeze_last_clip_block: bool = False
    epochs: int = 3
    fusion_epochs: int = 10
    seed: int = 1337

    @classmethod
    def from_args(cls, args: argparse.Namespace) -> "ScriptConfig":
        return cls(
            mode=args.mode,
            expert=args.expert,
            data_roots=list(args.data_roots or []),
            hf_dataset_repos=list(args.hf_dataset_repos or []),
            hf_repo_id=args.hf_repo_id,
            hf_token=args.hf_token,
            hf_private=bool(args.hf_private),
            hf_checkpoint_dir=args.hf_checkpoint_dir,
            local_cache_dir=args.local_cache_dir,
            batch_size=args.batch_size,
            grad_accum_steps=args.grad_accum_steps,
            precision=args.precision,
            embedding_dim=args.embedding_dim,
            clip_frame_chunk_size=args.clip_frame_chunk_size,
            freeze_clip=bool(args.freeze_clip),
            unfreeze_last_clip_block=bool(args.unfreeze_last_clip_block),
            epochs=args.epochs,
            fusion_epochs=args.fusion_epochs,
            seed=args.seed,
        )


@dataclass
class ExpertOutput:
    name: str
    embedding: Tensor
    logit: Tensor
    confidence: Tensor
    uncertainty: Tensor
    diagnostics: Optional[Dict[str, Tensor]] = None


def timestamp() -> str:
    return _dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def ensure_dir(path: str | Path) -> Path:
    p = Path(path)
    p.mkdir(parents=True, exist_ok=True)
    return p


def json_default(obj: Any) -> Any:
    if dataclasses.is_dataclass(obj):
        return dataclasses.asdict(obj)
    if isinstance(obj, Path):
        return str(obj)
    if isinstance(obj, torch.Tensor):
        return obj.detach().cpu().tolist()
    return str(obj)


def write_json(path: str | Path, obj: Any) -> None:
    ensure_dir(Path(path).parent)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, sort_keys=True, default=json_default)


def safe_config_dict(args: argparse.Namespace) -> Dict[str, Any]:
    config = vars(args).copy()
    config.pop("_wall_budget", None)
    if config.get("hf_token"):
        config["hf_token"] = "***redacted***"
    return config


def resolve_hf_token(value: Optional[str]) -> Optional[str]:
    if value is not None and str(value).strip():
        return str(value).strip()
    return (
        os.environ.get("HF_TOKEN")
        or os.environ.get("HUGGING_FACE_HUB_TOKEN")
        or os.environ.get("HF_HUB_TOKEN")
    )


def configure_cache_environment(local_cache_dir: str) -> None:
    cache_root = ensure_dir(local_cache_dir)
    os.environ.setdefault("HF_HOME", str(cache_root / "hf_home"))
    os.environ.setdefault("HF_HUB_CACHE", str(cache_root / "hf_home" / "hub"))
    os.environ.setdefault("HF_DATASETS_CACHE", str(cache_root / "hf_datasets"))
    os.environ.setdefault("TRANSFORMERS_CACHE", str(cache_root / "transformers"))
    os.environ.setdefault("TORCH_HOME", str(cache_root / "torch"))
    for env_name in ["HF_HOME", "HF_HUB_CACHE", "HF_DATASETS_CACHE", "TRANSFORMERS_CACHE", "TORCH_HOME"]:
        ensure_dir(os.environ[env_name])


def append_jsonl(path: str | Path, obj: Dict[str, Any]) -> None:
    ensure_dir(Path(path).parent)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(obj, default=json_default, sort_keys=True) + "\n")


def set_seed(seed: int) -> None:
    random.seed(seed)
    os.environ["PYTHONHASHSEED"] = str(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def detect_runtime() -> RuntimeInfo:
    if not torch.cuda.is_available():
        return RuntimeInfo(
            device="cpu",
            runtime_note="CPU detected. Use this for metadata scans/debugging only; full training is disabled by default.",
        )
    idx = torch.cuda.current_device()
    props = torch.cuda.get_device_properties(idx)
    gpu_name = torch.cuda.get_device_name(idx)
    total_vram_gb = props.total_memory / (1024**3)
    capability = (props.major, props.minor)
    supports_bf16 = bool(getattr(torch.cuda, "is_bf16_supported", lambda: False)())
    recommended_precision = "bf16" if supports_bf16 else "fp16"
    return RuntimeInfo(
        device="cuda",
        gpu_name=gpu_name,
        total_vram_gb=total_vram_gb,
        capability=capability,
        supports_bf16=supports_bf16,
        recommended_precision=recommended_precision,
        runtime_note=f"CUDA GPU detected: {gpu_name}, {total_vram_gb:.1f} GB VRAM.",
    )


def _gpu_name_has(runtime: RuntimeInfo, token: str) -> bool:
    return token.lower() in runtime.gpu_name.lower()


def apply_device_safe_defaults(args: argparse.Namespace, runtime: RuntimeInfo) -> argparse.Namespace:
    """Mutate argparse defaults based on the detected Colab accelerator."""

    if args.precision == "auto":
        args.precision = runtime.recommended_precision

    # Colab CPU runtimes are suitable for scans and syntax/debugging. Training
    # on CPU is deliberately discouraged because the video path is slow and can
    # make users think a stalled notebook is broken.
    if runtime.device == "cpu":
        args.batch_size = args.batch_size or 1
        args.grad_accum_steps = args.grad_accum_steps or 1
        args.clip_frame_chunk_size = 1 if args.clip_frame_chunk_size == "auto" else args.clip_frame_chunk_size
        args.precision = "fp32"
        return args

    if args.batch_size is None:
        args.batch_size = 1
    if args.grad_accum_steps is None:
        args.grad_accum_steps = 4
    if args.embedding_dim is None:
        args.embedding_dim = 256

    if _gpu_name_has(runtime, "H100"):
        args.batch_size = min(args.batch_size, 2)
        args.grad_accum_steps = max(1, min(args.grad_accum_steps, 2))
        if args.clip_frame_chunk_size == "auto":
            args.clip_frame_chunk_size = 16
        if args.embedding_dim == 256 and args.allow_large_embedding:
            args.embedding_dim = 512
    elif _gpu_name_has(runtime, "A100"):
        args.grad_accum_steps = max(args.grad_accum_steps, 2)
        if args.clip_frame_chunk_size == "auto":
            args.clip_frame_chunk_size = 8
        if args.embedding_dim == 256 and args.allow_large_embedding:
            args.embedding_dim = 512
    elif _gpu_name_has(runtime, "L4"):
        args.batch_size = 1
        args.grad_accum_steps = max(args.grad_accum_steps, 2)
        if args.clip_frame_chunk_size == "auto":
            args.clip_frame_chunk_size = 8 if runtime.total_vram_gb >= 22 else 4
        args.embedding_dim = min(args.embedding_dim, 256)
    elif _gpu_name_has(runtime, "T4"):
        args.batch_size = 1
        args.grad_accum_steps = max(args.grad_accum_steps, 4)
        if args.clip_frame_chunk_size == "auto":
            args.clip_frame_chunk_size = 4
        args.embedding_dim = min(args.embedding_dim, 256)
        args.freeze_clip = True
    elif _gpu_name_has(runtime, "G4"):
        args.batch_size = min(args.batch_size, 2 if runtime.total_vram_gb >= 20 else 1)
        if args.clip_frame_chunk_size == "auto":
            args.clip_frame_chunk_size = 8 if runtime.total_vram_gb >= 20 else 4
        if args.embedding_dim == 256 and args.allow_large_embedding and runtime.total_vram_gb >= 20:
            args.embedding_dim = 512
    else:
        # Unknown CUDA GPU: stay conservative.
        args.batch_size = min(args.batch_size, 1)
        args.grad_accum_steps = max(args.grad_accum_steps, 4)
        if args.clip_frame_chunk_size == "auto":
            args.clip_frame_chunk_size = 4
        args.embedding_dim = min(args.embedding_dim, 256)

    if args.clip_frame_chunk_size == "auto":
        args.clip_frame_chunk_size = 4
    args.clip_frame_chunk_size = max(1, int(args.clip_frame_chunk_size))
    return args


def resolve_autocast_dtype(precision: str) -> Optional[torch.dtype]:
    if precision == "bf16":
        return torch.bfloat16
    if precision == "fp16":
        return torch.float16
    return None


def autocast_context(device: torch.device, precision: str):
    dtype = resolve_autocast_dtype(precision)
    if device.type == "cuda" and dtype is not None:
        return torch.amp.autocast("cuda", dtype=dtype)
    return contextlib.nullcontext()


def make_grad_scaler(device: torch.device, precision: str):
    enabled = device.type == "cuda" and precision == "fp16"
    try:
        return torch.amp.GradScaler("cuda", enabled=enabled)
    except TypeError:
        return torch.cuda.amp.GradScaler(enabled=enabled)


def is_cuda_oom(exc: BaseException) -> bool:
    text = str(exc).lower()
    return isinstance(exc, RuntimeError) and ("out of memory" in text or "cuda error: out of memory" in text)


def cleanup_cuda(every_epoch: bool = False) -> None:
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
        if every_epoch:
            torch.cuda.ipc_collect()


# ---------------------------------------------------------------------------
# Hugging Face Hub storage
# ---------------------------------------------------------------------------


def hf_upload_with_retry(
    op_name: str,
    upload_callable: Any,
    retries: int = 3,
    sleep_seconds: int = 5,
    strict: bool = False,
) -> None:
    last_exc: Optional[BaseException] = None
    for attempt in range(1, retries + 1):
        try:
            upload_callable()
            return
        except Exception as exc:
            last_exc = exc
            print(f"[hf] {op_name} failed on attempt {attempt}/{retries}: {exc}", flush=True)
            if attempt < retries:
                time.sleep(sleep_seconds)
    message = f"[hf] WARNING: {op_name} failed after {retries} attempts; local checkpoint/artifact was kept."
    if strict:
        raise RuntimeError(message) from last_exc
    print(message, flush=True)


class HFStore:
    """Small wrapper around Hugging Face Hub upload/download operations."""

    def __init__(
        self,
        repo_id: Optional[str],
        token: Optional[str],
        private: bool = False,
        checkpoint_dir: str = ".",
        local_cache_dir: str = DEFAULT_LOCAL_CACHE,
        strict_upload: bool = False,
    ) -> None:
        self.repo_id = repo_id
        self.token = token
        self.private = private
        self.checkpoint_dir = checkpoint_dir.strip("/") if checkpoint_dir else "."
        self.local_cache_dir = ensure_dir(local_cache_dir)
        self.strict_upload = strict_upload
        self.enabled = bool(repo_id)
        self.api = HfApi(token=token) if HF_AVAILABLE and repo_id else None

    def require_available(self) -> None:
        if not HF_AVAILABLE:
            raise RuntimeError(
                "huggingface_hub is not installed. In Colab run: "
                "pip install -U huggingface_hub"
            )
        if not self.repo_id:
            raise RuntimeError("--hf-repo-id is required for this Hugging Face operation.")

    def ensure_repo(self) -> None:
        if not self.enabled:
            return
        self.require_available()
        create_repo(  # type: ignore[misc]
            repo_id=self.repo_id,
            token=self.token,
            private=self.private,
            repo_type="model",
            exist_ok=True,
        )

    def remote_path(self, filename: str) -> str:
        filename = filename.replace("\\", "/").lstrip("/")
        if self.checkpoint_dir in ("", "."):
            return filename
        return f"{self.checkpoint_dir}/{filename}"

    def _upload_with_retry(self, op_name: str, func: Any, retries: int = 3, sleep_seconds: int = 5) -> None:
        hf_upload_with_retry(op_name, func, retries=retries, sleep_seconds=sleep_seconds, strict=self.strict_upload)

    def upload_file(self, local_path: str | Path, remote_filename: Optional[str] = None) -> None:
        if not self.enabled:
            return
        self.ensure_repo()
        local_path = Path(local_path)
        if not local_path.exists():
            return
        remote = self.remote_path(remote_filename or local_path.name)
        print(f"[hf] uploading file {local_path} -> {self.repo_id}/{remote}", flush=True)
        self._upload_with_retry(
            f"upload file {remote}",
            lambda: upload_file(  # type: ignore[misc]
                path_or_fileobj=str(local_path),
                path_in_repo=remote,
                repo_id=self.repo_id,
                repo_type="model",
                token=self.token,
            ),
        )

    def upload_folder(self, local_folder: str | Path, remote_folder: str = ".") -> None:
        if not self.enabled:
            return
        self.ensure_repo()
        local_folder = Path(local_folder)
        if not local_folder.exists():
            return
        remote = self.remote_path(remote_folder) if remote_folder not in ("", ".") else self.checkpoint_dir
        remote = None if remote in ("", ".") else remote
        print(f"[hf] uploading folder {local_folder} -> {self.repo_id}/{remote or '.'}", flush=True)
        self._upload_with_retry(
            f"upload folder {remote or '.'}",
            lambda: upload_folder(  # type: ignore[misc]
                folder_path=str(local_folder),
                path_in_repo=remote,
                repo_id=self.repo_id,
                repo_type="model",
                token=self.token,
            ),
        )

    def list_model_files(self) -> List[str]:
        if not self.enabled:
            return []
        self.require_available()
        try:
            return list(self.api.list_repo_files(self.repo_id, repo_type="model"))  # type: ignore[union-attr]
        except Exception as exc:
            print(f"[hf] could not list repo files: {exc}", flush=True)
            return []

    def download_model_file(self, repo_id: str, path_in_repo: str) -> str:
        if not HF_AVAILABLE:
            raise RuntimeError("huggingface_hub is required to download model checkpoints.")
        return hf_hub_download(  # type: ignore[misc]
            repo_id=repo_id,
            filename=path_in_repo,
            repo_type="model",
            token=self.token,
            cache_dir=str(self.local_cache_dir / "hf_model_files"),
        )

    def download_dataset_file(self, repo_id: str, path_in_repo: str) -> str:
        if bool(getattr(self, "strict_local_data", False)):
            raise RuntimeError("strict local-data mode forbids Hugging Face dataset downloads")
        if not HF_AVAILABLE:
            raise RuntimeError("huggingface_hub is required to stream Hugging Face dataset files.")
        return hf_hub_download(  # type: ignore[misc]
            repo_id=repo_id,
            filename=path_in_repo,
            repo_type="dataset",
            token=self.token,
            cache_dir=str(self.local_cache_dir / "hf_dataset_files"),
        )

    def find_remote_checkpoint(self, basename: str) -> Optional[str]:
        """Return a path in repo for basename, respecting --hf-checkpoint-dir."""

        files = self.list_model_files()
        candidates = []
        for f in files:
            if Path(f).name == basename:
                if self.checkpoint_dir in ("", ".") or f.startswith(self.checkpoint_dir.rstrip("/") + "/"):
                    candidates.append(f)
        if not candidates:
            return None
        # Prefer the shortest/root-most path if duplicates exist.
        return sorted(candidates, key=len)[0]


def parse_hf_file_spec(spec: str, default_repo: Optional[str] = None) -> Tuple[str, str]:
    """Parse hf:USER/REPO/path or hf:path using default_repo."""

    payload = spec[3:] if spec.startswith("hf:") else spec
    parts = payload.split("/")
    if len(parts) >= 3:
        repo_id = "/".join(parts[:2])
        path_in_repo = "/".join(parts[2:])
        return repo_id, path_in_repo
    if default_repo:
        return default_repo, payload
    raise ValueError(
        f"Cannot parse Hugging Face file spec {spec!r}. Use hf:USER/REPO/path or provide --hf-repo-id."
    )


def resolve_checkpoint_path(spec: Optional[str], hf: HFStore) -> Optional[str]:
    if not spec:
        return None
    if spec.startswith("hf:"):
        repo_id, path_in_repo = parse_hf_file_spec(spec, hf.repo_id)
        print(f"[hf] downloading checkpoint hf:{repo_id}/{path_in_repo}", flush=True)
        return hf.download_model_file(repo_id, path_in_repo)
    return spec


def checkpoint_basename(stage: str, expert: Optional[str], kind: str) -> str:
    if stage == "stage1":
        if not expert:
            raise ValueError("stage1 checkpoints require an expert name")
        return f"stage1_{expert}_{kind}.pt"
    if stage == "stage2":
        return f"stage2_fusion_{kind}.pt"
    if stage == "stage3":
        return "stage3_calibration.pt"
    return f"{stage}_{kind}.pt"


def state_dict_for_checkpoint(model: nn.Module, include_clip_state: bool = False) -> Dict[str, Tensor]:
    """Move model state to CPU and optionally omit frozen CLIP backbone weights.

    Frozen CLIP weights are recoverable from --clip-model-name and are very
    large. They are omitted by default so epoch-level Hub checkpoints stay
    practical on Colab. If CLIP is unfrozen, pass include_clip_state=True.
    """

    state: Dict[str, Tensor] = {}
    for k, v in model.state_dict().items():
        is_clip_backbone = (
            k.startswith("clip_encoder.model.")
            or ".clip_encoder.model." in k
            or k.startswith("clip_encoder.visual.")
            or ".clip_encoder.visual." in k
        )
        if is_clip_backbone and not include_clip_state:
            continue
        state[k] = v.detach().cpu()
    return state


def save_module_safetensors(model: nn.Module, path: Path, hf: Optional["HFStore"] = None) -> Optional[Path]:
    if not SAFETENSORS_AVAILABLE:
        return None
    state = state_dict_for_checkpoint(model, include_clip_state=False)
    temporary = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    try:
        safetensors_save_file(state, str(temporary))  # type: ignore[misc]
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    if hf is not None:
        hf.upload_file(path, path.name)
    return path


def safe_torch_load(path: str | Path, map_location: str | torch.device = "cpu") -> Any:
    try:
        return torch.load(path, map_location=map_location, weights_only=False)
    except TypeError:
        return torch.load(path, map_location=map_location)


def load_model_state(model: nn.Module, checkpoint: Dict[str, Any], strict: bool = False) -> None:
    state = checkpoint.get("model_state", checkpoint)
    if not strict:
        current = model.state_dict()
        compatible = {}
        skipped_shape = []
        for key, value in state.items():
            if not torch.is_tensor(value):
                continue
            if key in current and tuple(current[key].shape) != tuple(value.shape):
                skipped_shape.append(key)
                continue
            compatible[key] = value
        if skipped_shape:
            print(f"[ckpt] skipped shape-mismatched keys (first 8): {skipped_shape[:8]}", flush=True)
        state = compatible
    missing, unexpected = model.load_state_dict(state, strict=strict)
    if missing:
        print(f"[ckpt] missing keys while loading (first 8): {missing[:8]}", flush=True)
    if unexpected:
        print(f"[ckpt] unexpected keys while loading (first 8): {unexpected[:8]}", flush=True)


def save_checkpoint(
    *,
    path: str | Path,
    stage: str,
    expert: Optional[str],
    epoch: int,
    global_step: int,
    model: nn.Module,
    optimizer: Optional[torch.optim.Optimizer],
    scheduler: Optional[Any],
    scaler: Optional[Any],
    config: Dict[str, Any],
    metrics: Dict[str, Any],
    best_metric: Optional[float],
    include_clip_state: bool,
) -> None:
    ensure_dir(Path(path).parent)
    payload = {
        "stage": stage,
        "expert": expert,
        "epoch": epoch,
        "global_step": global_step,
        "model_state": state_dict_for_checkpoint(model, include_clip_state=include_clip_state),
        "optimizer_state": optimizer.state_dict() if optimizer is not None else None,
        "scheduler_state": scheduler.state_dict() if scheduler is not None and hasattr(scheduler, "state_dict") else None,
        "scaler_state": scaler.state_dict() if scaler is not None and hasattr(scaler, "state_dict") else None,
        "config": config,
        "metrics": metrics,
        "random_seeds": {
            "python_random_state": str(random.getstate()[1][:5]),
            "torch_initial_seed": torch.initial_seed(),
        },
        "best_validation_metric": best_metric,
        "saved_at": timestamp(),
    }
    target = Path(path)
    temporary = target.with_suffix(target.suffix + f".{os.getpid()}.tmp")
    try:
        torch.save(payload, temporary)
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
    print(f"[ckpt] saved {target}", flush=True)


def load_training_checkpoint(
    path: str | Path,
    model: nn.Module,
    optimizer: Optional[torch.optim.Optimizer] = None,
    scheduler: Optional[Any] = None,
    scaler: Optional[Any] = None,
    map_location: str | torch.device = "cpu",
    load_optimizer_state: bool = True,
    load_scheduler_state: bool = True,
    load_scaler_state: bool = True,
) -> Dict[str, Any]:
    checkpoint = safe_torch_load(path, map_location=map_location)
    load_model_state(model, checkpoint, strict=False)
    if optimizer is not None and load_optimizer_state and checkpoint.get("optimizer_state") is not None:
        optimizer.load_state_dict(checkpoint["optimizer_state"])
    elif optimizer is not None and not load_optimizer_state and checkpoint.get("optimizer_state") is not None:
        print("[resume] skipped optimizer state by request; optimizer will restart from current LR", flush=True)
    if (
        scheduler is not None
        and load_scheduler_state
        and checkpoint.get("scheduler_state") is not None
        and hasattr(scheduler, "load_state_dict")
    ):
        scheduler.load_state_dict(checkpoint["scheduler_state"])
    elif scheduler is not None and not load_scheduler_state and checkpoint.get("scheduler_state") is not None:
        print("[resume] skipped scheduler state by request", flush=True)
    if (
        scaler is not None
        and load_scaler_state
        and checkpoint.get("scaler_state") is not None
        and hasattr(scaler, "load_state_dict")
    ):
        scaler.load_state_dict(checkpoint["scaler_state"])
    elif scaler is not None and not load_scaler_state and checkpoint.get("scaler_state") is not None:
        print("[resume] skipped AMP GradScaler state by request", flush=True)
    return checkpoint


def checkpoint_has_zero_training_samples(checkpoint: Dict[str, Any]) -> bool:
    metrics = checkpoint.get("metrics")
    if not isinstance(metrics, dict):
        return False
    train_metrics = metrics.get("train")
    if not isinstance(train_metrics, dict):
        return False
    try:
        return int(train_metrics.get("n", -1) or 0) == 0
    except Exception:
        return False


def count_nonfinite_parameters(module: nn.Module) -> tuple[int, List[str]]:
    total = 0
    bad_names: List[str] = []
    with torch.no_grad():
        for name, param in module.named_parameters():
            if not torch.is_floating_point(param):
                continue
            bad = int((~torch.isfinite(param)).sum().detach().cpu().item())
            if bad:
                total += bad
                if len(bad_names) < 8:
                    bad_names.append(name)
    return total, bad_names


def find_resume_checkpoint(args: argparse.Namespace, hf: HFStore, stage: str, expert: Optional[str]) -> Optional[str]:
    if getattr(args, "resume_policy", "full") == "fresh":
        return None
    if args.resume:
        return resolve_checkpoint_path(args.resume, hf)

    basename = checkpoint_basename(stage, expert, "latest")
    local_path = Path(args.local_cache_dir) / "checkpoints" / basename
    if args.auto_resume and local_path.exists():
        print(f"[resume] found local latest checkpoint: {local_path}", flush=True)
        return str(local_path)

    if args.hf_auto_resume and hf.enabled:
        remote = hf.find_remote_checkpoint(basename)
        if remote:
            print(f"[resume] found Hugging Face latest checkpoint: {hf.repo_id}/{remote}", flush=True)
            return hf.download_model_file(hf.repo_id or "", remote)
    return None


# ---------------------------------------------------------------------------
# Dataset metadata scanning and streaming video dataset
# ---------------------------------------------------------------------------


@dataclass
class VideoRecord:
    video_path: str
    label: int
    dataset: str
    split: str
    duration: Optional[float] = None
    source: str = "local"
    hf_repo: Optional[str] = None
    hf_path: Optional[str] = None
    archive_path: Optional[str] = None
    member_path: Optional[str] = None
    sample_id: Optional[str] = None
    content_sha256: Optional[str] = None
    av_prepared_path: Optional[str] = None

    def to_json(self) -> Dict[str, Any]:
        return dataclasses.asdict(self)

    @classmethod
    def from_json(cls, obj: Dict[str, Any]) -> "VideoRecord":
        member_path = obj.get("member_path", obj.get("npz_member_path", obj.get("member")))
        video_path = obj.get("video_path", obj.get("path", obj.get("npz_path", member_path)))
        if video_path is None:
            raise ValueError("manifest row is missing video_path/path/member_path")
        return cls(
            video_path=str(video_path),
            label=int(obj["label"]),
            dataset=str(obj.get("dataset", "unknown")),
            split=str(obj.get("split", "train")),
            duration=obj.get("duration"),
            source=str(obj.get("source", "local")),
            hf_repo=obj.get("hf_repo"),
            hf_path=obj.get("hf_path"),
            archive_path=obj.get("archive_path"),
            member_path=str(member_path) if member_path is not None else None,
            sample_id=obj.get("sample_id"),
            content_sha256=obj.get("content_sha256", obj.get("npz_sha256", obj.get("sha256"))),
            av_prepared_path=obj.get("av_prepared_path", obj.get("avPreparedPath")),
        )


def stable_fraction(text: str) -> float:
    digest = hashlib.md5(text.encode("utf-8")).hexdigest()
    return int(digest[:8], 16) / 0xFFFFFFFF


def infer_split(path: str) -> str:
    lowered = path.replace("\\", "/").lower()
    parts = lowered.split("/")
    for token in parts:
        if token in {"train", "training"}:
            return "train"
        if token in {"val", "valid", "validation", "dev"}:
            return "val"
        if token in {"test", "testing"}:
            return "test"
    frac = stable_fraction(lowered)
    if frac < 0.80:
        return "train"
    if frac < 0.90:
        return "val"
    return "test"


def infer_dataset_name(root: str, path: str) -> str:
    text = f"{root}/{path}".replace("\\", "/").lower()
    if "dfdc" in text:
        return "dfdc"
    if "faceforensics" in text or "ff++" in text or "ffpp" in text:
        return "faceforensics++"
    if "google_dfd" in text or "google-dfd" in text or "deepfakedetection" in text or "deepfake_detection" in text:
        return "google-dfd"
    if "celeb" in text:
        return "celeb-df-v2"
    if "deepfake-eval" in text or "deepfake_eval" in text or "df-eval" in text:
        return "deepfake-eval"
    return Path(root).name or "unknown"


def infer_label_from_path(path: str) -> Optional[int]:
    lowered = path.replace("\\", "/").lower()
    parts = [p for p in lowered.split("/") if p]
    fake_parts = {
        "fake",
        "fakes",
        "manipulated",
        "manipulation",
        "manipulated_sequences",
        "synthesis",
        "celeb-synthesis",
        "celeb_synthesis",
        "neuraltextures",
        "faceswap",
        "face2face",
        "faceshifter",
        "deepfakes",
        "deepfake_detection",
        "deepfakedetection",
        "google_dfd",
        "google-dfd",
        "fsgan",
    }
    real_parts = {
        "real",
        "authentic",
        "original",
        "original_sequences",
        "youtube-real",
        "youtube_real",
        "celeb-real",
        "celeb_real",
        "actors",
        "youtube",
    }
    # Walk from the filename upward so an explicit /real/ or /fake/ split wins
    # over generic dataset roots such as deepfake_eval.
    for part in reversed(parts):
        normalized_tokens = {tok for tok in part.replace("-", "_").replace(".", "_").split("_") if tok}
        normalized_part = "_".join(part.replace("-", "_").replace(".", "_").split("_"))
        if part in real_parts or normalized_tokens.intersection({"real", "authentic", "original"}):
            return 0
        if part in fake_parts or normalized_tokens.intersection({"fake", "fakes", "manipulated", "synthesis"}):
            return 1
        if normalized_part in fake_parts:
            return 1
        if normalized_part in real_parts:
            return 0
        if part in {"deepfake", "deepfakes"}:
            return 1
    return None


def normalize_label_value(value: Any) -> Optional[int]:
    text = str(value).strip().lower()
    if text in {"0", "real", "r", "false", "no", "authentic", "original"}:
        return 0
    if text in {"1", "fake", "f", "true", "yes", "deepfake", "manipulated", "synthesis"}:
        return 1
    return None


def discover_dfdc_metadata(root: Path) -> Dict[str, int]:
    labels: Dict[str, int] = {}
    for meta_path in root.rglob("metadata.json"):
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
            if not isinstance(meta, dict):
                continue
            for name, item in meta.items():
                label_raw = item.get("label") if isinstance(item, dict) else None
                if label_raw is None:
                    continue
                label = 0 if str(label_raw).upper() == "REAL" else 1
                candidate = (meta_path.parent / name).resolve()
                labels[str(candidate)] = label
                labels[name] = label
        except Exception as exc:
            print(f"[scan] could not parse DFDC metadata {meta_path}: {exc}", flush=True)
    return labels


def discover_csv_metadata(root: Path) -> Dict[str, int]:
    labels: Dict[str, int] = {}
    for csv_path in root.rglob("*.csv"):
        name = csv_path.name.lower()
        if not any(tok in name for tok in ("metadata", "label", "manifest")):
            continue
        try:
            with open(csv_path, "r", encoding="utf-8", newline="") as f:
                reader = csv.DictReader(f)
                fields = [field.lower() for field in (reader.fieldnames or [])]
                if not fields:
                    continue
                path_key = next((k for k in reader.fieldnames or [] if k.lower() in {"path", "video", "video_path", "filename", "file"}), None)
                label_key = next((k for k in reader.fieldnames or [] if k.lower() in {"label", "target", "is_fake", "fake"}), None)
                if not path_key or not label_key:
                    continue
                for row in reader:
                    raw_path = row.get(path_key)
                    raw_label = row.get(label_key)
                    if not raw_path or raw_label is None:
                        continue
                    label = normalize_label_value(raw_label)
                    if label is None:
                        continue
                    labels[str((csv_path.parent / raw_path).resolve())] = label
                    labels[Path(raw_path).name] = label
        except Exception as exc:
            print(f"[scan] could not parse CSV metadata {csv_path}: {exc}", flush=True)
    return labels


def discover_metadata_labels(root: Path) -> Dict[str, int]:
    labels = {}
    labels.update(discover_dfdc_metadata(root))
    labels.update(discover_csv_metadata(root))
    return labels


def label_from_metadata_or_path(path: Path, metadata_labels: Dict[str, int]) -> Optional[int]:
    resolved = str(path.resolve())
    if resolved in metadata_labels:
        return metadata_labels[resolved]
    if path.name in metadata_labels:
        return metadata_labels[path.name]
    return infer_label_from_path(str(path))


def scan_local_root(root: str, limit_records: Optional[int] = None) -> Iterator[VideoRecord]:
    root_path = Path(root)
    if not root_path.exists():
        print(f"[scan] local dataset root missing, skipping: {root}", flush=True)
        return
    metadata_labels = discover_metadata_labels(root_path)
    emitted = 0
    dataset_name = infer_dataset_name(str(root_path), str(root_path))
    for dirpath, _, filenames in os.walk(root_path):
        for filename in filenames:
            suffix = Path(filename).suffix.lower()
            if suffix not in VIDEO_EXTENSIONS:
                continue
            video_path = Path(dirpath) / filename
            label = label_from_metadata_or_path(video_path, metadata_labels)
            if label is None:
                print(f"[scan] label unknown, skipping: {video_path}", flush=True)
                continue
            record = VideoRecord(
                video_path=str(video_path),
                label=int(label),
                dataset=infer_dataset_name(str(root_path), str(video_path)) or dataset_name,
                split=infer_split(str(video_path)),
                duration=None,
                source="local",
            )
            yield record
            emitted += 1
            if limit_records is not None and emitted >= limit_records:
                return


def add_hf_label_keys(labels: Dict[str, int], metadata_file: str, raw_path: str, label: int) -> None:
    raw_path = str(raw_path).replace("\\", "/").lstrip("/")
    parent = str(Path(metadata_file).parent).replace("\\", "/")
    if parent == ".":
        parent = ""
    joined = f"{parent}/{raw_path}".strip("/")
    for key in {raw_path, joined, Path(raw_path).name}:
        if key:
            labels[key.lower()] = int(label)


def parse_hf_json_labels(obj: Any, metadata_file: str) -> Dict[str, int]:
    labels: Dict[str, int] = {}
    if isinstance(obj, dict):
        # DFDC metadata.json format: {"video.mp4": {"label": "REAL", ...}, ...}
        for key, value in obj.items():
            if isinstance(value, dict):
                raw_label = value.get("label", value.get("target", value.get("is_fake", value.get("fake"))))
                raw_path = value.get("video_path", value.get("path", value.get("filename", key)))
            else:
                raw_label = value
                raw_path = key
            label = normalize_label_value(raw_label)
            if label is not None:
                add_hf_label_keys(labels, metadata_file, str(raw_path), label)
    elif isinstance(obj, list):
        for item in obj:
            if not isinstance(item, dict):
                continue
            raw_path = item.get("video_path", item.get("path", item.get("filename", item.get("file", item.get("video")))))
            raw_label = item.get("label", item.get("target", item.get("is_fake", item.get("fake"))))
            label = normalize_label_value(raw_label)
            if raw_path and label is not None:
                add_hf_label_keys(labels, metadata_file, str(raw_path), label)
    return labels


def parse_hf_csv_labels(local_path: str, metadata_file: str) -> Dict[str, int]:
    labels: Dict[str, int] = {}
    try:
        with open(local_path, "r", encoding="utf-8", newline="") as f:
            reader = csv.DictReader(f)
            fieldnames = reader.fieldnames or []
            path_key = next((k for k in fieldnames if k.lower() in {"path", "video", "video_path", "filename", "file"}), None)
            label_key = next((k for k in fieldnames if k.lower() in {"label", "target", "is_fake", "fake"}), None)
            if not path_key or not label_key:
                return labels
            for row in reader:
                raw_path = row.get(path_key)
                label = normalize_label_value(row.get(label_key))
                if raw_path and label is not None:
                    add_hf_label_keys(labels, metadata_file, raw_path, label)
    except Exception as exc:
        print(f"[scan] could not parse HF CSV labels {metadata_file}: {exc}", flush=True)
    return labels


def discover_hf_metadata_labels(repo_id: str, files: Sequence[str], hf: HFStore) -> Dict[str, int]:
    labels: Dict[str, int] = {}
    candidate_files = [
        path
        for path in files
        if Path(path).suffix.lower() in {".json", ".csv"}
        and any(tok in Path(path).name.lower() for tok in ("metadata", "label", "labels", "manifest"))
    ]
    for metadata_file in candidate_files:
        try:
            local_path = hf.download_dataset_file(repo_id, metadata_file)
            suffix = Path(metadata_file).suffix.lower()
            if suffix == ".json":
                with open(local_path, "r", encoding="utf-8") as f:
                    labels.update(parse_hf_json_labels(json.load(f), metadata_file))
            elif suffix == ".csv":
                labels.update(parse_hf_csv_labels(local_path, metadata_file))
        except Exception as exc:
            print(f"[scan] could not load HF metadata {repo_id}/{metadata_file}: {exc}", flush=True)
    if labels:
        print(f"[scan] loaded {len(labels)} HF metadata label keys from {repo_id}", flush=True)
    return labels


def label_from_hf_metadata_or_path(path_in_repo: str, metadata_labels: Dict[str, int]) -> Optional[int]:
    key = path_in_repo.replace("\\", "/").lstrip("/").lower()
    basename = Path(path_in_repo).name.lower()
    if key in metadata_labels:
        return metadata_labels[key]
    if basename in metadata_labels:
        return metadata_labels[basename]
    return infer_label_from_path(path_in_repo)


def balanced_limit_records(records: List[VideoRecord], limit_records: Optional[int]) -> List[VideoRecord]:
    if limit_records is None or len(records) <= limit_records:
        return records
    real = [rec for rec in records if rec.label == 0]
    fake = [rec for rec in records if rec.label == 1]
    if not real or not fake:
        return records[:limit_records]
    half = max(1, limit_records // 2)
    selected = real[:half] + fake[: max(0, limit_records - half)]
    if len(selected) < limit_records:
        selected.extend((real[half:] + fake[max(0, limit_records - half) :])[: limit_records - len(selected)])
    return selected[:limit_records]


def scan_hf_dataset_repo(repo_id: str, hf: HFStore, limit_records: Optional[int] = None) -> Iterator[VideoRecord]:
    if bool(getattr(hf, "strict_local_data", False)):
        raise RuntimeError("strict local-data mode forbids scanning Hugging Face dataset repositories")
    if not HF_AVAILABLE:
        print(f"[scan] huggingface_hub missing; cannot scan dataset repo {repo_id}", flush=True)
        return
    api = HfApi(token=hf.token)
    try:
        files = list(api.list_repo_files(repo_id, repo_type="dataset"))
    except Exception as exc:
        print(f"[scan] could not list HF dataset repo {repo_id}: {exc}", flush=True)
        return

    metadata_labels = discover_hf_metadata_labels(repo_id, files, hf)
    records: List[VideoRecord] = []
    unknown_count = 0
    unknown_preview_limit = 25
    for path_in_repo in files:
        if Path(path_in_repo).suffix.lower() not in VIDEO_EXTENSIONS:
            continue
        label = label_from_hf_metadata_or_path(path_in_repo, metadata_labels)
        if label is None:
            unknown_count += 1
            if unknown_count <= unknown_preview_limit:
                print(f"[scan] label unknown in HF repo, skipping: hf:{repo_id}/{path_in_repo}", flush=True)
            continue
        dataset_name = infer_dataset_name(repo_id, path_in_repo)
        records.append(VideoRecord(
            video_path=f"hf://{repo_id}/{path_in_repo}",
            label=int(label),
            dataset=dataset_name,
            split=infer_split(path_in_repo),
            duration=None,
            source="hf",
            hf_repo=repo_id,
            hf_path=path_in_repo,
        ))
    if unknown_count > unknown_preview_limit:
        print(
            f"[scan] {unknown_count - unknown_preview_limit} additional HF videos had unknown labels in {repo_id}",
            flush=True,
        )
    selected = balanced_limit_records(records, limit_records)
    if records:
        real_count = sum(1 for rec in records if rec.label == 0)
        fake_count = sum(1 for rec in records if rec.label == 1)
        print(
            f"[scan] HF repo {repo_id}: labeled videos real={real_count} fake={fake_count}; emitting {len(selected)}",
            flush=True,
        )
    for record in selected:
        yield record


def manifest_paths(args: argparse.Namespace) -> Tuple[Path, Path]:
    root = ensure_dir(Path(args.local_cache_dir) / "manifests")
    manifest_path = root / "deepfake_manifest.jsonl"
    stats_path = root / "deepfake_manifest_stats.json"
    return manifest_path, stats_path


def manifest_metadata(args: argparse.Namespace) -> Dict[str, Any]:
    return {
        "manifest_version": MANIFEST_VERSION,
        "data_roots": [str(Path(root)) for root in (args.data_roots or [])],
        "hf_dataset_repos": list(args.hf_dataset_repos or []),
        "precomputed_manifest": str(args.precomputed_manifest) if getattr(args, "precomputed_manifest", None) else None,
        "precomputed_root": str(args.precomputed_root) if getattr(args, "precomputed_root", None) else None,
        "validation_manifest": str(args.validation_manifest) if getattr(args, "validation_manifest", None) else None,
        "validation_root": str(args.validation_root) if getattr(args, "validation_root", None) else None,
        "test_manifest": str(args.test_manifest) if getattr(args, "test_manifest", None) else None,
        "test_root": str(args.test_root) if getattr(args, "test_root", None) else None,
        "limit_records": args.limit_records,
    }


def manifest_fingerprint(args: argparse.Namespace) -> str:
    payload = json.dumps(manifest_metadata(args), sort_keys=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def count_manifest(manifest_path: Path) -> Dict[str, Any]:
    stats: Dict[str, Any] = {
        "total": 0,
        "by_split": {},
        "by_dataset": {},
        "by_label": {"0": 0, "1": 0},
        "by_split_dataset": {},
        "by_split_label": {},
    }
    if not manifest_path.exists():
        return stats
    with open(manifest_path, "r", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            obj = json.loads(line)
            split = str(obj.get("split", "train"))
            dataset = str(obj.get("dataset", "unknown"))
            label = str(int(obj.get("label", 0)))
            stats["total"] += 1
            stats["by_split"][split] = stats["by_split"].get(split, 0) + 1
            stats["by_dataset"][dataset] = stats["by_dataset"].get(dataset, 0) + 1
            stats["by_label"][label] = stats["by_label"].get(label, 0) + 1
            stats["by_split_dataset"].setdefault(split, {})
            stats["by_split_dataset"][split][dataset] = stats["by_split_dataset"][split].get(dataset, 0) + 1
            stats["by_split_label"].setdefault(split, {"0": 0, "1": 0})
            stats["by_split_label"][split][label] = stats["by_split_label"][split].get(label, 0) + 1
    return stats


def build_manifest(args: argparse.Namespace, hf: HFStore) -> Tuple[Path, Dict[str, Any]]:
    if getattr(args, "precomputed_manifest", None):
        manifest_path = Path(args.precomputed_manifest)
        if not manifest_path.exists():
            raise FileNotFoundError(f"--precomputed-manifest not found: {manifest_path}")
        stats = count_manifest(manifest_path)
        stats.update(manifest_metadata(args))
        stats["manifest_fingerprint"] = manifest_fingerprint(args)
        stats["created_at"] = timestamp()
        print(f"[scan] using precomputed manifest {manifest_path} with {stats.get('total', 0)} records", flush=True)
        return manifest_path, stats

    manifest_path, stats_path = manifest_paths(args)
    expected_fingerprint = manifest_fingerprint(args)
    if manifest_path.exists() and stats_path.exists() and not args.rebuild_manifest:
        try:
            with open(stats_path, "r", encoding="utf-8") as f:
                stats = json.load(f)
            cached_fingerprint = stats.get("manifest_fingerprint")
            if cached_fingerprint == expected_fingerprint:
                print(f"[scan] using cached manifest {manifest_path} with {stats.get('total', 0)} records", flush=True)
                return manifest_path, stats
            print("[scan] cached manifest inputs changed; rebuilding automatically", flush=True)
        except Exception:
            pass

    ensure_dir(manifest_path.parent)
    print("[scan] building lightweight manifest; videos are not decoded during this step", flush=True)
    total = 0
    with open(manifest_path, "w", encoding="utf-8") as out:
        for root in args.data_roots or []:
            for rec in scan_local_root(root, args.limit_records):
                out.write(json.dumps(rec.to_json(), sort_keys=True) + "\n")
                total += 1
        for repo_id in args.hf_dataset_repos or []:
            for rec in scan_hf_dataset_repo(repo_id, hf, args.limit_records):
                out.write(json.dumps(rec.to_json(), sort_keys=True) + "\n")
                total += 1
    stats = count_manifest(manifest_path)
    stats.update(manifest_metadata(args))
    stats["manifest_fingerprint"] = expected_fingerprint
    stats["created_at"] = timestamp()
    write_json(stats_path, stats)
    print(f"[scan] wrote {total} records to {manifest_path}", flush=True)
    return manifest_path, stats


def acceptance_probability_for_dataset(stats: Dict[str, Any], split: str, dataset: str) -> float:
    by_dataset = stats.get("by_split_dataset", {}).get(split, {})
    if not by_dataset:
        return 1.0
    counts = [c for c in by_dataset.values() if c > 0]
    if not counts:
        return 1.0
    min_count = min(counts)
    count = by_dataset.get(dataset, min_count)
    return min(1.0, float(min_count) / max(1.0, float(count)))


def ensure_split_has_records(args: argparse.Namespace, stats: Dict[str, Any], split: str) -> str:
    external_manifest = None
    if split == "val":
        external_manifest = getattr(args, "validation_manifest", None)
    elif split == "test":
        external_manifest = getattr(args, "test_manifest", None)
    if external_manifest:
        external_stats = count_manifest(Path(external_manifest))
        external_count = int(external_stats.get("by_split", {}).get(split, 0))
        if external_count <= 0:
            raise RuntimeError(
                f"fixed {split} manifest has zero {split!r} records: {external_manifest}"
            )
        return split
    count = int(stats.get("by_split", {}).get(split, 0))
    if count > 0:
        return split
    if args.limit_records is not None:
        train_count = int(stats.get("by_split", {}).get("train", 0))
        if train_count > 0:
            print(
                f"[split] WARNING: eval split {split!r} has zero records in this limited smoke manifest; "
                "falling back to 'train'.",
                flush=True,
            )
            return "train"
    raise RuntimeError(
        f"Validation/eval split {split!r} has zero records. Fix the manifest/split layout "
        "or add explicit train/val/test directories before real training."
    )


def dataset_to_id_from_stats(stats: Dict[str, Any]) -> Dict[str, int]:
    names = sorted(str(name) for name in stats.get("by_dataset", {}).keys())
    return {name: idx for idx, name in enumerate(names)}


def resolve_record_video_path(record: VideoRecord, hf: HFStore) -> Optional[str]:
    if record.source == "local":
        return record.video_path
    if record.source == "hf":
        if bool(getattr(hf, "strict_local_data", False)):
            raise RuntimeError("strict local-data mode forbids Hugging Face dataset downloads")
        if not record.hf_repo or not record.hf_path:
            return None
        return hf.download_dataset_file(record.hf_repo, record.hf_path)
    return record.video_path


def resolve_precomputed_view_path(
    record: VideoRecord,
    args: argparse.Namespace,
    root_override: Optional[str | Path] = None,
) -> Path:
    path = Path(record.video_path)
    if path.is_absolute():
        return path
    root = Path(root_override or getattr(args, "precomputed_root", "") or ".")
    return root / path


def is_precomputed_view_record(record: VideoRecord, args: argparse.Namespace) -> bool:
    """Return True when a manifest row points at a prepared frame-view file.

    Prepared repos may use sources such as "precomputed", "precomputed_balanced",
    or future names. The file extension is the most reliable signal because the
    training loader must never hand a .npz frame-view artifact to OpenCV.
    """

    if record.archive_path and record.member_path:
        return True
    source = str(record.source or "").strip().lower()
    if source.startswith("precomputed"):
        return True
    path = str(record.video_path or "").strip().lower()
    if path.endswith(".npz"):
        return True
    return bool(getattr(args, "precomputed_manifest", None) and path.endswith((".npz", ".npy")))


def view_frame_count(view: str, args: argparse.Namespace) -> int:
    if view == "micro":
        return int(args.micro_frames)
    if view == "mid":
        return int(args.mid_frames)
    if view == "long":
        return int(args.long_frames)
    if view == "extra_long":
        return int(args.extra_long_frames)
    if view == "spatial":
        return int(args.spatial_frames)
    raise ValueError(f"unknown view {view}")


def sample_indices(
    total_frames: int,
    view: str,
    num_frames: int,
    train: bool,
    rng: random.Random,
) -> List[int]:
    total_frames = max(1, int(total_frames))
    if view == "micro":
        # High-frequency window: consecutive or near-consecutive frames.
        stride = 1 if total_frames < num_frames * 2 else rng.choice([1, 1, 2]) if train else 1
        span = max(1, (num_frames - 1) * stride + 1)
        if train and total_frames > span:
            start = rng.randint(0, total_frames - span)
        else:
            start = max(0, (total_frames - span) // 2)
        return [min(total_frames - 1, start + i * stride) for i in range(num_frames)]

    if view in {"mid", "long", "extra_long", "spatial"}:
        if num_frames <= 1:
            return [total_frames // 2]
        positions = torch.linspace(0, total_frames - 1, num_frames).tolist()
        if train and total_frames > num_frames:
            stride = max(1.0, total_frames / float(num_frames))
            jitter = min(stride * 0.35, 3.0)
            positions = [min(total_frames - 1, max(0, p + rng.uniform(-jitter, jitter))) for p in positions]
        return [int(round(p)) for p in positions]

    raise ValueError(f"unknown sampling view {view}")


def preprocess_frame_bgr(frame: Any, image_size: int) -> Tensor:
    if frame is None:
        raise ValueError("cannot preprocess an empty frame")
    frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    if frame.shape[0] != image_size or frame.shape[1] != image_size:
        frame = cv2.resize(frame, (image_size, image_size), interpolation=cv2.INTER_AREA)
    tensor = torch.from_numpy(frame).permute(2, 0, 1).contiguous().float().div_(255.0)
    return tensor


def try_read_seek_frame(cap: Any, idx: int, total_frames: int, image_size: int) -> Optional[Tensor]:
    for offset in [0, -2, -1, 1, 2]:
        candidate = max(0, min(max(0, total_frames - 1), int(idx) + offset))
        cap.set(cv2.CAP_PROP_POS_FRAMES, candidate)
        ok, frame = cap.read()
        if ok and frame is not None:
            return preprocess_frame_bgr(frame, image_size)
    return None


def read_small_sequential_fallback(cap: Any, image_size: int, max_frames: int) -> List[Tensor]:
    frames: List[Tensor] = []
    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
    for _ in range(max(1, max_frames)):
        ok, frame = cap.read()
        if not ok or frame is None:
            break
        frames.append(preprocess_frame_bgr(frame, image_size))
    return frames


def decode_video_views(
    video_path: str,
    required_views: Sequence[str],
    args: argparse.Namespace,
    train: bool,
    rng: random.Random,
) -> Optional[Dict[str, Tensor]]:
    """Decode only the sampled frames for required views.

    This function never decodes a whole video into memory. It seeks to the
    requested frame indices and returns CPU tensors shaped [T, 3, H, W].
    """

    if not CV2_AVAILABLE:
        raise RuntimeError("opencv-python is required for streaming video decode. Install opencv-python in Colab.")
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"[decode] could not open video, skipping: {video_path}", flush=True)
        return None
    try:
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        max_required_frames = max(view_frame_count(view, args) for view in required_views) if required_views else 1
        sequential_fallback: Optional[List[Tensor]] = None
        if total_frames <= 1:
            sequential_fallback = read_small_sequential_fallback(
                cap,
                int(args.image_size),
                max_frames=min(64, max(16, max_required_frames * 2)),
            )
            total_frames = max(1, len(sequential_fallback))
        indices_by_view: Dict[str, List[int]] = {}
        unique_indices: List[int] = []
        for view in required_views:
            n = view_frame_count(view, args)
            idxs = sample_indices(total_frames, view, n, train=train, rng=rng)
            indices_by_view[view] = idxs
            unique_indices.extend(idxs)

        frame_cache: Dict[int, Tensor] = {}
        last_good: Optional[Tensor] = None
        for idx in sorted(set(unique_indices)):
            if sequential_fallback:
                tensor = sequential_fallback[min(idx, len(sequential_fallback) - 1)]
            else:
                tensor = try_read_seek_frame(cap, idx, total_frames, int(args.image_size))
            if tensor is None:
                if last_good is not None:
                    frame_cache[idx] = last_good.clone()
                    continue
                sequential_fallback = read_small_sequential_fallback(
                    cap,
                    int(args.image_size),
                    max_frames=min(64, max(16, max_required_frames * 2)),
                )
                if sequential_fallback:
                    tensor = sequential_fallback[min(idx, len(sequential_fallback) - 1)]
                else:
                    print(f"[decode] failed to read frames, skipping: {video_path}", flush=True)
                    return None
            frame_cache[idx] = tensor
            last_good = tensor

        views: Dict[str, Tensor] = {}
        for view, idxs in indices_by_view.items():
            frames = [frame_cache.get(i, last_good) for i in idxs]
            if any(f is None for f in frames):
                return None
            views[view] = torch.stack([f for f in frames if f is not None], dim=0)
        return views
    finally:
        cap.release()


def load_precomputed_views(
    record: VideoRecord,
    required_views: Sequence[str],
    args: argparse.Namespace,
    *,
    root_override: Optional[str | Path] = None,
    tar_reader: Optional[TarHandleCache] = None,
) -> Optional[Dict[str, Tensor]]:
    identity: str
    try:
        if record.archive_path and record.member_path:
            if tar_reader is None:
                raise RuntimeError("tar-backed record requires a process-local TarHandleCache")
            identity = f"{record.archive_path}:{record.member_path}"
            payload = tar_reader.read_member(record.archive_path, record.member_path)
            arrays = decode_npz_views(payload, required_views, identity=identity)
        else:
            path = resolve_precomputed_view_path(record, args, root_override=root_override)
            identity = str(path)
            if not path.exists():
                print(f"[precomputed] missing view file, skipping: {path}", flush=True)
                return None
            with path.open("rb") as handle:
                payload = handle.read()
            arrays = decode_npz_views(payload, required_views, identity=identity)
        views: Dict[str, Tensor] = {
            view: prepare_precomputed_view_tensor(arrays[view], args)
            for view in required_views
        }
        return views
    except Exception as exc:
        print(f"[precomputed] failed to load {record.video_path}: {exc}", flush=True)
        return None


def prepare_precomputed_view_tensor(array: Any, args: argparse.Namespace) -> Tensor:
    """Normalize channel order/range and match the configured model image size."""

    tensor = torch.from_numpy(array)
    if tensor.ndim != 4:
        raise ValueError(f"precomputed view must be rank 4, got {tuple(tensor.shape)}")
    if tensor.shape[-1] == 3:
        tensor = tensor.permute(0, 3, 1, 2).contiguous()
    if tensor.shape[1] != 3:
        raise ValueError(f"precomputed view must have three RGB channels, got {tuple(tensor.shape)}")
    if torch.is_floating_point(tensor):
        tensor = tensor.float()
    else:
        tensor = tensor.float().div_(255.0)
    image_size = int(args.image_size)
    if tuple(tensor.shape[-2:]) != (image_size, image_size):
        tensor = F.interpolate(
            tensor,
            size=(image_size, image_size),
            mode="bilinear",
            align_corners=False,
        )
    return tensor.contiguous()


def load_precomputed_bundle(
    record: VideoRecord,
    required_views: Sequence[str],
    args: argparse.Namespace,
    *,
    include_av: bool,
    root_override: Optional[str | Path] = None,
    tar_reader: Optional[TarHandleCache] = None,
) -> Optional[Dict[str, Any]]:
    """Load a legacy or compact-v2 NPZ once and adapt every requested modality."""

    try:
        if record.archive_path and record.member_path:
            if tar_reader is None:
                raise RuntimeError("tar-backed record requires a process-local TarHandleCache")
            identity = f"{record.archive_path}:{record.member_path}"
            payload = tar_reader.read_member(record.archive_path, record.member_path)
        else:
            path = resolve_precomputed_view_path(record, args, root_override=root_override)
            identity = str(path)
            if not path.exists():
                print(f"[precomputed] missing view file, skipping: {path}", flush=True)
                return None
            payload = path.read_bytes()
        decoded = decode_npz_bundle(
            payload,
            required_views,
            identity=identity,
            include_av=include_av,
            max_faces=int(getattr(args, "compact_v2_max_faces", 4)),
        )
        views: Dict[str, Tensor] = {}
        for view, array in decoded["views"].items():
            views[view] = prepare_precomputed_view_tensor(array, args)
        result: Dict[str, Any] = {"views": views}
        context = decoded.get("av_context")
        if isinstance(context, dict):
            mouth = torch.from_numpy(np.asarray(context["mouth_tracks"]))
            if mouth.dtype != torch.float32:
                mouth = mouth.float().div_(255.0)
            result["av_context"] = {
                "mouth_tracks": mouth,
                "waveform": torch.from_numpy(np.asarray(context["waveform"], dtype=np.float32)),
                "track_mask": torch.from_numpy(np.asarray(context["track_mask"], dtype=np.float32)),
                "quality": torch.from_numpy(np.asarray(context["quality"], dtype=np.float32)),
            }
            result["av_applicable"] = bool(context.get("applicable", False))
            result["av_window_index"] = int(context.get("window_index", -1))
        return result
    except Exception as exc:
        print(f"[precomputed] failed to load {record.video_path}: {exc}", flush=True)
        return None


class StreamingDeepfakeDataset(IterableDataset):
    """Iterable dataset that decodes one video at a time from a JSONL manifest."""

    def __init__(
        self,
        manifest_path: str | Path,
        split: str,
        required_views: Sequence[str],
        args: argparse.Namespace,
        hf: HFStore,
        stats: Dict[str, Any],
        train: bool,
        precomputed_root: Optional[str | Path] = None,
    ) -> None:
        super().__init__()
        self.manifest_path = Path(manifest_path)
        self.split = split
        self.required_views = list(dict.fromkeys(required_views))
        self.args = args
        self.hf = hf
        self.stats = stats
        self.train = train
        self.precomputed_root = str(precomputed_root) if precomputed_root else None
        self._tar_reader: Optional[TarHandleCache] = None
        self.epoch = 0
        self.skipped_videos = 0
        self.skipped_errors = 0

    def set_epoch(self, epoch: int) -> None:
        self.epoch = epoch
        self.skipped_videos = 0
        self.skipped_errors = 0

    def _get_tar_reader(self) -> TarHandleCache:
        if self._tar_reader is None:
            root = self.precomputed_root or getattr(self.args, "precomputed_root", None) or "."
            self._tar_reader = TarHandleCache(
                root,
                max_open=int(getattr(self.args, "tar_handle_cache_size", 4)),
                max_member_bytes=int(getattr(self.args, "max_npz_member_bytes", 2 * 1024 ** 3)),
            )
        return self._tar_reader

    def __getstate__(self) -> Dict[str, Any]:
        state = dict(self.__dict__)
        reader = state.pop("_tar_reader", None)
        if reader is not None:
            reader.close()
        state["_tar_reader"] = None
        return state

    def __del__(self) -> None:
        reader = getattr(self, "_tar_reader", None)
        if reader is not None:
            reader.close()

    def _iter_records(self) -> Iterator[VideoRecord]:
        worker = get_worker_info()
        worker_id = worker.id if worker else 0
        num_workers = worker.num_workers if worker else 1
        rng = random.Random(int(self.args.seed) + self.epoch * 1009 + worker_id)

        def records_for_label(label_filter: Optional[int]) -> Iterator[VideoRecord]:
            with open(self.manifest_path, "r", encoding="utf-8") as f:
                for line_no, line in enumerate(f):
                    if line_no % num_workers != worker_id or not line.strip():
                        continue
                    record = VideoRecord.from_json(json.loads(line))
                    if record.split != self.split:
                        continue
                    if label_filter is not None and record.label != label_filter:
                        continue
                    if self.args.balance_datasets and self.train:
                        p = acceptance_probability_for_dataset(self.stats, self.split, record.dataset)
                        if rng.random() > p:
                            continue
                    yield record

        emitted = 0
        split_labels = self.stats.get("by_split_label", {}).get(self.split, {})
        can_interleave = (
            self.train
            and bool(getattr(self.args, "interleave_classes", True))
            and int(split_labels.get("0", 0)) > 0
            and int(split_labels.get("1", 0)) > 0
        )
        if can_interleave:
            iterators = [iter(records_for_label(0)), iter(records_for_label(1))]
            active = [True, True]
            while any(active):
                for index, iterator in enumerate(iterators):
                    if not active[index]:
                        continue
                    try:
                        record = next(iterator)
                    except StopIteration:
                        active[index] = False
                        continue
                    yield record
                    emitted += 1
                    if self.args.limit_records is not None and emitted >= int(self.args.limit_records):
                        return
        else:
            for record in records_for_label(None):
                yield record
                emitted += 1
                if self.args.limit_records is not None and emitted >= int(self.args.limit_records):
                    return

    def __iter__(self) -> Iterator[Dict[str, Any]]:
        rng = random.Random(int(self.args.seed) + self.epoch * 9973)
        buffer_size = int(self.args.shuffle_buffer_size) if self.train else 0
        buffer: List[VideoRecord] = []

        def materialize(record: VideoRecord) -> Optional[Dict[str, Any]]:
            try:
                if is_precomputed_view_record(record, self.args):
                    include_av = bool(
                        getattr(self.args, "use_lip", False)
                        or getattr(self.args, "lip_checkpoint", None)
                        or getattr(self.args, "require_av_context", False)
                    )
                    compact = load_precomputed_bundle(
                        record,
                        self.required_views,
                        self.args,
                        include_av=include_av,
                        root_override=self.precomputed_root,
                        tar_reader=self._get_tar_reader() if record.archive_path else None,
                    )
                    views = compact["views"] if compact is not None else None
                else:
                    compact = None
                    path = resolve_record_video_path(record, self.hf)
                    if not path:
                        return None
                    views = decode_video_views(path, self.required_views, self.args, train=self.train, rng=rng)
                if views is None:
                    self.skipped_videos += 1
                    return None
                sample = {
                    "views": views,
                    "label": torch.tensor([float(record.label)], dtype=torch.float32),
                    "dataset": record.dataset,
                    "record": record.to_json(),
                }
                if compact is not None and "av_context" in compact:
                    sample["av_context"] = compact["av_context"]
                    sample["av_applicable"] = torch.tensor(
                        [float(compact.get("av_applicable", False))], dtype=torch.float32
                    )
                elif record.av_prepared_path:
                    av_path = Path(record.av_prepared_path)
                    if not av_path.is_absolute():
                        av_path = self.manifest_path.parent / av_path
                    with np.load(av_path, allow_pickle=False) as payload:
                        sample["av_context"] = {
                            "mouth_tracks": torch.from_numpy(np.asarray(payload["mouth_tracks"], dtype=np.float32)),
                            "waveform": torch.from_numpy(np.asarray(payload["waveform"], dtype=np.float32)),
                            "track_mask": torch.from_numpy(np.asarray(payload["track_mask"], dtype=np.float32)),
                            "quality": torch.from_numpy(np.asarray(payload["quality"], dtype=np.float32)),
                        }
                elif bool(getattr(self.args, "require_av_context", False)):
                    raise ValueError("AV context is required but av_prepared_path is missing")
                return sample
            except Exception as exc:
                self.skipped_errors += 1
                print(f"[dataset] skipping record after error: {record.video_path} :: {exc}", flush=True)
                return None

        for record in self._iter_records():
            if buffer_size > 1:
                buffer.append(record)
                if len(buffer) >= buffer_size:
                    idx = rng.randrange(len(buffer))
                    chosen = buffer.pop(idx)
                    sample = materialize(chosen)
                    if sample is not None:
                        yield sample
            else:
                sample = materialize(record)
                if sample is not None:
                    yield sample

        while buffer:
            idx = rng.randrange(len(buffer))
            chosen = buffer.pop(idx)
            sample = materialize(chosen)
            if sample is not None:
                yield sample


def collate_samples(samples: List[Dict[str, Any]]) -> Dict[str, Any]:
    samples = [s for s in samples if s is not None]
    if not samples:
        raise RuntimeError("empty batch after filtering failed videos")
    view_names = samples[0]["views"].keys()
    views = {name: torch.stack([sample["views"][name] for sample in samples], dim=0) for name in view_names}
    labels = torch.stack([sample["label"] for sample in samples], dim=0)
    datasets = [sample["dataset"] for sample in samples]
    records = [sample["record"] for sample in samples]
    result = {"views": views, "labels": labels, "datasets": datasets, "records": records}
    if all("av_context" in sample for sample in samples):
        result["av_context"] = {
            name: torch.stack([sample["av_context"][name] for sample in samples], dim=0)
            for name in ("mouth_tracks", "waveform", "track_mask", "quality")
        }
        result["av_applicable"] = torch.stack(
            [sample.get("av_applicable", torch.ones(1, dtype=torch.float32)) for sample in samples],
            dim=0,
        )
    return result


def make_loader(
    manifest_path: Path,
    split: str,
    required_views: Sequence[str],
    args: argparse.Namespace,
    hf: HFStore,
    stats: Dict[str, Any],
    train: bool,
) -> Tuple[StreamingDeepfakeDataset, DataLoader]:
    effective_manifest = manifest_path
    effective_root: Optional[str | Path] = getattr(args, "precomputed_root", None)
    if split == "val" and getattr(args, "validation_manifest", None):
        effective_manifest = Path(args.validation_manifest)
        effective_root = getattr(args, "validation_root", None) or effective_manifest.parent
    elif split == "test" and getattr(args, "test_manifest", None):
        effective_manifest = Path(args.test_manifest)
        effective_root = getattr(args, "test_root", None) or effective_manifest.parent
    dataset = StreamingDeepfakeDataset(
        effective_manifest,
        split,
        required_views,
        args,
        hf,
        stats,
        train=train,
        precomputed_root=effective_root,
    )
    loader_kwargs: Dict[str, Any] = {}
    if int(args.num_workers) > 0:
        loader_kwargs["prefetch_factor"] = int(getattr(args, "prefetch_factor", 2))
        loader_kwargs["timeout"] = float(getattr(args, "dataloader_timeout", 0.0))
    loader = DataLoader(
        dataset,
        batch_size=int(args.batch_size),
        num_workers=int(args.num_workers),
        collate_fn=collate_samples,
        pin_memory=torch.cuda.is_available(),
        # Recreate workers each epoch so set_epoch(), deterministic shuffle
        # seeds, counters, and process-local tar caches cannot go stale.
        persistent_workers=False,
        **loader_kwargs,
    )
    return dataset, loader


def one_record_probe_batch(
    manifest_path: Path,
    required_views: Sequence[str],
    args: argparse.Namespace,
    hf: HFStore,
    stats: Dict[str, Any],
) -> Dict[str, Any]:
    """Decode one real training record without spawning the production worker pool."""

    saved_batch = args.batch_size
    saved_workers = args.num_workers
    saved_prefetch = args.prefetch_factor
    try:
        args.batch_size = 1
        args.num_workers = 0
        args.prefetch_factor = 2
        _, loader = make_loader(manifest_path, "train", required_views, args, hf, stats, train=True)
        return next(iter(loader))
    finally:
        args.batch_size = saved_batch
        args.num_workers = saved_workers
        args.prefetch_factor = saved_prefetch


def finish_auto_max_loader_tuning(
    args: argparse.Namespace,
    one_record_batch: Dict[str, Any],
    report: Dict[str, Any],
    report_name: str,
) -> None:
    args.prefetch_factor = ram_budgeted_prefetch(
        sample_bytes=tensor_tree_nbytes(one_record_batch),
        batch_size=int(args.batch_size),
        workers=int(args.num_workers),
        target_fraction=float(args.target_ram_fraction),
        reserve_gib=float(args.ram_reserve_gib),
        minimum=1,
        maximum=max(1, int(args.prefetch_factor)),
    )
    report.update(
        {
            "num_workers": int(args.num_workers),
            "prefetch_factor": int(args.prefetch_factor),
            "measured_one_record_bytes": tensor_tree_nbytes(one_record_batch),
        }
    )
    report_path = Path(args.local_cache_dir) / "checkpoints" / report_name
    atomic_write_json(report_path, report)


def reuse_saved_auto_max_tuning(args: argparse.Namespace) -> None:
    """Reuse the measured training batch for calibration/evaluation subprocesses."""

    if not args.auto_tune_batch_size or args.mode not in {
        "calibrate", "eval", "calibrate_cached_fusion", "eval_cached_fusion"
    }:
        return
    cached = args.mode in {"calibrate_cached_fusion", "eval_cached_fusion"}
    report_name = "RESOURCE_AUTOTUNE_cached_fusion.json" if cached else "RESOURCE_AUTOTUNE_stage2_fusion.json"
    path = Path(args.local_cache_dir) / "checkpoints" / report_name
    if not path.is_file():
        return
    try:
        report = json.loads(path.read_text(encoding="utf-8"))
        if cached:
            args.cached_fusion_batch_size = max(1, int(report["selected_batch_size"]))
        else:
            args.batch_size = max(1, int(report["selected_batch_size"]))
        args.prefetch_factor = max(1, int(report.get("prefetch_factor", args.prefetch_factor)))
        print(
            f"[auto-max] reused fusion batch_size="
            f"{args.cached_fusion_batch_size if cached else args.batch_size} "
            f"prefetch_factor={args.prefetch_factor} for {args.mode}",
            flush=True,
        )
    except Exception as exc:
        print(f"[auto-max] could not reuse {path}: {exc}", flush=True)


def auto_tune_stage1_resources(
    model: nn.Module,
    criterion: nn.Module,
    manifest_path: Path,
    required_views: Sequence[str],
    args: argparse.Namespace,
    hf: HFStore,
    stats: Dict[str, Any],
    device: torch.device,
) -> None:
    if not args.auto_tune_batch_size or device.type != "cuda":
        return
    one = one_record_probe_batch(manifest_path, required_views, args, hf, stats)
    view_name = required_views[0]

    def probe(candidate: int) -> None:
        batch = repeat_batch_tree(one, candidate)
        labels = batch["labels"].to(device, non_blocking=True)
        frames = batch["views"][view_name].to(device, non_blocking=True)
        model.zero_grad(set_to_none=True)
        with autocast_context(device, args.precision):
            output = model(frames)
            loss = criterion(output.logit, labels)
        loss.backward()
        model.zero_grad(set_to_none=True)

    args.batch_size, report = autotune_cuda_batch_size(
        probe,
        initial_batch_size=max(1, int(args.batch_size)),
        max_batch_size=ram_limited_batch_cap(
            sample_bytes=tensor_tree_nbytes(one),
            configured_max=int(args.max_auto_batch_size),
            target_fraction=float(args.target_ram_fraction),
            reserve_gib=float(args.ram_reserve_gib),
        ),
        target_vram_fraction=float(args.target_vram_fraction),
        vram_reserve_gib=float(args.vram_reserve_gib),
        label=f"temporal_{args.expert}",
    )
    finish_auto_max_loader_tuning(args, one, report, f"RESOURCE_AUTOTUNE_stage1_{args.expert}.json")


def auto_tune_fusion_resources(
    bundle: ModelBundle,
    criterion: nn.Module,
    manifest_path: Path,
    required_views: Sequence[str],
    include_extra: bool,
    dataset_to_id: Dict[str, int],
    args: argparse.Namespace,
    hf: HFStore,
    stats: Dict[str, Any],
    device: torch.device,
) -> None:
    if not args.auto_tune_batch_size or device.type != "cuda":
        return
    if bundle.fusion is None:
        raise RuntimeError("fusion model was not built before auto-tuning")
    one = one_record_probe_batch(manifest_path, required_views, args, hf, stats)

    def probe(candidate: int) -> None:
        batch = repeat_batch_tree(one, candidate)
        labels = batch["labels"].to(device, non_blocking=True)
        bundle.fusion.zero_grad(set_to_none=True)
        with torch.no_grad():
            views = move_views_to_device(batch["views"], device, required=required_views)
            expert_outputs = run_experts(
                bundle,
                views,
                include_extra_long=include_extra,
                include_spatial=bool(args.use_spatial or args.spatial_checkpoint or args.spatial_stub),
                include_lip=bool(args.use_lip or args.lip_checkpoint or args.lip_stub),
                av_context=move_av_context_to_device(batch, device),
            )
        with autocast_context(device, args.precision):
            dataset_ids = dataset_ids_from_names(batch["datasets"], dataset_to_id, device)
            fusion_out = bundle.fusion(expert_outputs, dataset_ids=dataset_ids)
            loss = criterion(fusion_out["logit"], labels)
        loss.backward()
        bundle.fusion.zero_grad(set_to_none=True)

    measured_sample_bytes = tensor_tree_nbytes(one)
    # Cache generation has a materially different host-memory shape from
    # ordinary fusion training: the main process holds one batch while every
    # DataLoader worker can hold a decoded/pinned prefetched batch. The old
    # cap considered only the probe batch, allowing batch=128 with four
    # workers on a 167 GiB host; Colab then SIGKILLed the entire subprocess at
    # 94.7% RAM even though the A100 probe itself was safe. Inflate the sample
    # cost by the number of simultaneously resident loader batches so the
    # GPU tuner cannot approve a host-unsafe production queue.
    host_resident_batches = 1
    if args.mode == "cache_experts" and int(args.num_workers) > 0:
        host_resident_batches += int(args.num_workers) * max(1, int(args.prefetch_factor))
    host_budget_sample_bytes = measured_sample_bytes * host_resident_batches
    args.batch_size, report = autotune_cuda_batch_size(
        probe,
        initial_batch_size=max(1, int(args.batch_size)),
        max_batch_size=ram_limited_batch_cap(
            sample_bytes=host_budget_sample_bytes,
            configured_max=int(args.max_auto_batch_size),
            target_fraction=float(args.target_ram_fraction),
            reserve_gib=float(args.ram_reserve_gib),
        ),
        target_vram_fraction=float(args.target_vram_fraction),
        vram_reserve_gib=float(args.vram_reserve_gib),
        label="multimodal_fusion",
    )
    finish_auto_max_loader_tuning(args, one, report, "RESOURCE_AUTOTUNE_stage2_fusion.json")
    report.update(
        {
            "host_resident_batch_multiplier": host_resident_batches,
            "host_budget_sample_bytes": host_budget_sample_bytes,
        }
    )
    atomic_write_json(
        Path(args.local_cache_dir) / "checkpoints" / "RESOURCE_AUTOTUNE_stage2_fusion.json",
        report,
    )


# ---------------------------------------------------------------------------
# Model components
# ---------------------------------------------------------------------------


def binary_entropy(prob: Tensor, eps: float = 1e-6) -> Tensor:
    p = prob.clamp(eps, 1.0 - eps)
    return -(p * torch.log(p) + (1.0 - p) * torch.log(1.0 - p))


def make_expert_output(
    name: str,
    embedding: Tensor,
    logit: Tensor,
    uncertainty: Optional[Tensor] = None,
    diagnostics: Optional[Dict[str, Tensor]] = None,
) -> ExpertOutput:
    embedding = torch.nan_to_num(embedding, nan=0.0, posinf=1e4, neginf=-1e4)
    logit = torch.nan_to_num(logit, nan=0.0, posinf=30.0, neginf=-30.0)
    confidence = torch.sigmoid(logit)
    resolved_uncertainty = binary_entropy(confidence) if uncertainty is None else uncertainty
    resolved_uncertainty = torch.nan_to_num(resolved_uncertainty, nan=1.0, posinf=1.0, neginf=1.0)
    if resolved_uncertainty.ndim == 1:
        resolved_uncertainty = resolved_uncertainty[:, None]
    return ExpertOutput(
        name=name,
        embedding=embedding,
        logit=logit,
        confidence=confidence,
        uncertainty=resolved_uncertainty,
        diagnostics=diagnostics,
    )


def first_available_view(views: Dict[str, Tensor], names: Sequence[str]) -> Optional[Tensor]:
    for name in names:
        if name in views:
            return views[name]
    return None


class MicroExpert(nn.Module):
    """Short-window artifact expert using frame differences and a small CNN."""

    def __init__(self, embedding_dim: int = 256, dropout: float = 0.1) -> None:
        super().__init__()
        self.name = "micro"
        self.cnn = nn.Sequential(
            nn.Conv2d(3, 32, kernel_size=3, stride=2, padding=1),
            nn.BatchNorm2d(32),
            nn.GELU(),
            nn.Conv2d(32, 64, kernel_size=3, stride=2, padding=1),
            nn.BatchNorm2d(64),
            nn.GELU(),
            nn.Conv2d(64, 128, kernel_size=3, stride=2, padding=1),
            nn.BatchNorm2d(128),
            nn.GELU(),
            nn.Conv2d(128, 192, kernel_size=3, stride=2, padding=1),
            nn.BatchNorm2d(192),
            nn.GELU(),
            nn.AdaptiveAvgPool2d(1),
        )
        self.proj = nn.Sequential(
            nn.LayerNorm(192 * 3),
            nn.Linear(192 * 3, embedding_dim),
            nn.GELU(),
            nn.Dropout(dropout),
        )
        self.head = nn.Linear(embedding_dim, 1)

    def forward(self, frames: Tensor) -> ExpertOutput:
        # frames: [B, T, 3, 224, 224] in [0, 1].
        if frames.size(1) < 2:
            raise ValueError("MicroExpert requires at least two frames")
        diffs = frames[:, 1:] - frames[:, :-1]
        b, t, c, h, w = diffs.shape
        x = diffs.reshape(b * t, c, h, w)
        feat = self.cnn(x).flatten(1).reshape(b, t, -1)
        pooled = torch.cat(
            [
                feat.mean(dim=1),
                feat.std(dim=1, unbiased=False),
                feat.amax(dim=1),
            ],
            dim=-1,
        )
        embedding = self.proj(pooled)
        logit = self.head(embedding)
        return make_expert_output(self.name, embedding, logit)


class CLIPFrameEncoder(nn.Module):
    """Reusable frozen CLIP image encoder with chunked frame encoding."""

    def __init__(
        self,
        model_name: str,
        backend: str = "hf",
        freeze: bool = True,
        unfreeze_last_block: bool = False,
        frame_chunk_size: int = 4,
        allow_random_fallback: bool = False,
    ) -> None:
        super().__init__()
        self.model_name = model_name
        self.backend = backend
        self.freeze = freeze
        self.frame_chunk_size = max(1, int(frame_chunk_size))
        self.allow_random_fallback = allow_random_fallback

        self.register_buffer(
            "clip_mean",
            torch.tensor([0.48145466, 0.4578275, 0.40821073]).view(1, 3, 1, 1),
            persistent=False,
        )
        self.register_buffer(
            "clip_std",
            torch.tensor([0.26862954, 0.26130258, 0.27577711]).view(1, 3, 1, 1),
            persistent=False,
        )

        self.model: Optional[nn.Module] = None
        self.visual: Optional[nn.Module] = None
        self.output_dim = 0
        chosen = backend
        if backend == "auto":
            chosen = "hf" if TRANSFORMERS_AVAILABLE else "openai" if OPENAI_CLIP_AVAILABLE else "random"
        if chosen == "hf" and TRANSFORMERS_AVAILABLE:
            clip_source = os.environ.get("ORISLOP_TEMPORAL_CLIP_MODEL_SOURCE", model_name).strip() or model_name
            default_revision = (
                "3d74acf9a28c67741b2f4f2ea7635f0aaf6f0268"
                if model_name == "openai/clip-vit-base-patch32"
                else ""
            )
            clip_revision = os.environ.get(
                "ORISLOP_TEMPORAL_CLIP_MODEL_REVISION",
                default_revision,
            ).strip()
            clip_options = (
                {}
                if Path(clip_source).expanduser().is_dir()
                else ({"revision": clip_revision} if clip_revision else {})
            )
            self.model = CLIPVisionModel.from_pretrained(  # type: ignore[union-attr]
                clip_source,
                **clip_options,
            )
            self.output_dim = int(self.model.config.hidden_size)  # type: ignore[union-attr]
        elif chosen == "openai" and OPENAI_CLIP_AVAILABLE:
            clip_model, _ = openai_clip.load(model_name, device="cpu", jit=False)  # type: ignore[union-attr]
            self.visual = clip_model.visual
            self.output_dim = int(getattr(clip_model.visual, "output_dim", 512))
        elif allow_random_fallback:
            warnings.warn(
                "Using random lightweight CLIP fallback. This is only for debugging; install transformers for training.",
                RuntimeWarning,
            )
            self.model = nn.Sequential(
                nn.Conv2d(3, 64, 7, stride=4, padding=3),
                nn.GELU(),
                nn.AdaptiveAvgPool2d(1),
                nn.Flatten(),
                nn.Linear(64, 512),
            )
            self.output_dim = 512
            chosen = "random"
        else:
            raise RuntimeError(
                "No CLIP backend is available. Install transformers or openai-clip, "
                "or pass --allow-random-clip-fallback for metadata/debug only."
            )
        self.backend = chosen

        if self.freeze:
            for p in self.parameters():
                p.requires_grad_(False)

        if unfreeze_last_block and self.model is not None and hasattr(self.model, "vision_model"):
            # Keep most CLIP weights frozen but allow the last encoder block to adapt.
            for p in self.model.parameters():
                p.requires_grad_(False)
            try:
                block = self.model.vision_model.encoder.layers[-1]  # type: ignore[union-attr]
                for p in block.parameters():
                    p.requires_grad_(True)
                self.freeze = False
            except Exception:
                warnings.warn("Could not unfreeze last CLIP block for this model; CLIP remains frozen.")

    def train(self, mode: bool = True):
        super().train(mode)
        if self.freeze:
            if self.model is not None:
                self.model.eval()
            if self.visual is not None:
                self.visual.eval()
        return self

    def _normalize(self, frames: Tensor) -> Tensor:
        return (frames - self.clip_mean.to(frames.device, frames.dtype)) / self.clip_std.to(frames.device, frames.dtype)

    def _encode_chunk(self, pixels: Tensor) -> Tensor:
        pixels = self._normalize(pixels)
        if self.backend == "hf":
            assert self.model is not None
            out = self.model(pixel_values=pixels)
            if getattr(out, "pooler_output", None) is not None:
                return out.pooler_output
            return out.last_hidden_state[:, 0]
        if self.backend == "openai":
            assert self.visual is not None
            return self.visual(pixels)
        assert self.model is not None
        return self.model(pixels)

    def forward(self, frames: Tensor) -> Tensor:
        # frames: [B, T, 3, H, W], already resized and scaled to [0, 1].
        b, t, c, h, w = frames.shape
        flat = frames.reshape(b * t, c, h, w)
        outputs: List[Tensor] = []
        start = 0
        chunk = max(1, int(self.frame_chunk_size))
        while start < flat.size(0):
            end = min(flat.size(0), start + chunk)
            try:
                ctx = torch.no_grad() if self.freeze else contextlib.nullcontext()
                with ctx:
                    out = self._encode_chunk(flat[start:end])
                outputs.append(out.detach() if self.freeze else out)
                start = end
            except RuntimeError as exc:
                if is_cuda_oom(exc) and chunk > 1:
                    chunk = max(1, chunk // 2)
                    self.frame_chunk_size = chunk
                    cleanup_cuda()
                    print(f"[clip] CUDA OOM; reducing --clip-frame-chunk-size to {chunk}", flush=True)
                    continue
                raise
        return torch.cat(outputs, dim=0).reshape(b, t, -1)


class CLIPTemporalExpert(nn.Module):
    """Temporal Transformer expert over frozen CLIP frame embeddings."""

    def __init__(
        self,
        name: str,
        clip_encoder: CLIPFrameEncoder,
        embedding_dim: int = 256,
        num_layers: int = 2,
        num_heads: int = 4,
        dropout: float = 0.1,
        max_frames: int = 64,
    ) -> None:
        super().__init__()
        self.name = name
        self.clip_encoder = clip_encoder
        self.input_proj = nn.Sequential(
            nn.LayerNorm(clip_encoder.output_dim),
            nn.Linear(clip_encoder.output_dim, embedding_dim),
            nn.GELU(),
            nn.Dropout(dropout),
        )
        self.cls_token = nn.Parameter(torch.zeros(1, 1, embedding_dim))
        self.pos_embed = nn.Parameter(torch.zeros(1, max_frames + 1, embedding_dim))
        layer = nn.TransformerEncoderLayer(
            d_model=embedding_dim,
            nhead=num_heads,
            dim_feedforward=embedding_dim * 4,
            dropout=dropout,
            activation="gelu",
            batch_first=True,
            norm_first=True,
        )
        self.temporal = nn.TransformerEncoder(layer, num_layers=num_layers)
        self.norm = nn.LayerNorm(embedding_dim)
        self.head = nn.Linear(embedding_dim, 1)
        nn.init.normal_(self.cls_token, std=0.02)
        nn.init.normal_(self.pos_embed, std=0.02)

    def forward(self, frames: Tensor) -> ExpertOutput:
        raw = self.clip_encoder(frames)
        x = self.input_proj(raw)
        b, t, d = x.shape
        cls = self.cls_token.expand(b, -1, -1)
        x = torch.cat([cls, x], dim=1)
        x = x + self.pos_embed[:, : x.size(1), :]
        x = self.temporal(x)
        embedding = self.norm(x[:, 0])
        logit = self.head(embedding)
        return make_expert_output(self.name, embedding, logit)


class SpatialDetectorStub(nn.Module):
    """Fallback image-level artifact expert.

    It is intentionally small and exists so the system remains runnable when an
    external spatial detector is not supplied. Use --spatial-checkpoint for a
    real detector.
    """

    def __init__(self, embedding_dim: int = 256, dropout: float = 0.1) -> None:
        super().__init__()
        self.name = "spatial"
        self.cnn = nn.Sequential(
            nn.Conv2d(3, 32, 5, stride=2, padding=2),
            nn.BatchNorm2d(32),
            nn.GELU(),
            nn.Conv2d(32, 64, 3, stride=2, padding=1),
            nn.BatchNorm2d(64),
            nn.GELU(),
            nn.Conv2d(64, 128, 3, stride=2, padding=1),
            nn.BatchNorm2d(128),
            nn.GELU(),
            nn.AdaptiveAvgPool2d(1),
        )
        self.proj = nn.Sequential(
            nn.LayerNorm(128),
            nn.Linear(128, embedding_dim),
            nn.GELU(),
            nn.Dropout(dropout),
        )
        self.head = nn.Linear(embedding_dim, 1)

    def forward(self, views: Dict[str, Tensor]) -> ExpertOutput:
        frames = first_available_view(views, ["spatial", "mid", "long", "micro"])
        if frames is None:
            raise ValueError("SpatialDetectorStub requires at least one visual view")
        # Use a small subset of frames to stay cheap.
        stride = max(1, frames.size(1) // 4)
        frames = frames[:, ::stride][:, :4]
        b, t, c, h, w = frames.shape
        feat = self.cnn(frames.reshape(b * t, c, h, w)).flatten(1).reshape(b, t, -1)
        embedding = self.proj(feat.mean(dim=1))
        logit = self.head(embedding)
        return make_expert_output(self.name, embedding, logit)


class SpatialDetectorWrapper(nn.Module):
    """Adapter for external spatial detectors with a safe stub fallback."""

    def __init__(self, checkpoint: Optional[str], embedding_dim: int, use_stub: bool = False) -> None:
        super().__init__()
        self.name = "spatial"
        self.stub = SpatialDetectorStub(embedding_dim)
        self.external: Optional[nn.Module] = None
        if checkpoint and checkpoint != "optional" and Path(checkpoint).exists() and not use_stub:
            try:
                self.external = torch.jit.load(checkpoint, map_location="cpu")
                print(f"[spatial] loaded TorchScript external detector: {checkpoint}", flush=True)
            except Exception:
                try:
                    payload = safe_torch_load(checkpoint, map_location="cpu")
                    state = payload.get("model_state", payload)
                    self.stub.load_state_dict(state, strict=False)
                    print(f"[spatial] loaded state dict into spatial stub architecture: {checkpoint}", flush=True)
                except Exception as exc:
                    print(f"[spatial] failed to load checkpoint, using stub: {exc}", flush=True)

    def forward(self, views: Dict[str, Tensor]) -> ExpertOutput:
        if self.external is None:
            return self.stub(views)
        frames = first_available_view(views, ["spatial", "mid", "long", "micro"])
        if frames is None:
            raise ValueError("SpatialDetectorWrapper requires visual frames")
        center = frames[:, frames.size(1) // 2]
        out = self.external(center)
        if isinstance(out, dict) and "embedding" in out and "logit" in out:
            embedding = out["embedding"]
            logit = out["logit"]
            if logit.ndim == 1:
                logit = logit[:, None]
            return make_expert_output(self.name, embedding, logit)
        if isinstance(out, (tuple, list)) and len(out) >= 2:
            embedding, logit = out[0], out[1]
            if logit.ndim == 1:
                logit = logit[:, None]
            return make_expert_output(self.name, embedding, logit)
        # If the external model only returns logits, use the stub embedding for
        # token compatibility while preserving the external logit.
        stub_out = self.stub(views)
        logit = out if torch.is_tensor(out) else torch.as_tensor(out, device=stub_out.logit.device)
        if logit.ndim == 1:
            logit = logit[:, None]
        return make_expert_output(self.name, stub_out.embedding, logit.to(stub_out.embedding.device))


class LipSyncStub(nn.Module):
    """Fallback audio-video alignment expert.

    This first runnable version does not extract audio or crop mouths. The stub
    reports maximum uncertainty around a visual temporal summary unless a real
    lip-sync checkpoint/wrapper is supplied.
    """

    def __init__(self, embedding_dim: int = 256) -> None:
        super().__init__()
        self.name = "lip_sync"
        self.visual_summary = nn.Sequential(
            nn.Conv2d(3, 32, 3, stride=2, padding=1),
            nn.GELU(),
            nn.AdaptiveAvgPool2d(1),
            nn.Flatten(),
            nn.Linear(32, embedding_dim),
            nn.LayerNorm(embedding_dim),
        )
        self.head = nn.Linear(embedding_dim, 1)
        nn.init.zeros_(self.head.weight)
        nn.init.zeros_(self.head.bias)

    def forward(self, views: Dict[str, Tensor], audio: Optional[Any] = None) -> ExpertOutput:
        frames = first_available_view(views, ["mid", "micro", "long"])
        if frames is None:
            raise ValueError("LipSyncStub requires visual frames")
        center = frames[:, frames.size(1) // 2]
        embedding = self.visual_summary(center)
        logit = self.head(embedding)
        return make_expert_output(self.name, embedding, logit)


class LipSyncModelWrapper(nn.Module):
    """Adapter for the joint AV artifact with legacy lip-sync compatibility."""

    def __init__(self, checkpoint: Optional[str], embedding_dim: int, use_stub: bool = False) -> None:
        super().__init__()
        self.name = "lip_sync"
        self.embedding_dim = int(embedding_dim)
        self.stub = LipSyncStub(embedding_dim)
        self.external: Optional[nn.Module] = None
        self.joint_av_contract = False
        if checkpoint and checkpoint != "optional" and Path(checkpoint).exists() and not use_stub:
            try:
                self.external = torch.jit.load(checkpoint, map_location="cpu")
                self.joint_av_contract = "mouth_tracks" in str(self.external.forward.schema)
                print(f"[lip] loaded TorchScript lip-sync model: {checkpoint}", flush=True)
            except Exception:
                try:
                    payload = safe_torch_load(checkpoint, map_location="cpu")
                    state = payload.get("model_state", payload)
                    self.stub.load_state_dict(state, strict=False)
                    print(f"[lip] loaded state dict into lip stub architecture: {checkpoint}", flush=True)
                except Exception as exc:
                    print(f"[lip] failed to load checkpoint, using stub: {exc}", flush=True)

    def forward(
        self,
        views: Dict[str, Tensor],
        audio: Optional[Any] = None,
        av_context: Optional[Dict[str, Tensor]] = None,
    ) -> Optional[ExpertOutput]:
        if self.external is None:
            return self.stub(views, audio=audio)
        if self.joint_av_contract:
            if av_context is None:
                return None
            out = self.external(
                av_context["mouth_tracks"],
                av_context["waveform"],
                av_context["track_mask"],
                av_context["quality"],
            )
        else:
            out = self.external(views, audio)
        if isinstance(out, dict) and "embedding" in out and "logit" in out:
            embedding = out["embedding"]
            logit = out["logit"]
            diagnostics: Optional[Dict[str, Tensor]] = None
            uncertainty: Optional[Tensor] = None
            if self.joint_av_contract and embedding.ndim == 3:
                speaker = out.get("active_speaker_probability")
                if speaker is None:
                    speaker = torch.ones(embedding.size(0), embedding.size(1), device=embedding.device)
                selected = speaker.argmax(dim=1)
                batch_index = torch.arange(embedding.size(0), device=embedding.device)
                embedding = embedding[batch_index, selected]
                logit = logit[batch_index, selected]
                uncertainty = out["uncertainty"][batch_index, selected]
                diagnostics = {
                    "selected_face": selected.float(),
                    "joint_fake_probability": out["joint_fake_probability"][batch_index, selected],
                    "active_speaker_probability": speaker[batch_index, selected],
                    "sync_mismatch_probability": out["sync_mismatch_probability"][batch_index, selected],
                    "offset_probabilities": out["offset_probabilities"][batch_index, selected],
                    "audio_spoof_probability": out["audio_spoof_probability"][batch_index, selected],
                    "visual_forgery_probability": out["visual_forgery_probability"][batch_index, selected],
                    "segment_forgery_probabilities": out["segment_forgery_probabilities"][batch_index, selected],
                    "uncertainty": uncertainty,
                }
                applicable = av_context.get("applicable")
                if applicable is not None:
                    valid = applicable.reshape(-1).to(device=embedding.device, dtype=torch.bool)
                    embedding = torch.where(valid[:, None], embedding, torch.zeros_like(embedding))
                    logit = torch.where(valid, logit.reshape(-1), torch.zeros_like(logit.reshape(-1)))
                    uncertainty = torch.where(
                        valid,
                        uncertainty.reshape(-1),
                        torch.ones_like(uncertainty.reshape(-1)),
                    )
                    diagnostics["applicable"] = valid.float()
                if logit.ndim == 1:
                    logit = logit[:, None]
            if embedding.size(-1) != self.embedding_dim:
                raise ValueError(
                    f"Joint AV embedding dimension {embedding.size(-1)} does not match Temporal MoE {self.embedding_dim}"
                )
            return make_expert_output(self.name, embedding, logit, uncertainty=uncertainty, diagnostics=diagnostics)
        return self.stub(views, audio=audio)


class DisagreementComputer:
    """Inference-only disagreement score."""

    @staticmethod
    @torch.no_grad()
    def compute(outputs: Sequence[ExpertOutput]) -> Tensor:
        if len(outputs) < 2:
            if not outputs:
                return torch.tensor(0.0)
            return torch.zeros(outputs[0].embedding.size(0), device=outputs[0].embedding.device)
        total: Optional[Tensor] = None
        for i in range(len(outputs)):
            for j in range(i + 1, len(outputs)):
                e_i = F.normalize(outputs[i].embedding.detach(), dim=-1)
                e_j = F.normalize(outputs[j].embedding.detach(), dim=-1)
                d_ij = 1.0 - (e_i * e_j).sum(dim=-1)
                c_i = outputs[i].confidence.detach().squeeze(-1)
                c_j = outputs[j].confidence.detach().squeeze(-1)
                w_ij = d_ij * (1.0 - c_i * c_j)
                total = w_ij if total is None else total + w_ij
        assert total is not None
        return total

    @staticmethod
    @torch.no_grad()
    def feature_tensor(outputs: Sequence[ExpertOutput]) -> Tensor:
        if not outputs:
            raise ValueError("cannot compute disagreement features without expert outputs")
        b = outputs[0].embedding.size(0)
        n = len(outputs)
        device = outputs[0].embedding.device
        dtype = outputs[0].embedding.dtype
        features = torch.zeros(b, n, 3, device=device, dtype=dtype)
        if n < 2:
            return features
        pair = torch.zeros(b, n, n, device=device, dtype=dtype)
        for i in range(n):
            for j in range(i + 1, n):
                e_i = F.normalize(outputs[i].embedding.detach(), dim=-1)
                e_j = F.normalize(outputs[j].embedding.detach(), dim=-1)
                d_ij = 1.0 - (e_i * e_j).sum(dim=-1)
                c_i = outputs[i].confidence.detach().squeeze(-1)
                c_j = outputs[j].confidence.detach().squeeze(-1)
                w_ij = d_ij * (1.0 - c_i * c_j)
                pair[:, i, j] = w_ij.to(dtype)
                pair[:, j, i] = w_ij.to(dtype)
        mean_i = pair.sum(dim=-1) / max(1, n - 1)
        max_i = pair.max(dim=-1).values
        global_g = pair.triu(diagonal=1).sum(dim=(1, 2))
        features[:, :, 0] = mean_i
        features[:, :, 1] = max_i
        features[:, :, 2] = global_g[:, None]
        return features


class FusionTransformer(nn.Module):
    """Transformer over variable expert tokens."""

    def __init__(
        self,
        embedding_dim: int = 256,
        fusion_dim: int = 256,
        num_layers: int = 4,
        num_heads: int = 4,
        dropout: float = 0.1,
        expert_names: Sequence[str] = EXPERT_ORDER,
        num_dataset_domains: int = 0,
        use_disagreement_features: bool = True,
        use_dataset_embedding: bool = False,
    ) -> None:
        super().__init__()
        self.embedding_dim = embedding_dim
        self.fusion_dim = fusion_dim
        self.expert_names = list(expert_names)
        self.use_disagreement_features = use_disagreement_features
        self.use_dataset_embedding = use_dataset_embedding
        token_input_dim = embedding_dim + 2 + (3 if use_disagreement_features else 0)
        self.expert_to_id = {name: i for i, name in enumerate(self.expert_names)}
        self.token_proj = nn.Sequential(
            nn.LayerNorm(token_input_dim),
            nn.Linear(token_input_dim, fusion_dim),
            nn.GELU(),
            nn.Dropout(dropout),
        )
        self.expert_type_embed = nn.Embedding(len(self.expert_names), fusion_dim)
        self.dataset_embed = (
            nn.Embedding(max(1, num_dataset_domains), fusion_dim)
            if use_dataset_embedding and num_dataset_domains > 0
            else None
        )
        self.cls_token = nn.Parameter(torch.zeros(1, 1, fusion_dim))
        layer = nn.TransformerEncoderLayer(
            d_model=fusion_dim,
            nhead=num_heads,
            dim_feedforward=fusion_dim * 4,
            dropout=dropout,
            activation="gelu",
            batch_first=True,
            norm_first=True,
        )
        self.encoder = nn.TransformerEncoder(layer, num_layers=num_layers)
        self.norm = nn.LayerNorm(fusion_dim)
        self.reliability_head = nn.Linear(fusion_dim, 1)
        self.final_head = nn.Sequential(
            nn.LayerNorm(fusion_dim * 2),
            nn.Linear(fusion_dim * 2, fusion_dim),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(fusion_dim, 1),
        )
        self.domain_head = nn.Linear(fusion_dim, num_dataset_domains) if num_dataset_domains > 0 else None
        nn.init.normal_(self.cls_token, std=0.02)

    def forward(
        self,
        expert_outputs: Sequence[ExpertOutput],
        routing_bias: Optional[Dict[str, float]] = None,
        dataset_ids: Optional[Tensor] = None,
    ) -> Dict[str, Any]:
        if not expert_outputs:
            raise ValueError("FusionTransformer requires at least one expert output")
        names = [out.name for out in expert_outputs]
        disagreement_features = (
            DisagreementComputer.feature_tensor(expert_outputs)
            if self.use_disagreement_features
            else None
        )
        token_parts = [
            torch.cat(
                [
                    out.embedding,
                    out.confidence.to(out.embedding.dtype),
                    out.uncertainty.to(out.embedding.dtype),
                    disagreement_features[:, idx, :].to(out.embedding.dtype)
                    if disagreement_features is not None
                    else out.embedding.new_empty(out.embedding.size(0), 0),
                ],
                dim=-1,
            )
            for idx, out in enumerate(expert_outputs)
        ]
        tokens = torch.stack(token_parts, dim=1)
        tokens = torch.nan_to_num(tokens, nan=0.0, posinf=1e4, neginf=-1e4)
        x = self.token_proj(tokens)
        x = torch.nan_to_num(x, nan=0.0, posinf=1e4, neginf=-1e4)
        type_ids = torch.tensor(
            [self.expert_to_id.get(name, 0) for name in names],
            device=x.device,
            dtype=torch.long,
        )
        x = x + self.expert_type_embed(type_ids)[None, :, :]
        b = x.size(0)
        cls = self.cls_token.expand(b, -1, -1)
        if self.dataset_embed is not None and dataset_ids is not None:
            dataset_ids = dataset_ids.to(x.device, dtype=torch.long).clamp(0, self.dataset_embed.num_embeddings - 1)
            cls = cls + self.dataset_embed(dataset_ids)[:, None, :]
        encoded = self.encoder(torch.cat([cls, x], dim=1))
        encoded = torch.nan_to_num(encoded, nan=0.0, posinf=1e4, neginf=-1e4)
        cls_out = self.norm(encoded[:, 0])
        expert_encoded = self.norm(encoded[:, 1:])
        cls_out = torch.nan_to_num(cls_out, nan=0.0, posinf=1e4, neginf=-1e4)
        expert_encoded = torch.nan_to_num(expert_encoded, nan=0.0, posinf=1e4, neginf=-1e4)
        reliability_logits = self.reliability_head(expert_encoded).squeeze(-1)
        if routing_bias:
            bias = torch.zeros_like(reliability_logits)
            for idx, name in enumerate(names):
                if name in routing_bias:
                    # Log-space additive bias keeps routing inference-only and
                    # non-differentiable when passed under no_grad.
                    bias[:, idx] = math.log(max(1e-4, float(routing_bias[name])))
            reliability_logits = reliability_logits + bias
        reliability_logits = torch.nan_to_num(reliability_logits, nan=0.0, posinf=30.0, neginf=-30.0)
        weights = torch.softmax(reliability_logits, dim=-1)
        pooled = torch.sum(expert_encoded * weights.unsqueeze(-1), dim=1)
        logit = self.final_head(torch.cat([cls_out, pooled], dim=-1))
        logit = torch.nan_to_num(logit, nan=0.0, posinf=30.0, neginf=-30.0)
        prob = torch.sigmoid(logit)
        expert_weights = {name: weights[:, idx].detach() for idx, name in enumerate(names)}
        output: Dict[str, Any] = {
            "logit": logit,
            "probability": prob,
            "expert_weights": expert_weights,
        }
        if self.domain_head is not None:
            output["domain_logits"] = self.domain_head(cls_out)
        return output


class TemperatureScaler(nn.Module):
    def __init__(self, initial_temperature: float = 1.0) -> None:
        super().__init__()
        self.log_temperature = nn.Parameter(torch.log(torch.tensor([float(initial_temperature)])))

    @property
    def temperature(self) -> Tensor:
        return torch.exp(self.log_temperature).clamp(0.05, 100.0)

    def forward(self, logits: Tensor) -> Tensor:
        return logits / self.temperature.to(logits.device, logits.dtype)


# ---------------------------------------------------------------------------
# Model construction and checkpoint loading
# ---------------------------------------------------------------------------


def set_requires_grad(module: nn.Module, value: bool) -> None:
    for p in module.parameters():
        p.requires_grad_(value)


def build_clip_encoder_if_needed(args: argparse.Namespace, device: torch.device, needed: bool) -> Optional[CLIPFrameEncoder]:
    if not needed:
        return None
    encoder = CLIPFrameEncoder(
        model_name=args.clip_model_name,
        backend=args.clip_backend,
        freeze=bool(args.freeze_clip),
        unfreeze_last_block=bool(args.unfreeze_last_clip_block),
        frame_chunk_size=int(args.clip_frame_chunk_size),
        allow_random_fallback=bool(args.allow_random_clip_fallback),
    )
    return encoder.to(device)


def build_stage1_expert(args: argparse.Namespace, device: torch.device) -> nn.Module:
    if args.expert == "micro":
        return MicroExpert(args.embedding_dim, dropout=args.expert_dropout).to(device)
    if args.expert in TEMPORAL_EXPERTS:
        clip_encoder = build_clip_encoder_if_needed(args, device, needed=True)
        layers = args.extra_long_layers if args.expert == "extra_long" else args.temporal_layers
        return CLIPTemporalExpert(
            name=args.expert,
            clip_encoder=clip_encoder,  # type: ignore[arg-type]
            embedding_dim=args.embedding_dim,
            num_layers=layers,
            num_heads=args.temporal_heads,
            dropout=args.expert_dropout,
            max_frames=max(args.mid_frames, args.long_frames, args.extra_long_frames, 64),
        ).to(device)
    raise ValueError(f"Unknown stage1 expert: {args.expert}")


@dataclass
class ExpertBundle:
    micro: Optional[MicroExpert] = None
    mid: Optional[CLIPTemporalExpert] = None
    long: Optional[CLIPTemporalExpert] = None
    extra_long: Optional[CLIPTemporalExpert] = None
    spatial: Optional[SpatialDetectorWrapper] = None
    lip_sync: Optional[LipSyncModelWrapper] = None
    fusion: Optional[FusionTransformer] = None
    temperature: Optional[TemperatureScaler] = None

    def modules(self) -> List[nn.Module]:
        return [
            m
            for m in [
                self.micro,
                self.mid,
                self.long,
                self.extra_long,
                self.spatial,
                self.lip_sync,
                self.fusion,
                self.temperature,
            ]
            if m is not None
        ]


def default_hf_checkpoint_spec(args: argparse.Namespace, filename: str) -> Optional[str]:
    if not args.hf_repo_id:
        return None
    if args.hf_checkpoint_dir in ("", "."):
        return f"hf:{args.hf_repo_id}/{filename}"
    return f"hf:{args.hf_repo_id}/{args.hf_checkpoint_dir.strip('/')}/{filename}"


def load_optional_checkpoint(
    model: nn.Module,
    spec: Optional[str],
    hf: HFStore,
    device: torch.device,
    label: str,
) -> bool:
    if not spec:
        return False
    try:
        path = resolve_checkpoint_path(spec, hf)
        if path is None:
            return False
        checkpoint = safe_torch_load(path, map_location=device)
        load_model_state(model, checkpoint, strict=False)
        print(f"[ckpt] loaded {label}: {spec}", flush=True)
        return True
    except Exception as exc:
        print(f"[ckpt] could not load {label} from {spec}: {exc}", flush=True)
        return False


def load_calibration_checkpoint(
    model: nn.Module,
    spec: str,
    hf: HFStore,
    device: torch.device,
    expected_target: str,
) -> None:
    path = resolve_checkpoint_path(spec, hf)
    if path is None:
        raise RuntimeError(f"Calibration checkpoint is unavailable: {spec}")
    checkpoint = safe_torch_load(path, map_location=device)
    actual_target = str(checkpoint.get("expert", ""))
    if actual_target != expected_target:
        raise RuntimeError(
            f"Calibration checkpoint target mismatch: expected {expected_target!r}, got {actual_target!r}"
        )
    load_model_state(model, checkpoint, strict=True)
    print(f"[ckpt] loaded {expected_target} temperature scaler: {spec}", flush=True)


def build_fusion_bundle(
    args: argparse.Namespace,
    hf: HFStore,
    device: torch.device,
    load_experts: bool = True,
    stats: Optional[Dict[str, Any]] = None,
) -> ExpertBundle:
    need_clip = True
    clip_encoder = build_clip_encoder_if_needed(args, device, needed=need_clip)
    bundle = ExpertBundle()
    bundle.micro = MicroExpert(args.embedding_dim, dropout=args.expert_dropout).to(device)
    bundle.mid = CLIPTemporalExpert(
        "mid",
        clip_encoder,  # type: ignore[arg-type]
        args.embedding_dim,
        num_layers=args.temporal_layers,
        num_heads=args.temporal_heads,
        dropout=args.expert_dropout,
        max_frames=max(args.mid_frames, args.long_frames, args.extra_long_frames, 64),
    ).to(device)
    bundle.long = CLIPTemporalExpert(
        "long",
        clip_encoder,  # type: ignore[arg-type]
        args.embedding_dim,
        num_layers=args.temporal_layers,
        num_heads=args.temporal_heads,
        dropout=args.expert_dropout,
        max_frames=max(args.mid_frames, args.long_frames, args.extra_long_frames, 64),
    ).to(device)

    if args.extra_long_checkpoint or args.use_extra_long_in_fusion_training or args.predict_use_extra_long:
        bundle.extra_long = CLIPTemporalExpert(
            "extra_long",
            clip_encoder,  # type: ignore[arg-type]
            args.embedding_dim,
            num_layers=args.extra_long_layers,
            num_heads=args.temporal_heads,
            dropout=args.expert_dropout,
            max_frames=max(args.extra_long_frames, 64),
        ).to(device)

    spatial_ckpt = resolve_checkpoint_path(args.spatial_checkpoint, hf) if args.spatial_checkpoint and args.spatial_checkpoint.startswith("hf:") else args.spatial_checkpoint
    lip_ckpt = resolve_checkpoint_path(args.lip_checkpoint, hf) if args.lip_checkpoint and args.lip_checkpoint.startswith("hf:") else args.lip_checkpoint

    if args.use_spatial or args.spatial_checkpoint or args.spatial_stub:
        bundle.spatial = SpatialDetectorWrapper(spatial_ckpt, args.embedding_dim, use_stub=args.spatial_stub).to(device)
    if args.use_lip or args.lip_checkpoint or args.lip_stub:
        bundle.lip_sync = LipSyncModelWrapper(lip_ckpt, args.embedding_dim, use_stub=args.lip_stub).to(device)

    if load_experts:
        ckpts = {
            "micro": args.micro_checkpoint or default_hf_checkpoint_spec(args, "stage1_micro_best.pt"),
            "mid": args.mid_checkpoint or default_hf_checkpoint_spec(args, "stage1_mid_best.pt"),
            "long": args.long_checkpoint or default_hf_checkpoint_spec(args, "stage1_long_best.pt"),
            "extra_long": args.extra_long_checkpoint or default_hf_checkpoint_spec(args, "stage1_extra_long_best.pt"),
        }
        loaded: Dict[str, bool] = {}
        if bundle.micro:
            loaded["micro"] = load_optional_checkpoint(bundle.micro, ckpts["micro"], hf, device, "micro expert")
        if bundle.mid:
            loaded["mid"] = load_optional_checkpoint(bundle.mid, ckpts["mid"], hf, device, "mid expert")
        if bundle.long:
            loaded["long"] = load_optional_checkpoint(bundle.long, ckpts["long"], hf, device, "long expert")
        if bundle.extra_long:
            loaded["extra_long"] = load_optional_checkpoint(bundle.extra_long, ckpts["extra_long"], hf, device, "extra-long expert")

        if not args.allow_untrained_experts:
            missing_required = [name for name in ["micro", "mid", "long"] if not loaded.get(name)]
            if missing_required:
                raise RuntimeError(
                    "Missing required expert checkpoint(s) for fusion/eval/predict: "
                    f"{', '.join(missing_required)}. Provide --micro-checkpoint/--mid-checkpoint/--long-checkpoint "
                    "or pass --allow-untrained-experts for tiny debug runs only."
                )
            if bundle.extra_long is not None and not loaded.get("extra_long"):
                if args.use_extra_long_in_fusion_training:
                    raise RuntimeError(
                        "--use-extra-long-in-fusion-training was set, but no extra-long checkpoint could be loaded."
                    )
                print("[ckpt] extra-long checkpoint not loaded; disabling extra-long escalation.", flush=True)
                bundle.extra_long = None

    bundle.fusion = FusionTransformer(
        embedding_dim=args.embedding_dim,
        fusion_dim=args.fusion_dim,
        num_layers=args.fusion_layers,
        num_heads=args.fusion_heads,
        dropout=args.fusion_dropout,
        expert_names=EXPERT_ORDER,
        num_dataset_domains=len(dataset_to_id_from_stats(stats or {})) if args.fusion_use_dataset_embedding else 0,
        use_disagreement_features=bool(args.fusion_use_disagreement_features),
        use_dataset_embedding=bool(args.fusion_use_dataset_embedding),
    ).to(device)

    fusion_spec = args.fusion_checkpoint or default_hf_checkpoint_spec(args, "stage2_fusion_best.pt")
    if args.mode in {"eval", "predict", "calibrate"} and fusion_spec:
        load_optional_checkpoint(bundle.fusion, fusion_spec, hf, device, "fusion model")

    if args.calibration_checkpoint or args.mode == "predict":
        bundle.temperature = TemperatureScaler().to(device)
        cal_spec = args.calibration_checkpoint or default_hf_checkpoint_spec(args, "stage3_calibration.pt")
        if cal_spec:
            load_optional_checkpoint(bundle.temperature, cal_spec, hf, device, "temperature scaler")

    return bundle


def freeze_bundle_experts(bundle: ExpertBundle) -> None:
    for module in [bundle.micro, bundle.mid, bundle.long, bundle.extra_long, bundle.spatial, bundle.lip_sync]:
        if module is not None:
            module.eval()
            set_requires_grad(module, False)


def move_views_to_device(views: Dict[str, Tensor], device: torch.device, required: Optional[Sequence[str]] = None) -> Dict[str, Tensor]:
    names = required if required is not None else views.keys()
    return {name: views[name].to(device, non_blocking=True) for name in names if name in views}


def move_av_context_to_device(batch: Dict[str, Any], device: torch.device) -> Optional[Dict[str, Tensor]]:
    context = batch.get("av_context")
    if not isinstance(context, dict):
        return None
    required = ("mouth_tracks", "waveform", "track_mask", "quality")
    if not all(name in context and torch.is_tensor(context[name]) for name in required):
        return None
    moved = {name: context[name].to(device, non_blocking=True) for name in required}
    if torch.is_tensor(batch.get("av_applicable")):
        moved["applicable"] = batch["av_applicable"].to(device, non_blocking=True)
    return moved


def dataset_ids_from_names(datasets: Sequence[str], dataset_to_id: Dict[str, int], device: torch.device) -> Optional[Tensor]:
    if not dataset_to_id:
        return None
    ids = [dataset_to_id.get(str(name), 0) for name in datasets]
    return torch.tensor(ids, dtype=torch.long, device=device)


def apply_fusion_expert_dropout(
    outputs: Sequence[ExpertOutput],
    drop_prob: float,
    rng: random.Random,
) -> List[ExpertOutput]:
    outputs = list(outputs)
    if drop_prob <= 0.0 or len(outputs) <= 2:
        return outputs
    core_names = {"micro", "mid", "long"}
    kept = [out for out in outputs if rng.random() >= drop_prob]
    if len(kept) < 2:
        kept = outputs[:2]
    if not any(out.name in core_names for out in kept):
        first_core = next((out for out in outputs if out.name in core_names), None)
        if first_core is not None:
            kept = [first_core] + kept[: max(0, len(kept) - 1)]
    # If all core experts were dropped while they were available, put one back.
    available_core = [out for out in outputs if out.name in core_names]
    kept_core = [out for out in kept if out.name in core_names]
    if available_core and not kept_core:
        kept = [available_core[0]] + kept[: max(0, len(kept) - 1)]
    return list(dict((id(out), out) for out in kept).values())


@torch.no_grad()
def run_experts(
    bundle: ExpertBundle,
    views: Dict[str, Tensor],
    include_extra_long: bool,
    include_spatial: bool,
    include_lip: bool,
    av_context: Optional[Dict[str, Tensor]] = None,
) -> List[ExpertOutput]:
    outputs: List[ExpertOutput] = []
    if bundle.micro is not None and "micro" in views:
        outputs.append(bundle.micro(views["micro"]))
    if bundle.mid is not None and "mid" in views:
        outputs.append(bundle.mid(views["mid"]))
    if bundle.long is not None and "long" in views:
        outputs.append(bundle.long(views["long"]))
    if include_extra_long and bundle.extra_long is not None and "extra_long" in views:
        outputs.append(bundle.extra_long(views["extra_long"]))
    if include_spatial and bundle.spatial is not None:
        outputs.append(bundle.spatial(views))
    if include_lip and bundle.lip_sync is not None:
        lip_output = bundle.lip_sync(views, av_context=av_context)
        if lip_output is not None:
            outputs.append(lip_output)
    return outputs


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------


class MetricAccumulator:
    def __init__(self) -> None:
        self.loss_sum = 0.0
        self.n = 0
        self.labels: List[int] = []
        self.probs: List[float] = []
        self.datasets: List[str] = []
        self.disagreements: List[float] = []
        self.expert_weight_sums: Dict[str, float] = {}
        self.expert_weight_counts: Dict[str, int] = {}

    def update(
        self,
        loss: Optional[Tensor | float],
        labels: Tensor,
        probs: Tensor,
        datasets: Optional[Sequence[str]] = None,
        disagreement: Optional[Tensor] = None,
        expert_weights: Optional[Dict[str, Tensor]] = None,
    ) -> None:
        labels_cpu = labels.detach().cpu().view(-1).long().tolist()
        probs_cpu = probs.detach().cpu().view(-1).float().tolist()
        b = len(labels_cpu)
        if loss is not None:
            value = float(loss.detach().cpu()) if torch.is_tensor(loss) else float(loss)
            self.loss_sum += value * b
        self.n += b
        self.labels.extend(int(x) for x in labels_cpu)
        self.probs.extend(float(x) for x in probs_cpu)
        self.datasets.extend(list(datasets or ["unknown"] * b))
        if disagreement is not None:
            self.disagreements.extend(float(x) for x in disagreement.detach().cpu().view(-1).tolist())
        if expert_weights:
            for name, tensor in expert_weights.items():
                vals = tensor.detach().cpu().view(-1).float().tolist()
                self.expert_weight_sums[name] = self.expert_weight_sums.get(name, 0.0) + sum(vals)
                self.expert_weight_counts[name] = self.expert_weight_counts.get(name, 0) + len(vals)

    def compute(self, include_per_dataset: bool = True, threshold: float = 0.5) -> Dict[str, Any]:
        if self.n == 0:
            return {"n": 0}
        metrics = compute_binary_metrics(
            self.labels,
            self.probs,
            threshold=float(threshold),
            datasets=self.datasets,
            include_per_dataset=include_per_dataset,
        )
        metrics["loss"] = self.loss_sum / max(1, self.n)

        if self.disagreements:
            metrics["avg_disagreement_score"] = sum(self.disagreements) / len(self.disagreements)
        if self.expert_weight_sums:
            metrics["avg_expert_weights"] = {
                name: self.expert_weight_sums[name] / max(1, self.expert_weight_counts.get(name, 1))
                for name in sorted(self.expert_weight_sums)
            }

        return metrics


def class_pos_weight(stats: Dict[str, Any], split: str, device: torch.device) -> Optional[Tensor]:
    by_label = stats.get("by_split_label", {}).get(split)
    if not by_label:
        by_label = stats.get("by_label", {})
    pos = float(by_label.get("1", 0))
    neg = float(by_label.get("0", 0))
    if pos <= 0 or neg <= 0:
        return None
    return torch.tensor([neg / pos], dtype=torch.float32, device=device)


def estimated_epoch_steps(stats: Dict[str, Any], split: str, args: argparse.Namespace) -> Optional[int]:
    count = int(stats.get("by_split", {}).get(split, 0) or 0)
    if args.limit_records is not None:
        count = min(count, int(args.limit_records))
    if count <= 0:
        return None
    steps = math.ceil(count / max(1, int(args.batch_size)))
    if args.max_steps_per_epoch is not None:
        steps = min(steps, int(args.max_steps_per_epoch))
    return max(1, steps)


def progress_iter(iterable: Iterable[Any], total: Optional[int], desc: str, args: argparse.Namespace) -> Iterable[Any]:
    if tqdm_auto is None or bool(getattr(args, "disable_tqdm", False)):
        return iterable
    return tqdm_auto(iterable, total=total, desc=desc, dynamic_ncols=True, leave=False)


def assert_training_epoch_has_samples(
    stage: str,
    train_metrics: Dict[str, Any],
    dataset: Any,
    manifest_path: Path,
    args: argparse.Namespace,
) -> None:
    try:
        sample_count = int(train_metrics.get("n", 0) or 0)
    except Exception:
        sample_count = 0
    if sample_count > 0:
        return
    hint = (
        f"{stage} produced zero usable training samples from {manifest_path}. "
        f"skipped_videos={getattr(dataset, 'skipped_videos', 'unknown')} "
        f"skipped_errors={getattr(dataset, 'skipped_errors', 'unknown')}."
    )
    if getattr(args, "precomputed_manifest", None):
        hint += (
            " This run used precomputed frame views; check that --precomputed-root "
            "points at the extracted shard directory and that manifest video_path "
            "entries point to .npz files under that root."
        )
    else:
        hint += " Check video decode support, paths, labels, and corrupt/missing files."
    raise RuntimeError(hint)


def required_views_for_stage1(expert: str) -> List[str]:
    if expert == "micro":
        return ["micro"]
    if expert == "mid":
        return ["mid"]
    if expert == "long":
        return ["long"]
    if expert == "extra_long":
        return ["extra_long"]
    raise ValueError(expert)


def required_views_for_fusion(args: argparse.Namespace, include_extra_long: bool = False) -> List[str]:
    views = ["micro", "mid", "long"]
    if include_extra_long:
        views.append("extra_long")
    if bool(args.use_spatial or args.spatial_checkpoint or args.spatial_stub):
        views.append("spatial")
    return views


# ---------------------------------------------------------------------------
# Training, evaluation, calibration
# ---------------------------------------------------------------------------


def optimizer_step(
    optimizer: torch.optim.Optimizer,
    scaler: Any,
    model: nn.Module,
    args: argparse.Namespace,
) -> None:
    if args.max_grad_norm and args.max_grad_norm > 0:
        if scaler is not None and getattr(scaler, "is_enabled", lambda: False)():
            scaler.unscale_(optimizer)
        torch.nn.utils.clip_grad_norm_(model.parameters(), float(args.max_grad_norm))
    if scaler is not None and getattr(scaler, "is_enabled", lambda: False)():
        scaler.step(optimizer)
        scaler.update()
    else:
        optimizer.step()
    optimizer.zero_grad(set_to_none=True)


@torch.no_grad()
def evaluate_stage1_expert(
    model: nn.Module,
    loader: DataLoader,
    dataset: StreamingDeepfakeDataset,
    args: argparse.Namespace,
    device: torch.device,
    split: str,
    max_records: Optional[int] = None,
    temperature: Optional[TemperatureScaler] = None,
    threshold: float = 0.5,
) -> Dict[str, Any]:
    model.eval()
    if temperature is not None:
        temperature.eval()
    dataset.set_epoch(10_000 + int(time.time()) % 1000)
    criterion = nn.BCEWithLogitsLoss()
    metrics = MetricAccumulator()
    seen = 0
    view = required_views_for_stage1(args.expert)[0]
    for batch in loader:
        labels = batch["labels"].to(device, non_blocking=True)
        frames = batch["views"][view].to(device, non_blocking=True)
        with autocast_context(device, args.precision):
            out = model(frames)
            logits = temperature(out.logit) if temperature is not None else out.logit
            probabilities = torch.sigmoid(logits)
            loss = criterion(logits, labels)
        metrics.update(loss, labels, probabilities, batch["datasets"])
        seen += labels.size(0)
        del labels, frames, out, logits, probabilities, loss, batch
        if max_records is not None and seen >= max_records:
            break
    result = metrics.compute(threshold=float(threshold))
    result["split"] = split
    result["skipped_videos"] = dataset.skipped_videos
    result["skipped_errors"] = dataset.skipped_errors
    return result


def train_stage1(args: argparse.Namespace, hf: HFStore, manifest_path: Path, stats: Dict[str, Any], runtime: RuntimeInfo) -> None:
    if not args.expert:
        raise ValueError("--expert is required for --mode train_stage1")
    if runtime.device == "cpu" and not args.allow_cpu_train:
        raise RuntimeError("CPU full training is disabled. Pass --allow-cpu-train for tiny debug runs only.")
    device = torch.device(runtime.device)
    model = build_stage1_expert(args, device)
    trainable = [p for p in model.parameters() if p.requires_grad]
    optimizer = torch.optim.AdamW(trainable, lr=args.lr, weight_decay=args.weight_decay)
    scheduler = None
    scaler = make_grad_scaler(device, args.precision)
    pos_weight = class_pos_weight(stats, "train", device) if args.class_balanced_loss else None
    criterion = nn.BCEWithLogitsLoss(pos_weight=pos_weight)

    ckpt_dir = ensure_dir(Path(args.local_cache_dir) / "checkpoints")
    metrics_path = ckpt_dir / "metrics.json"
    log_path = ckpt_dir / "training_log.jsonl"
    start_epoch = 0
    global_step = 0
    best_metric: Optional[float] = None
    resume_path = find_resume_checkpoint(args, hf, "stage1", args.expert)
    if resume_path:
        model_only = args.resume_policy == "model-only"
        checkpoint = load_training_checkpoint(
            resume_path,
            model,
            optimizer,
            scheduler,
            scaler,
            map_location=device,
            load_optimizer_state=not model_only,
            load_scheduler_state=not model_only,
            load_scaler_state=not model_only,
        )
        if model_only:
            start_epoch = 0
            global_step = 0
            best_metric = None
            print("[resume] model-only expert phase transition; optimizer and epoch counters reset", flush=True)
        else:
            start_epoch = int(checkpoint.get("epoch", -1)) + 1
            global_step = int(checkpoint.get("global_step", 0))
            best_metric = checkpoint.get("best_validation_metric")

    required_views = required_views_for_stage1(args.expert)
    eval_split = ensure_split_has_records(args, stats, args.eval_split)
    auto_tune_stage1_resources(model, criterion, manifest_path, required_views, args, hf, stats, device)
    train_dataset, train_loader = make_loader(manifest_path, "train", required_views, args, hf, stats, train=True)
    val_dataset, val_loader = make_loader(manifest_path, eval_split, required_views, args, hf, stats, train=False)

    include_clip_state = bool(args.save_clip_state or not args.freeze_clip or args.unfreeze_last_clip_block)
    config_dict = safe_config_dict(args)
    config_dict["runtime"] = dataclasses.asdict(runtime)
    print(f"[train_stage1] expert={args.expert} trainable_params={sum(p.numel() for p in trainable):,}", flush=True)

    epoch_range = bounded_epoch_range(start_epoch, int(args.epochs), args.epochs_this_run)
    run_end_epoch = epoch_range.stop
    for epoch in epoch_range:
        model.train()
        train_dataset.set_epoch(epoch)
        epoch_metrics = MetricAccumulator()
        optimizer.zero_grad(set_to_none=True)
        pending = 0
        train_iter = progress_iter(
            enumerate(train_loader),
            estimated_epoch_steps(stats, "train", args),
            f"stage1/{args.expert} epoch {epoch + 1}/{args.epochs}",
            args,
        )
        for step, batch in train_iter:
            if args._wall_budget.should_stop():
                print("[wall-time] reserve reached; ending expert epoch at the next safe checkpoint", flush=True)
                break
            if args.max_steps_per_epoch is not None and step >= int(args.max_steps_per_epoch):
                break
            labels = batch["labels"].to(device, non_blocking=True)
            frames = batch["views"][required_views[0]].to(device, non_blocking=True)
            try:
                with autocast_context(device, args.precision):
                    out = model(frames)
                    loss = criterion(out.logit, labels)
                    if not torch.isfinite(loss):
                        print(
                            f"[warn] non-finite stage1 loss at expert={args.expert} epoch={epoch + 1} step={step + 1}; skipping batch",
                            flush=True,
                        )
                        optimizer.zero_grad(set_to_none=True)
                        pending = 0
                        continue
                    scaled_loss = loss / int(args.grad_accum_steps)
                if scaler is not None and getattr(scaler, "is_enabled", lambda: False)():
                    scaler.scale(scaled_loss).backward()
                else:
                    scaled_loss.backward()
                pending += 1
                epoch_metrics.update(loss, labels, out.confidence, batch["datasets"])
                if args.log_every_steps and (step + 1) % int(args.log_every_steps) == 0:
                    avg_loss = epoch_metrics.loss_sum / max(1, epoch_metrics.n)
                    if hasattr(train_iter, "set_postfix"):
                        train_iter.set_postfix(loss=f"{avg_loss:.4f}", global_step=global_step, refresh=False)
                    print(
                        f"[train_stage1] expert={args.expert} epoch={epoch + 1}/{args.epochs} "
                        f"step={step + 1} samples={epoch_metrics.n} "
                        f"global_step={global_step} avg_loss={avg_loss:.5f}",
                        flush=True,
                    )
                if pending >= int(args.grad_accum_steps):
                    optimizer_step(optimizer, scaler, model, args)
                    global_step += 1
                    pending = 0
            except RuntimeError as exc:
                if is_cuda_oom(exc):
                    print("[oom] skipping batch after CUDA OOM; clearing cache", flush=True)
                    optimizer.zero_grad(set_to_none=True)
                    cleanup_cuda()
                    if hasattr(model, "clip_encoder"):
                        enc = getattr(model, "clip_encoder")
                        enc.frame_chunk_size = max(1, int(enc.frame_chunk_size) // 2)
                    continue
                raise
            finally:
                del labels, frames, batch
                if step % int(args.empty_cache_every_steps) == 0:
                    cleanup_cuda()

        if pending > 0:
            optimizer_step(optimizer, scaler, model, args)
            global_step += 1

        train_metrics = epoch_metrics.compute()
        train_metrics["skipped_videos"] = train_dataset.skipped_videos
        train_metrics["skipped_errors"] = train_dataset.skipped_errors
        assert_training_epoch_has_samples("stage1", train_metrics, train_dataset, manifest_path, args)
        val_metrics = evaluate_stage1_expert(
            model,
            val_loader,
            val_dataset,
            args,
            device,
            eval_split,
            max_records=args.max_eval_records,
        )
        score = val_metrics.get("roc_auc")
        if score is None:
            score = -float(val_metrics.get("loss", 1e9))
        improved = best_metric is None or float(score) > float(best_metric)
        if improved:
            best_metric = float(score)

        epoch_summary = {
            "stage": "stage1",
            "expert": args.expert,
            "epoch": epoch,
            "global_step": global_step,
            "train": train_metrics,
            "validation": val_metrics,
            "best_metric": best_metric,
            "improved": improved,
            "time": timestamp(),
        }
        append_jsonl(log_path, epoch_summary)
        write_json(metrics_path, epoch_summary)
        print(json.dumps(epoch_summary, indent=2, default=json_default), flush=True)

        latest_path = ckpt_dir / checkpoint_basename("stage1", args.expert, "latest")
        save_checkpoint(
            path=latest_path,
            stage="stage1",
            expert=args.expert,
            epoch=epoch,
            global_step=global_step,
            model=model,
            optimizer=optimizer,
            scheduler=scheduler,
            scaler=scaler,
            config=config_dict,
            metrics=epoch_summary,
            best_metric=best_metric,
            include_clip_state=include_clip_state,
        )
        if args.save_every_epoch:
            epoch_path = ckpt_dir / f"stage1_{args.expert}_epoch_{epoch:04d}.pt"
            shutil.copy2(latest_path, epoch_path)
            if args.upload_numbered_epoch_checkpoints:
                hf.upload_file(epoch_path, epoch_path.name)

        if args.upload_latest_to_hf or args.hf_upload_every_epoch:
            hf.upload_file(latest_path, latest_path.name)
        if improved and args.save_best:
            best_path = ckpt_dir / checkpoint_basename("stage1", args.expert, "best")
            shutil.copy2(latest_path, best_path)
            if args.upload_best_to_hf:
                hf.upload_file(best_path, best_path.name)
                save_module_safetensors(model, ckpt_dir / f"stage1_{args.expert}_best.safetensors", hf)
        cleanup_cuda(every_epoch=True)


@torch.no_grad()
def fusion_forward_from_batch(
    bundle: ExpertBundle,
    batch: Dict[str, Any],
    args: argparse.Namespace,
    device: torch.device,
    include_extra_long: bool,
    routing_bias: Optional[Dict[str, float]] = None,
    temperature: Optional[TemperatureScaler] = None,
    dataset_to_id: Optional[Dict[str, int]] = None,
) -> Tuple[Dict[str, Any], List[ExpertOutput], Tensor]:
    assert bundle.fusion is not None
    required = required_views_for_fusion(args, include_extra_long=include_extra_long)
    views = move_views_to_device(batch["views"], device, required=required)
    outputs = run_experts(
        bundle,
        views,
        include_extra_long=include_extra_long,
        include_spatial=bool(args.use_spatial or args.spatial_checkpoint or args.spatial_stub),
        include_lip=bool(args.use_lip or args.lip_checkpoint or args.lip_stub),
        av_context=move_av_context_to_device(batch, device),
    )
    disagreement = DisagreementComputer.compute(outputs).to(device)
    dataset_ids = dataset_ids_from_names(batch.get("datasets", []), dataset_to_id or {}, device)
    fusion_out = bundle.fusion(outputs, routing_bias=routing_bias, dataset_ids=dataset_ids)
    if temperature is not None:
        calibrated_logit = temperature(fusion_out["logit"])
        fusion_out["calibrated_logit"] = calibrated_logit
        fusion_out["calibrated_probability"] = torch.sigmoid(calibrated_logit)
    return fusion_out, outputs, disagreement


def train_stage2_fusion(args: argparse.Namespace, hf: HFStore, manifest_path: Path, stats: Dict[str, Any], runtime: RuntimeInfo) -> None:
    if runtime.device == "cpu" and not args.allow_cpu_train:
        raise RuntimeError("CPU full training is disabled. Pass --allow-cpu-train for tiny debug runs only.")
    device = torch.device(runtime.device)
    bundle = build_fusion_bundle(args, hf, device, load_experts=True, stats=stats)
    if bundle.fusion is None:
        raise RuntimeError("Fusion model was not built")
    if args.freeze_experts:
        freeze_bundle_experts(bundle)
    bundle.fusion.train()
    set_requires_grad(bundle.fusion, True)

    optimizer = torch.optim.AdamW(bundle.fusion.parameters(), lr=args.fusion_lr, weight_decay=args.fusion_weight_decay)
    scheduler = None
    scaler = make_grad_scaler(device, args.precision)
    pos_weight = class_pos_weight(stats, "train", device) if args.class_balanced_loss else None
    criterion = nn.BCEWithLogitsLoss(pos_weight=pos_weight)
    include_extra = bool(args.use_extra_long_in_fusion_training and bundle.extra_long is not None)
    required_views = required_views_for_fusion(args, include_extra_long=include_extra)
    eval_split = ensure_split_has_records(args, stats, args.eval_split)
    dataset_to_id = dataset_to_id_from_stats(stats) if args.fusion_use_dataset_embedding else {}

    ckpt_dir = ensure_dir(Path(args.local_cache_dir) / "checkpoints")
    metrics_path = ckpt_dir / "metrics.json"
    log_path = ckpt_dir / "training_log.jsonl"
    start_epoch = 0
    global_step = 0
    best_metric: Optional[float] = None
    checks_without_improvement = 0
    resume_path = find_resume_checkpoint(args, hf, "stage2", None)
    if resume_path:
        try:
            resume_probe = safe_torch_load(resume_path, map_location="cpu")
            if checkpoint_has_zero_training_samples(resume_probe):
                print(
                    f"[resume] ignoring zero-sample stage2 checkpoint: {resume_path}",
                    flush=True,
                )
                resume_path = None
        except Exception as exc:
            print(f"[resume] could not inspect stage2 checkpoint {resume_path}: {exc}", flush=True)
    if resume_path:
        fresh_fusion_state = {k: v.detach().clone() for k, v in bundle.fusion.state_dict().items()}
        # Fusion is commonly resumed across chunked precomputed-view runs where
        # the available dataset domains or optional experts can vary by chunk.
        # Restoring model weights is safe; restoring Adam state after skipped or
        # shape-changed keys can fail later inside optimizer.step().
        model_only = args.resume_policy == "model-only"
        checkpoint = load_training_checkpoint(
            resume_path,
            bundle.fusion,
            optimizer,
            scheduler,
            scaler,
            map_location=device,
            load_optimizer_state=not model_only,
            load_scheduler_state=not model_only,
            load_scaler_state=not model_only,
        )
        nonfinite_count, nonfinite_names = count_nonfinite_parameters(bundle.fusion)
        if nonfinite_count:
            bundle.fusion.load_state_dict(fresh_fusion_state, strict=True)
            optimizer = torch.optim.AdamW(bundle.fusion.parameters(), lr=args.fusion_lr, weight_decay=args.fusion_weight_decay)
            start_epoch = 0
            global_step = 0
            best_metric = None
            checks_without_improvement = 0
            print(
                "[resume] WARNING: stage2 fusion checkpoint had "
                f"{nonfinite_count} non-finite parameter values; reset fusion weights. "
                f"First bad tensors: {nonfinite_names}",
                flush=True,
            )
        else:
            if model_only:
                start_epoch = 0
                global_step = 0
                best_metric = None
                checks_without_improvement = 0
                print(
                    "[resume] model-only fusion phase transition; optimizer and epoch counters reset",
                    flush=True,
                )
            else:
                start_epoch = int(checkpoint.get("epoch", -1)) + 1
                global_step = int(checkpoint.get("global_step", 0))
                best_metric = checkpoint.get("best_validation_metric")
                checks_without_improvement = int(
                    (checkpoint.get("metrics") or {}).get("checks_without_improvement", 0)
                )
                print("[resume] full fusion crash state restored", flush=True)

    auto_tune_fusion_resources(
        bundle,
        criterion,
        manifest_path,
        required_views,
        include_extra,
        dataset_to_id,
        args,
        hf,
        stats,
        device,
    )
    train_dataset, train_loader = make_loader(manifest_path, "train", required_views, args, hf, stats, train=True)
    val_dataset, val_loader = make_loader(manifest_path, eval_split, required_views, args, hf, stats, train=False)
    config_dict = safe_config_dict(args)
    config_dict["runtime"] = dataclasses.asdict(runtime)

    print(
        f"[train_stage2] training fusion only; trainable_params={sum(p.numel() for p in bundle.fusion.parameters() if p.requires_grad):,}",
        flush=True,
    )

    epoch_range = bounded_epoch_range(start_epoch, int(args.fusion_epochs), args.fusion_epochs_this_run)
    run_end_epoch = epoch_range.stop
    for epoch in epoch_range:
        bundle.fusion.train()
        train_dataset.set_epoch(epoch)
        dropout_rng = random.Random(int(args.seed) + epoch * 7919)
        epoch_metrics = MetricAccumulator()
        optimizer.zero_grad(set_to_none=True)
        pending = 0
        train_iter = progress_iter(
            enumerate(train_loader),
            estimated_epoch_steps(stats, "train", args),
            f"stage2/fusion epoch {epoch + 1}/{args.fusion_epochs}",
            args,
        )
        for step, batch in train_iter:
            if args._wall_budget.should_stop():
                print("[wall-time] reserve reached; ending fusion epoch at the next safe checkpoint", flush=True)
                break
            if args.max_steps_per_epoch is not None and step >= int(args.max_steps_per_epoch):
                break
            labels = batch["labels"].to(device, non_blocking=True)
            try:
                with torch.no_grad():
                    required_views = required_views_for_fusion(args, include_extra_long=include_extra)
                    views = move_views_to_device(batch["views"], device, required=required_views)
                    expert_outputs = run_experts(
                        bundle,
                        views,
                        include_extra_long=include_extra,
                        include_spatial=bool(args.use_spatial or args.spatial_checkpoint or args.spatial_stub),
                        include_lip=bool(args.use_lip or args.lip_checkpoint or args.lip_stub),
                        av_context=move_av_context_to_device(batch, device),
                    )
                    if args.fusion_expert_dropout > 0:
                        expert_outputs = apply_fusion_expert_dropout(
                            expert_outputs,
                            float(args.fusion_expert_dropout),
                            dropout_rng,
                        )
                    disagreement = DisagreementComputer.compute(expert_outputs).to(device)
                with autocast_context(device, args.precision):
                    dataset_ids = dataset_ids_from_names(batch["datasets"], dataset_to_id, device)
                    fusion_out = bundle.fusion(expert_outputs, dataset_ids=dataset_ids)
                    loss = criterion(fusion_out["logit"], labels)
                    if not torch.isfinite(loss):
                        print(
                            f"[warn] non-finite fusion loss at epoch={epoch + 1} step={step + 1}; skipping batch",
                            flush=True,
                        )
                        optimizer.zero_grad(set_to_none=True)
                        pending = 0
                        continue
                    scaled_loss = loss / int(args.grad_accum_steps)
                if scaler is not None and getattr(scaler, "is_enabled", lambda: False)():
                    scaler.scale(scaled_loss).backward()
                else:
                    scaled_loss.backward()
                pending += 1
                epoch_metrics.update(
                    loss,
                    labels,
                    fusion_out["probability"],
                    batch["datasets"],
                    disagreement=disagreement,
                    expert_weights=fusion_out.get("expert_weights"),
                )
                if args.log_every_steps and (step + 1) % int(args.log_every_steps) == 0:
                    avg_loss = epoch_metrics.loss_sum / max(1, epoch_metrics.n)
                    if hasattr(train_iter, "set_postfix"):
                        train_iter.set_postfix(loss=f"{avg_loss:.4f}", global_step=global_step, refresh=False)
                    print(
                        f"[train_stage2] epoch={epoch + 1}/{args.fusion_epochs} "
                        f"step={step + 1} samples={epoch_metrics.n} "
                        f"global_step={global_step} avg_loss={avg_loss:.5f}",
                        flush=True,
                    )
                if pending >= int(args.grad_accum_steps):
                    optimizer_step(optimizer, scaler, bundle.fusion, args)
                    global_step += 1
                    pending = 0
            except RuntimeError as exc:
                if is_cuda_oom(exc):
                    print("[oom] skipping fusion batch after CUDA OOM; clearing cache", flush=True)
                    optimizer.zero_grad(set_to_none=True)
                    cleanup_cuda()
                    for expert in [bundle.mid, bundle.long, bundle.extra_long]:
                        if expert is not None:
                            expert.clip_encoder.frame_chunk_size = max(1, int(expert.clip_encoder.frame_chunk_size) // 2)
                    continue
                raise
            finally:
                del labels, batch
                if step % int(args.empty_cache_every_steps) == 0:
                    cleanup_cuda()

        if pending > 0:
            optimizer_step(optimizer, scaler, bundle.fusion, args)
            global_step += 1

        train_metrics = epoch_metrics.compute()
        train_metrics["skipped_videos"] = train_dataset.skipped_videos
        train_metrics["skipped_errors"] = train_dataset.skipped_errors
        assert_training_epoch_has_samples("stage2", train_metrics, train_dataset, manifest_path, args)
        val_metrics = evaluate_fusion(
            bundle,
            val_loader,
            val_dataset,
            args,
            device,
            split=eval_split,
            max_records=args.max_eval_records,
            include_extra_long=include_extra,
            dataset_to_id=dataset_to_id,
        )
        score = val_metrics.get("roc_auc")
        if score is None:
            score = -float(val_metrics.get("loss", 1e9))
        improved = (
            best_metric is None
            or float(score) >= float(best_metric) + float(args.fusion_early_stopping_min_delta)
        )
        if improved:
            best_metric = float(score)
            checks_without_improvement = 0
        else:
            checks_without_improvement += 1

        epoch_summary = {
            "stage": "stage2",
            "epoch": epoch,
            "global_step": global_step,
            "train": train_metrics,
            "validation": val_metrics,
            "best_metric": best_metric,
            "improved": improved,
            "checks_without_improvement": checks_without_improvement,
            "time": timestamp(),
        }
        append_jsonl(log_path, epoch_summary)
        write_json(metrics_path, epoch_summary)
        print(json.dumps(epoch_summary, indent=2, default=json_default), flush=True)

        latest_path = ckpt_dir / checkpoint_basename("stage2", None, "latest")
        save_checkpoint(
            path=latest_path,
            stage="stage2",
            expert="fusion",
            epoch=epoch,
            global_step=global_step,
            model=bundle.fusion,
            optimizer=optimizer,
            scheduler=scheduler,
            scaler=scaler,
            config=config_dict,
            metrics=epoch_summary,
            best_metric=best_metric,
            include_clip_state=False,
        )
        if args.save_every_epoch:
            epoch_path = ckpt_dir / f"stage2_fusion_epoch_{epoch:04d}.pt"
            shutil.copy2(latest_path, epoch_path)
            if args.upload_numbered_epoch_checkpoints:
                hf.upload_file(epoch_path, epoch_path.name)
        if args.upload_latest_to_hf or args.hf_upload_every_epoch:
            hf.upload_file(latest_path, latest_path.name)
        if improved and args.save_best:
            best_path = ckpt_dir / checkpoint_basename("stage2", None, "best")
            shutil.copy2(latest_path, best_path)
            if args.upload_best_to_hf:
                hf.upload_file(best_path, best_path.name)
                save_module_safetensors(bundle.fusion, ckpt_dir / "stage2_fusion_best.safetensors", hf)

        if improved or epoch == run_end_epoch - 1:
            save_final_package(args, hf, bundle, epoch_summary, runtime)
        cleanup_cuda(every_epoch=True)
        if (
            int(args.fusion_early_stopping_patience) > 0
            and checks_without_improvement >= int(args.fusion_early_stopping_patience)
        ):
            print(
                "[early-stop] fusion validation did not improve by "
                f"{args.fusion_early_stopping_min_delta} for {checks_without_improvement} checks",
                flush=True,
            )
            break
        if args._wall_budget.should_stop():
            break


@torch.no_grad()
def evaluate_fusion(
    bundle: ExpertBundle,
    loader: DataLoader,
    dataset: StreamingDeepfakeDataset,
    args: argparse.Namespace,
    device: torch.device,
    split: str,
    max_records: Optional[int] = None,
    include_extra_long: bool = False,
    dataset_to_id: Optional[Dict[str, int]] = None,
    threshold: float = 0.5,
) -> Dict[str, Any]:
    freeze_bundle_experts(bundle)
    assert bundle.fusion is not None
    bundle.fusion.eval()
    if bundle.temperature is not None:
        bundle.temperature.eval()
    criterion = nn.BCEWithLogitsLoss()
    metrics = MetricAccumulator()
    dataset.set_epoch(20_000 + int(time.time()) % 1000)
    seen = 0
    for batch in loader:
        labels = batch["labels"].to(device, non_blocking=True)
        with autocast_context(device, args.precision):
            fusion_out, _, disagreement = fusion_forward_from_batch(
                bundle,
                batch,
                args,
                device,
                include_extra_long=include_extra_long,
                temperature=bundle.temperature,
                dataset_to_id=dataset_to_id,
            )
            logits = fusion_out.get("calibrated_logit", fusion_out["logit"])
            probs = fusion_out.get("calibrated_probability", fusion_out["probability"])
            loss = criterion(logits, labels)
        metrics.update(
            loss,
            labels,
            probs,
            batch["datasets"],
            disagreement=disagreement,
            expert_weights=fusion_out.get("expert_weights"),
        )
        seen += labels.size(0)
        del labels, batch, fusion_out, disagreement, loss
        if max_records is not None and seen >= max_records:
            break
    result = metrics.compute(threshold=float(threshold))
    result["split"] = split
    result["skipped_videos"] = dataset.skipped_videos
    result["skipped_errors"] = dataset.skipped_errors
    return result


def calibrate_fusion(args: argparse.Namespace, hf: HFStore, manifest_path: Path, stats: Dict[str, Any], runtime: RuntimeInfo) -> None:
    if runtime.device == "cpu" and not args.allow_cpu_train:
        print("[calibrate] CPU calibration can be slow; continuing because only one scalar is trained.", flush=True)
    device = torch.device(runtime.device)
    bundle = build_fusion_bundle(args, hf, device, load_experts=True, stats=stats)
    if bundle.fusion is None:
        raise RuntimeError("Calibration requires a fusion model")
    freeze_bundle_experts(bundle)
    bundle.fusion.eval()
    bundle.temperature = TemperatureScaler().to(device)
    optimizer = torch.optim.LBFGS(bundle.temperature.parameters(), lr=args.calibration_lr, max_iter=20)
    criterion = nn.BCEWithLogitsLoss()
    required_views = required_views_for_fusion(args, include_extra_long=bool(args.use_extra_long_in_fusion_training))
    eval_split = ensure_split_has_records(args, stats, args.eval_split)
    dataset_to_id = dataset_to_id_from_stats(stats) if args.fusion_use_dataset_embedding else {}
    val_dataset, val_loader = make_loader(manifest_path, eval_split, required_views, args, hf, stats, train=False)

    logits_list: List[Tensor] = []
    labels_list: List[Tensor] = []
    calibration_datasets: List[str] = []
    seen = 0
    with torch.no_grad():
        for batch in val_loader:
            labels = batch["labels"].to(device, non_blocking=True)
            fusion_out, _, _ = fusion_forward_from_batch(
                bundle,
                batch,
                args,
                device,
                include_extra_long=bool(args.use_extra_long_in_fusion_training and bundle.extra_long is not None),
                dataset_to_id=dataset_to_id,
            )
            logits_list.append(fusion_out["logit"].detach())
            labels_list.append(labels.detach())
            calibration_datasets.extend(str(value) for value in batch["datasets"])
            seen += labels.size(0)
            if args.max_eval_records is not None and seen >= int(args.max_eval_records):
                break
    if not logits_list:
        raise RuntimeError("No validation logits collected for calibration")
    logits = torch.cat(logits_list, dim=0)
    labels = torch.cat(labels_list, dim=0)

    def closure():
        optimizer.zero_grad(set_to_none=True)
        loss = criterion(bundle.temperature(logits), labels)
        loss.backward()
        return loss

    optimizer.step(closure)
    with torch.no_grad():
        calibrated = bundle.temperature(logits)
        loss = criterion(calibrated, labels)
        probs = torch.sigmoid(calibrated)
        threshold_info = select_threshold(
            labels.detach().cpu().view(-1).long().tolist(),
            probs.detach().cpu().view(-1).float().tolist(),
            method=args.threshold_method,
            target_real_fpr=float(args.threshold_target_real_fpr),
            target_fake_recall=float(args.threshold_target_fake_recall),
        )
        metrics = MetricAccumulator()
        metrics.update(loss, labels, probs, calibration_datasets)
        summary = {
            "stage": "stage3",
            "temperature": float(bundle.temperature.temperature.detach().cpu().item()),
            "validation": metrics.compute(threshold=float(threshold_info["threshold"])),
            "threshold_selection": threshold_info,
            "time": timestamp(),
        }
    ckpt_dir = ensure_dir(Path(args.local_cache_dir) / "checkpoints")
    cal_path = ckpt_dir / "stage3_calibration.pt"
    save_checkpoint(
        path=cal_path,
        stage="stage3",
        expert="temperature",
        epoch=0,
        global_step=0,
        model=bundle.temperature,
        optimizer=None,
        scheduler=None,
        scaler=None,
        config=safe_config_dict(args),
        metrics=summary,
        best_metric=-float(summary["validation"].get("loss", 0.0)),
        include_clip_state=False,
    )
    write_json(ckpt_dir / "metrics.json", summary)
    append_jsonl(ckpt_dir / "training_log.jsonl", summary)
    if args.upload_best_to_hf or args.upload_latest_to_hf:
        hf.upload_file(cal_path, cal_path.name)
    threshold_path = ckpt_dir / "threshold.json"
    write_json(threshold_path, threshold_info)
    args.threshold_checkpoint = str(threshold_path)
    if args.upload_best_to_hf or args.upload_latest_to_hf:
        hf.upload_file(threshold_path, threshold_path.name)
    save_final_package(args, hf, bundle, summary, runtime)
    print(json.dumps(summary, indent=2, default=json_default), flush=True)


def _manifest_split_identities(path: Path, split: str) -> set[str]:
    if not path.is_file():
        return set()
    text = path.read_text(encoding="utf-8").strip()
    objects = json.loads(text) if text.startswith("[") else [json.loads(line) for line in text.splitlines() if line.strip()]
    identities: set[str] = set()
    for obj in objects:
        if str(obj.get("split", split)) != split:
            continue
        identity = obj.get("content_sha256") or obj.get("sample_id")
        if not identity:
            archive = obj.get("archive_path")
            member = obj.get("member_path", obj.get("npz_member_path", obj.get("member")))
            if archive and member:
                identity = f"{Path(str(archive)).resolve()}::{member}"
            else:
                value = obj.get("video_path", obj.get("path", obj.get("npz_path")))
                if value:
                    candidate = Path(str(value))
                    identity = str(candidate if candidate.is_absolute() else (path.parent / candidate).resolve())
        if identity:
            identities.add(str(identity).lower())
    return identities


def assert_validation_test_disjoint(args: argparse.Namespace, manifest_path: Path) -> None:
    validation_path = Path(args.validation_manifest) if args.validation_manifest else manifest_path
    test_path = Path(args.test_manifest) if args.test_manifest else manifest_path
    overlap = _manifest_split_identities(validation_path, "val") & _manifest_split_identities(test_path, "test")
    if overlap:
        raise RuntimeError(
            f"Calibration leakage detected: validation and test share {len(overlap)} sample identities"
        )


def calibrate_stage1_expert(
    args: argparse.Namespace,
    hf: HFStore,
    manifest_path: Path,
    stats: Dict[str, Any],
    runtime: RuntimeInfo,
) -> None:
    target = str(args.calibration_target)
    device = torch.device(runtime.device)
    previous_expert = args.expert
    args.expert = target
    try:
        model = build_stage1_expert(args, device)
        checkpoint_spec = getattr(args, f"{target}_checkpoint", None) or default_hf_checkpoint_spec(
            args, f"stage1_{target}_best.pt"
        )
        if not load_optional_checkpoint(model, checkpoint_spec, hf, device, f"{target} expert"):
            raise RuntimeError(f"Calibration requires a trained {target} checkpoint")
        model.eval()
        eval_split = ensure_split_has_records(args, stats, "val")
        dataset, loader = make_loader(
            manifest_path,
            eval_split,
            required_views_for_stage1(target),
            args,
            hf,
            stats,
            train=False,
        )
        dataset.set_epoch(30_000)
        logits_list: List[Tensor] = []
        labels_list: List[Tensor] = []
        calibration_datasets: List[str] = []
        seen = 0
        view = required_views_for_stage1(target)[0]
        with torch.no_grad():
            for batch in loader:
                labels = batch["labels"].to(device, non_blocking=True)
                frames = batch["views"][view].to(device, non_blocking=True)
                with autocast_context(device, args.precision):
                    output = model(frames)
                logits_list.append(output.logit.detach())
                labels_list.append(labels.detach())
                calibration_datasets.extend(str(value) for value in batch["datasets"])
                seen += labels.size(0)
                if args.max_eval_records is not None and seen >= int(args.max_eval_records):
                    break
        if not logits_list:
            raise RuntimeError(f"No validation logits collected for {target} calibration")
        logits = torch.cat(logits_list, dim=0)
        labels = torch.cat(labels_list, dim=0)
        scaler = TemperatureScaler().to(device)
        optimizer = torch.optim.LBFGS(scaler.parameters(), lr=args.calibration_lr, max_iter=40)
        criterion = nn.BCEWithLogitsLoss()

        def closure():
            optimizer.zero_grad(set_to_none=True)
            loss = criterion(scaler(logits), labels)
            loss.backward()
            return loss

        optimizer.step(closure)
        with torch.no_grad():
            calibrated_logits = scaler(logits)
            probabilities = torch.sigmoid(calibrated_logits)
            threshold_info = select_threshold(
                labels.detach().cpu().view(-1).long().tolist(),
                probabilities.detach().cpu().view(-1).float().tolist(),
                method=args.threshold_method,
                target_real_fpr=float(args.threshold_target_real_fpr),
                target_fake_recall=float(args.threshold_target_fake_recall),
            )
            metrics = MetricAccumulator()
            metrics.update(criterion(calibrated_logits, labels), labels, probabilities, calibration_datasets)
            validation_metrics = metrics.compute(threshold=float(threshold_info["threshold"]))
        threshold_info["calibration_target"] = target
        threshold_info["selected_on_split"] = "val"
        summary = {
            "stage": "stage3",
            "calibration_target": target,
            "temperature": float(scaler.temperature.detach().cpu().item()),
            "validation": validation_metrics,
            "threshold_selection": threshold_info,
            "time": timestamp(),
        }
        ckpt_dir = ensure_dir(Path(args.local_cache_dir) / "checkpoints")
        calibration_path = ckpt_dir / f"stage3_{target}_calibration.pt"
        save_checkpoint(
            path=calibration_path,
            stage="stage3",
            expert=target,
            epoch=0,
            global_step=0,
            model=scaler,
            optimizer=None,
            scheduler=None,
            scaler=None,
            config=safe_config_dict(args),
            metrics=summary,
            best_metric=-float(validation_metrics.get("loss", 0.0)),
            include_clip_state=False,
        )
        threshold_path = ckpt_dir / f"threshold_{target}.json"
        metrics_path = ckpt_dir / f"metrics_calibration_{target}.json"
        write_json(threshold_path, threshold_info)
        write_json(metrics_path, summary)
        append_jsonl(ckpt_dir / "training_log.jsonl", summary)
        if args.upload_best_to_hf or args.upload_latest_to_hf:
            hf.upload_file(calibration_path, calibration_path.name)
            hf.upload_file(threshold_path, threshold_path.name)
            hf.upload_file(metrics_path, metrics_path.name)
        print(json.dumps(summary, indent=2, default=json_default), flush=True)
    finally:
        args.expert = previous_expert


def calibrate(args: argparse.Namespace, hf: HFStore, manifest_path: Path, stats: Dict[str, Any], runtime: RuntimeInfo) -> None:
    if args.eval_split != "val":
        raise ValueError("Calibration is validation-only; use --eval-split val")
    assert_validation_test_disjoint(args, manifest_path)
    if args.calibration_target == "fusion":
        calibrate_fusion(args, hf, manifest_path, stats, runtime)
    else:
        calibrate_stage1_expert(args, hf, manifest_path, stats, runtime)


def evaluate_mode(args: argparse.Namespace, hf: HFStore, manifest_path: Path, stats: Dict[str, Any], runtime: RuntimeInfo) -> None:
    device = torch.device(runtime.device)
    eval_split = ensure_split_has_records(args, stats, args.eval_split)
    bundle: Optional[ExpertBundle] = None
    threshold = 0.5
    threshold_metadata: Optional[Dict[str, Any]] = None
    if args.threshold_checkpoint:
        threshold_path = resolve_checkpoint_path(args.threshold_checkpoint, hf)
        if threshold_path:
            threshold_metadata = json.loads(Path(threshold_path).read_text(encoding="utf-8"))
            threshold_target = threshold_metadata.get("calibration_target")
            if args.expert and threshold_target and threshold_target != args.expert:
                raise RuntimeError(
                    f"Threshold target mismatch: expected {args.expert!r}, got {threshold_target!r}"
                )
            threshold = float(threshold_metadata["threshold"])
    if args.expert and args.mode == "eval" and not args.fusion_checkpoint:
        model = build_stage1_expert(args, device)
        spec = getattr(args, f"{args.expert}_checkpoint", None) or default_hf_checkpoint_spec(args, f"stage1_{args.expert}_best.pt")
        load_optional_checkpoint(model, spec, hf, device, f"{args.expert} expert")
        expert_temperature: Optional[TemperatureScaler] = None
        if args.calibration_checkpoint:
            expert_temperature = TemperatureScaler().to(device)
            load_calibration_checkpoint(
                expert_temperature,
                args.calibration_checkpoint,
                hf,
                device,
                args.expert,
            )
        required_views = required_views_for_stage1(args.expert)
        dataset, loader = make_loader(manifest_path, eval_split, required_views, args, hf, stats, train=False)
        metrics = evaluate_stage1_expert(
            model,
            loader,
            dataset,
            args,
            device,
            eval_split,
            args.max_eval_records,
            expert_temperature,
            threshold,
        )
    else:
        bundle = build_fusion_bundle(args, hf, device, load_experts=True, stats=stats)
        include_extra = bool(args.eval_include_extra_long and bundle.extra_long is not None)
        required_views = required_views_for_fusion(args, include_extra_long=include_extra)
        dataset, loader = make_loader(manifest_path, eval_split, required_views, args, hf, stats, train=False)
        dataset_to_id = dataset_to_id_from_stats(stats) if args.fusion_use_dataset_embedding else {}
        metrics = evaluate_fusion(
            bundle,
            loader,
            dataset,
            args,
            device,
            eval_split,
            args.max_eval_records,
            include_extra,
            dataset_to_id,
            threshold,
        )
    ckpt_dir = ensure_dir(Path(args.local_cache_dir) / "checkpoints")
    if threshold_metadata is not None:
        metrics["threshold_selection"] = threshold_metadata
    metrics_path = ckpt_dir / f"metrics_{eval_split}.json"
    write_json(metrics_path, metrics)
    append_jsonl(ckpt_dir / "training_log.jsonl", {"stage": "evaluation", "metrics": metrics, "time": timestamp()})
    if bundle is not None:
        save_final_package(args, hf, bundle, metrics, runtime)
    if args.hf_repo_id:
        hf.upload_file(metrics_path, metrics_path.name)
        hf.upload_file(ckpt_dir / "training_log.jsonl", "training_log.jsonl")
    print(json.dumps(metrics, indent=2, default=json_default), flush=True)


def _atomic_save_npz(path: Path, arrays: Dict[str, Any], *, compressed: bool = True) -> None:
    ensure_dir(path.parent)
    temp = path.with_suffix(path.suffix + ".partial")
    with temp.open("wb") as handle:
        writer = np.savez_compressed if compressed else np.savez
        writer(handle, **arrays)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp, path)


def _checkpoint_specs_for_cache(args: argparse.Namespace) -> Dict[str, Optional[str]]:
    specs: Dict[str, Optional[str]] = {
        "micro": args.micro_checkpoint or default_hf_checkpoint_spec(args, "stage1_micro_best.pt"),
        "mid": args.mid_checkpoint or default_hf_checkpoint_spec(args, "stage1_mid_best.pt"),
        "long": args.long_checkpoint or default_hf_checkpoint_spec(args, "stage1_long_best.pt"),
        "extra_long": args.extra_long_checkpoint or default_hf_checkpoint_spec(args, "stage1_extra_long_best.pt"),
    }
    if bool(args.use_spatial or args.spatial_checkpoint or args.spatial_stub):
        specs["spatial"] = args.spatial_checkpoint
    if bool(args.use_lip or args.lip_checkpoint or args.lip_stub):
        specs["lip_sync"] = args.lip_checkpoint
    return specs


@torch.no_grad()
def cache_expert_outputs(
    args: argparse.Namespace,
    hf: HFStore,
    manifest_path: Path,
    stats: Dict[str, Any],
    runtime: RuntimeInfo,
) -> Dict[str, Any]:
    cache_root = ensure_dir(args.expert_cache_root)
    specs = _checkpoint_specs_for_cache(args)
    required_experts = list(specs)
    fingerprints: Dict[str, str] = {}
    for name in required_experts:
        spec = specs[name]
        if not spec:
            raise RuntimeError(f"cache generation requires checkpoint for {name}")
        resolved = resolve_checkpoint_path(spec, hf)
        if not resolved:
            raise RuntimeError(f"could not resolve checkpoint for {name}: {spec}")
        fingerprints[name] = checkpoint_fingerprint(resolved)
    existing_meta = cache_root / "cache_meta.json"
    source_manifest_paths = {
        "train": str(manifest_path),
        "val": str(args.validation_manifest) if args.validation_manifest else str(manifest_path),
        "test": str(args.test_manifest) if args.test_manifest else str(manifest_path),
    }
    source_manifest_fingerprints = {
        split: manifest_digest(Path(path)) for split, path in source_manifest_paths.items()
    }
    if args.rebuild_expert_cache:
        with contextlib.suppress(FileNotFoundError):
            (cache_root / "READY").unlink()
    if (cache_root / "READY").is_file() and existing_meta.is_file() and not args.rebuild_expert_cache:
        existing = json.loads(existing_meta.read_text(encoding="utf-8"))
        if existing.get("expert_checkpoint_fingerprints") != fingerprints:
            raise RuntimeError("expert cache checkpoint fingerprints changed; pass --rebuild-expert-cache")
        if existing.get("source_manifest_fingerprints") != source_manifest_fingerprints:
            raise RuntimeError("expert cache source manifests changed; pass --rebuild-expert-cache")
        return validate_expert_cache(
            cache_root,
            required_experts=required_experts,
            exact_expert_order=required_experts,
            verify_arrays=True,
        )

    device = torch.device(runtime.device)
    bundle = build_fusion_bundle(args, hf, device, load_experts=True, stats=stats)
    freeze_bundle_experts(bundle)
    include_extra = bundle.extra_long is not None
    if not include_extra:
        raise RuntimeError("expert cache requires the corrected extra-long expert")
    required_views = required_views_for_fusion(args, include_extra_long=True)
    if args.auto_tune_batch_size and device.type == "cuda":
        if bundle.fusion is None:
            raise RuntimeError("expert cache auto-tuning requires a fusion module")
        cache_probe_criterion = nn.BCEWithLogitsLoss()
        dataset_to_id = dataset_to_id_from_stats(stats) if args.fusion_use_dataset_embedding else {}
        with torch.enable_grad():
            auto_tune_fusion_resources(
                bundle,
                cache_probe_criterion,
                manifest_path,
                required_views,
                True,
                dataset_to_id,
                args,
                hf,
                stats,
                device,
            )
    split_counts: Dict[str, int] = {}
    global_sidecars: List[Path] = []
    for split in args.cache_splits:
            split_dir = ensure_dir(cache_root / split)
            state_path = split_dir / "state.json"
            if args.rebuild_expert_cache:
                for path in split_dir.glob("cache-*.npz"):
                    path.unlink()
                for path in split_dir.glob("cache-*.jsonl"):
                    path.unlink()
            recovered = recover_completed_cache_shards(
                split_dir,
                required_experts=required_experts,
            )
            existing_sidecars = list(recovered["valid_sidecars"])
            completed_ids = set(recovered["completed_ids"])
            next_shard = int(recovered["next_shard"])
            if recovered["ignored"]:
                print(
                    "[cache] ignoring incomplete restored shards "
                    + json.dumps(recovered["ignored"], indent=2),
                    flush=True,
                )
            state = {"records": len(completed_ids), "next_shard": next_shard}
            atomic_write_json(state_path, state)
            _, loader = make_loader(manifest_path, split, required_views, args, hf, stats, train=False)
            if split == "train":
                expected_records = int(stats.get("by_split", {}).get("train", 0))
            elif split == "val" and args.validation_manifest:
                expected_records = int(count_manifest(Path(args.validation_manifest)).get("by_split", {}).get("val", 0))
            elif split == "test" and args.test_manifest:
                expected_records = int(count_manifest(Path(args.test_manifest)).get("by_split", {}).get("test", 0))
            else:
                expected_records = int(stats.get("by_split", {}).get(split, 0))
            if args.limit_records is not None:
                expected_records = min(expected_records, int(args.limit_records))
            if int(state["records"]) == expected_records and expected_records > 0:
                split_counts[split] = expected_records
                global_sidecars.extend(existing_sidecars)
                print(f"[cache] resume skip completed split={split} records={expected_records}", flush=True)
                continue
            pending_embeddings: List[np.ndarray] = []
            pending_logits: List[np.ndarray] = []
            pending_labels: List[int] = []
            pending_ids: List[str] = []
            pending_datasets: List[str] = []

            def flush_cache() -> None:
                nonlocal pending_embeddings, pending_logits, pending_labels, pending_ids, pending_datasets, state
                if not pending_labels:
                    return
                shard_index = int(state["next_shard"])
                shard_name = f"cache-{shard_index:05d}.npz"
                shard_path = split_dir / shard_name
                sidecar = split_dir / f"cache-{shard_index:05d}.jsonl"
                arrays = {
                    "sample_ids": np.asarray(pending_ids, dtype=np.str_),
                    "labels": np.asarray(pending_labels, dtype=np.int8),
                    "datasets": np.asarray(pending_datasets, dtype=np.str_),
                    "expert_names": np.asarray(required_experts, dtype=np.str_),
                    "embeddings": np.stack(pending_embeddings, axis=0).astype(np.float16),
                    "logits": np.stack(pending_logits, axis=0).astype(np.float32),
                    "probabilities": 1.0 / (1.0 + np.exp(-np.stack(pending_logits, axis=0).astype(np.float32))),
                }
                _atomic_save_npz(
                    shard_path,
                    arrays,
                    compressed=bool(args.compress_expert_cache),
                )
                sidecar_rows = []
                for row_index, (sample_id, label, dataset) in enumerate(
                    zip(pending_ids, pending_labels, pending_datasets)
                ):
                    sidecar_rows.append(
                        {
                            "sample_id": sample_id,
                            "record_hash": sample_id,
                            "label": int(label),
                            "dataset": dataset,
                            "split": split,
                            "shard_path": f"{split}/{shard_name}",
                            "row_index": row_index,
                        }
                    )
                temp_sidecar = sidecar.with_suffix(".jsonl.partial")
                temp_sidecar.write_text(
                    "".join(json.dumps(row, sort_keys=True) + "\n" for row in sidecar_rows),
                    encoding="utf-8",
                )
                os.replace(temp_sidecar, sidecar)
                state["records"] = int(state["records"]) + len(pending_labels)
                state["next_shard"] = shard_index + 1
                atomic_write_json(state_path, state)
                pending_embeddings = []
                pending_logits = []
                pending_labels = []
                pending_ids = []
                pending_datasets = []

            for batch in loader:
                batch_size = int(batch["labels"].shape[0])
                views = move_views_to_device(batch["views"], device, required=required_views)
                outputs = run_experts(
                    bundle,
                    views,
                    include_extra_long=True,
                    include_spatial="spatial" in required_experts,
                    include_lip="lip_sync" in required_experts,
                    av_context=move_av_context_to_device(batch, device) if "lip_sync" in required_experts else None,
                )
                output_by_name = {output.name: output for output in outputs}
                embedding_batch = torch.stack(
                    [output_by_name[name].embedding for name in required_experts], dim=1
                ).detach().cpu().numpy()
                logit_batch = torch.stack(
                    [output_by_name[name].logit.squeeze(-1) for name in required_experts], dim=1
                ).detach().cpu().numpy()
                labels = batch["labels"].view(-1).long().tolist()
                for index in range(batch_size):
                    record = batch["records"][index]
                    sample_id = str(
                        record.get("sample_id")
                        or record.get("content_sha256")
                        or record.get("video_path")
                    )
                    if sample_id in completed_ids:
                        continue
                    pending_ids.append(sample_id)
                    pending_labels.append(int(labels[index]))
                    pending_datasets.append(str(batch["datasets"][index]))
                    pending_embeddings.append(embedding_batch[index])
                    pending_logits.append(logit_batch[index])
                    completed_ids.add(sample_id)
                if len(pending_labels) >= int(args.cache_shard_records):
                    flush_cache()
                if args._wall_budget.should_stop():
                    flush_cache()
                    raise TimeoutError("wall-time reserve reached during expert cache generation")
            flush_cache()
            split_counts[split] = int(state["records"])
            if int(state["records"]) != expected_records:
                raise RuntimeError(
                    f"expert cache {split} count mismatch: expected={expected_records} actual={state['records']}"
                )
            completed_recovery = recover_completed_cache_shards(
                split_dir,
                required_experts=required_experts,
            )
            if len(completed_recovery["completed_ids"]) != expected_records:
                raise RuntimeError(
                    f"cache split {split} recovered count mismatch after generation: "
                    f"expected={expected_records} actual={len(completed_recovery['completed_ids'])}"
                )
            global_sidecars.extend(completed_recovery["valid_sidecars"])
    manifest_out = cache_root / "cache_manifest.jsonl"
    manifest_temp = manifest_out.with_suffix(".jsonl.partial")
    with manifest_temp.open("w", encoding="utf-8") as output:
        for sidecar in global_sidecars:
            output.write(sidecar.read_text(encoding="utf-8"))
    os.replace(manifest_temp, manifest_out)
    meta = {
        "schema_version": 1,
        "created_at": timestamp(),
        "expert_names": required_experts,
        "embedding_dim": int(args.embedding_dim),
        "expert_checkpoint_specs": specs,
        "expert_checkpoint_fingerprints": fingerprints,
        "counts": split_counts,
        "source_manifests": source_manifest_paths,
        "source_manifest_fingerprints": source_manifest_fingerprints,
    }
    atomic_write_json(existing_meta, meta)
    ready_temp = cache_root / "READY.partial"
    ready_temp.write_text(json.dumps(fingerprints, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(ready_temp, cache_root / "READY")
    report = validate_expert_cache(
        cache_root,
        expected_split_counts=split_counts,
        required_experts=required_experts,
        exact_expert_order=required_experts,
        verify_arrays=True,
    )
    write_json(cache_root / "cache_validation.json", report)
    if args.hf_repo_id and args.upload_expert_cache_metadata:
        hf.upload_file(existing_meta, f"expert_cache/{existing_meta.name}")
        hf.upload_file(manifest_out, f"expert_cache/{manifest_out.name}")
        hf.upload_file(cache_root / "cache_validation.json", "expert_cache/cache_validation.json")
    print("[cache] " + json.dumps(report, indent=2), flush=True)
    return report


class CachedExpertDataset(IterableDataset):
    def __init__(
        self,
        root: str | Path,
        split: str,
        train: bool = False,
        seed: int = 1337,
        in_memory: bool = False,
    ) -> None:
        self.root = Path(root)
        self.split = split
        self.train = train
        self.seed = int(seed)
        self.epoch = 0
        self.sidecars = sorted((self.root / split).glob("cache-*.jsonl"))
        if not self.sidecars:
            raise RuntimeError(f"expert cache has no sidecars for split={split}: {self.root}")
        self.memory: Optional[Dict[str, Any]] = None
        if in_memory:
            self.memory = self._load_in_memory()

    def _load_in_memory(self) -> Dict[str, Any]:
        embedding_parts: List[np.ndarray] = []
        logit_parts: List[np.ndarray] = []
        labels: List[int] = []
        sample_ids: List[str] = []
        datasets: List[str] = []
        expected_names: Optional[List[str]] = None
        for sidecar in self.sidecars:
            rows = [json.loads(line) for line in sidecar.read_text(encoding="utf-8").splitlines() if line.strip()]
            if not rows:
                continue
            indices = np.asarray([int(row["row_index"]) for row in rows], dtype=np.int64)
            with np.load(self.root / rows[0]["shard_path"], allow_pickle=False) as data:
                names = [str(value) for value in data["expert_names"].tolist()]
                if expected_names is None:
                    expected_names = names
                elif names != expected_names:
                    raise RuntimeError(f"in-memory cache mixes expert orders in {sidecar}")
                embedding_parts.append(np.asarray(data["embeddings"])[indices].astype(np.float32, copy=True))
                logit_parts.append(np.asarray(data["logits"])[indices].astype(np.float32, copy=True))
            labels.extend(int(row["label"]) for row in rows)
            sample_ids.extend(str(row["sample_id"]) for row in rows)
            datasets.extend(str(row["dataset"]) for row in rows)
        if expected_names is None or not embedding_parts:
            raise RuntimeError(f"could not preload expert cache split={self.split}: {self.root}")
        memory = {
            "expert_names": expected_names,
            "embeddings": np.concatenate(embedding_parts, axis=0),
            "logits": np.concatenate(logit_parts, axis=0),
            "labels": np.asarray(labels, dtype=np.float32),
            "sample_ids": np.asarray(sample_ids, dtype=np.str_),
            "datasets": np.asarray(datasets, dtype=np.str_),
        }
        array_bytes = sum(int(value.nbytes) for value in memory.values() if isinstance(value, np.ndarray))
        print(
            f"[cache-in-memory] split={self.split} records={len(labels):,} "
            f"arrays={array_bytes / 1024**3:.3f} GiB; compressed shards will not be reread each epoch",
            flush=True,
        )
        return memory

    def set_epoch(self, epoch: int) -> None:
        self.epoch = int(epoch)

    def __iter__(self) -> Iterator[Dict[str, Any]]:
        worker = get_worker_info()
        worker_id = worker.id if worker else 0
        workers = worker.num_workers if worker else 1
        if self.memory is not None:
            memory = self.memory
            order = list(range(int(memory["labels"].shape[0])))
            rng = random.Random(self.seed + self.epoch * 1009)
            if self.train:
                rng.shuffle(order)
            names = list(memory["expert_names"])
            for position, index in enumerate(order):
                if position % workers != worker_id:
                    continue
                yield {
                    "sample_id": str(memory["sample_ids"][index]),
                    "label": float(memory["labels"][index]),
                    "dataset": str(memory["datasets"][index]),
                    "expert_names": names,
                    "embeddings": torch.from_numpy(memory["embeddings"][index]),
                    "logits": torch.from_numpy(memory["logits"][index]),
                }
            return
        sidecars = list(self.sidecars)
        rng = random.Random(self.seed + self.epoch * 1009 + worker_id)
        if self.train:
            rng.shuffle(sidecars)
        for shard_index, sidecar in enumerate(sidecars):
            if shard_index % workers != worker_id:
                continue
            rows = [json.loads(line) for line in sidecar.read_text(encoding="utf-8").splitlines() if line.strip()]
            if not rows:
                continue
            with np.load(self.root / rows[0]["shard_path"], allow_pickle=False) as data:
                names = [str(value) for value in data["expert_names"].tolist()]
                selected_rows = list(rows)
                if self.train:
                    rng.shuffle(selected_rows)
                for row in selected_rows:
                    index = int(row["row_index"])
                    yield {
                        "sample_id": str(row["sample_id"]),
                        "label": float(row["label"]),
                        "dataset": str(row["dataset"]),
                        "expert_names": names,
                        "embeddings": torch.from_numpy(data["embeddings"][index].astype(np.float32)),
                        "logits": torch.from_numpy(data["logits"][index].astype(np.float32)),
                    }


def collate_cached(samples: List[Dict[str, Any]]) -> Dict[str, Any]:
    names = list(samples[0]["expert_names"])
    mismatched = [
        index for index, sample in enumerate(samples) if list(sample["expert_names"]) != names
    ]
    if mismatched:
        raise RuntimeError(f"cached batch mixes expert orders; first mismatches={mismatched[:8]}")
    return {
        "sample_ids": [sample["sample_id"] for sample in samples],
        "labels": torch.tensor([[sample["label"]] for sample in samples], dtype=torch.float32),
        "datasets": [sample["dataset"] for sample in samples],
        "expert_names": names,
        "embeddings": torch.stack([sample["embeddings"] for sample in samples]),
        "logits": torch.stack([sample["logits"] for sample in samples]),
    }


def make_cached_loader(args: argparse.Namespace, split: str, train: bool = False) -> Tuple[CachedExpertDataset, DataLoader]:
    dataset = CachedExpertDataset(
        args.expert_cache_root,
        split,
        train=train,
        seed=int(args.seed),
        in_memory=bool(args.cache_in_memory),
    )
    kwargs: Dict[str, Any] = {}
    if int(args.num_workers) > 0:
        kwargs["prefetch_factor"] = int(args.prefetch_factor)
        kwargs["timeout"] = float(args.dataloader_timeout)
    return dataset, DataLoader(
        dataset,
        batch_size=int(args.cached_fusion_batch_size or args.batch_size),
        num_workers=int(args.num_workers),
        collate_fn=collate_cached,
        pin_memory=torch.cuda.is_available(),
        persistent_workers=False,
        **kwargs,
    )


def cached_outputs_from_batch(batch: Dict[str, Any], device: torch.device) -> List[ExpertOutput]:
    embeddings = batch["embeddings"].to(device, non_blocking=True)
    logits = batch["logits"].to(device, non_blocking=True)
    names = [str(value) for value in batch["expert_names"]]
    if embeddings.ndim != 3 or logits.ndim != 2:
        raise RuntimeError(
            f"cached tensor rank mismatch: embeddings={tuple(embeddings.shape)} logits={tuple(logits.shape)}"
        )
    if embeddings.shape[1] != len(names) or logits.shape[1] != len(names):
        raise RuntimeError(
            "cached expert-axis mismatch: "
            f"names={len(names)} embeddings={embeddings.shape[1]} logits={logits.shape[1]}"
        )
    if names != EXPERT_ORDER:
        raise RuntimeError(f"cached expert order mismatch: expected={EXPERT_ORDER} actual={names}")
    return [
        make_expert_output(name, embeddings[:, index], logits[:, index : index + 1])
        for index, name in enumerate(names)
    ]


@torch.no_grad()
def evaluate_cached_fusion(
    model: FusionTransformer,
    loader: DataLoader,
    args: argparse.Namespace,
    device: torch.device,
    threshold: float = 0.5,
    temperature: Optional[TemperatureScaler] = None,
) -> Dict[str, Any]:
    model.eval()
    if temperature is not None:
        temperature.eval()
    accumulator = MetricAccumulator()
    criterion = nn.BCEWithLogitsLoss()
    seen = 0
    for batch in loader:
        labels = batch["labels"].to(device, non_blocking=True)
        outputs = cached_outputs_from_batch(batch, device)
        fused = model(outputs)
        logits = temperature(fused["logit"]) if temperature is not None else fused["logit"]
        probabilities = torch.sigmoid(logits)
        loss = criterion(logits, labels)
        accumulator.update(loss, labels, probabilities, batch["datasets"])
        seen += labels.size(0)
        if args.max_eval_records is not None and seen >= int(args.max_eval_records):
            break
    return accumulator.compute(threshold=threshold)


def cached_label_counts(root: str | Path, split: str) -> Dict[int, int]:
    counts = {0: 0, 1: 0}
    for sidecar in sorted((Path(root) / split).glob("cache-*.jsonl")):
        for line in sidecar.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            label = int(json.loads(line)["label"])
            if label not in counts:
                raise RuntimeError(f"cached fusion found invalid label {label} in {sidecar}")
            counts[label] += 1
    return counts


def build_cached_fusion_model(
    args: argparse.Namespace,
    hf: HFStore,
    device: torch.device,
) -> FusionTransformer:
    model = FusionTransformer(
        embedding_dim=int(args.embedding_dim),
        fusion_dim=int(args.fusion_dim),
        num_layers=int(args.fusion_layers),
        num_heads=int(args.fusion_heads),
        dropout=float(args.fusion_dropout),
        expert_names=EXPERT_ORDER,
        use_disagreement_features=bool(args.fusion_use_disagreement_features),
    ).to(device)
    spec = args.fusion_checkpoint or default_hf_checkpoint_spec(args, "stage2_fusion_best.pt")
    if not spec or not load_optional_checkpoint(model, spec, hf, device, "cached fusion model"):
        raise RuntimeError("A trained --fusion-checkpoint is required for cached calibration/evaluation")
    model.eval()
    return model


def auto_tune_cached_fusion_resources(
    model: FusionTransformer,
    args: argparse.Namespace,
    device: torch.device,
) -> None:
    if not args.auto_tune_batch_size or device.type != "cuda":
        return
    saved_batch = args.cached_fusion_batch_size
    saved_workers = args.num_workers
    try:
        args.cached_fusion_batch_size = 1
        args.num_workers = 0
        _, probe_loader = make_cached_loader(args, "train", train=False)
        one = next(iter(probe_loader))
    finally:
        args.cached_fusion_batch_size = saved_batch
        args.num_workers = saved_workers
    criterion = nn.BCEWithLogitsLoss()

    def probe(candidate: int) -> None:
        batch = repeat_cached_probe_batch(one, candidate, repeat_batch_tree)
        labels = batch["labels"].to(device, non_blocking=True)
        model.zero_grad(set_to_none=True)
        with autocast_context(device, args.precision):
            outputs = cached_outputs_from_batch(batch, device)
            fused = model(outputs)
            loss = criterion(fused["logit"], labels)
        loss.backward()
        model.zero_grad(set_to_none=True)

    args.cached_fusion_batch_size, report = autotune_cuda_batch_size(
        probe,
        initial_batch_size=1,
        max_batch_size=ram_limited_batch_cap(
            sample_bytes=tensor_tree_nbytes(one),
            configured_max=int(args.max_auto_cached_batch_size),
            target_fraction=float(args.target_ram_fraction),
            reserve_gib=float(args.ram_reserve_gib),
        ),
        target_vram_fraction=float(args.target_vram_fraction),
        vram_reserve_gib=float(args.vram_reserve_gib),
        label="cached_multimodal_fusion",
    )
    args.prefetch_factor = ram_budgeted_prefetch(
        sample_bytes=tensor_tree_nbytes(one),
        batch_size=int(args.cached_fusion_batch_size),
        workers=int(args.num_workers),
        target_fraction=float(args.target_ram_fraction),
        reserve_gib=float(args.ram_reserve_gib),
        minimum=1,
        maximum=max(1, int(args.prefetch_factor)),
    )
    report.update({"num_workers": int(args.num_workers), "prefetch_factor": int(args.prefetch_factor)})
    atomic_write_json(
        Path(args.local_cache_dir) / "checkpoints" / "RESOURCE_AUTOTUNE_cached_fusion.json",
        report,
    )


def train_cached_fusion(
    args: argparse.Namespace,
    hf: HFStore,
    runtime: RuntimeInfo,
) -> None:
    cache_report = validate_expert_cache(
        args.expert_cache_root,
        required_experts=EXPERT_ORDER,
        exact_expert_order=EXPERT_ORDER,
        verify_arrays=bool(args.verify_cache_arrays),
    )
    if runtime.device == "cpu" and not args.allow_cpu_train:
        raise RuntimeError("cached fusion training requires CUDA unless --allow-cpu-train")
    device = torch.device(runtime.device)
    model = FusionTransformer(
        embedding_dim=int(args.embedding_dim),
        fusion_dim=int(args.fusion_dim),
        num_layers=int(args.fusion_layers),
        num_heads=int(args.fusion_heads),
        dropout=float(args.fusion_dropout),
        expert_names=EXPERT_ORDER,
        use_disagreement_features=bool(args.fusion_use_disagreement_features),
    ).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=float(args.fusion_lr), weight_decay=float(args.fusion_weight_decay))
    scaler = make_grad_scaler(device, args.precision)
    start_epoch = 0
    global_step = 0
    best_metric: Optional[float] = None
    checks_without_improvement = 0
    resume_path = find_resume_checkpoint(args, hf, "stage2", None)
    if resume_path:
        model_only = args.resume_policy == "model-only"
        checkpoint = load_training_checkpoint(
            resume_path,
            model,
            optimizer,
            None,
            scaler,
            map_location=device,
            load_optimizer_state=not model_only,
            load_scheduler_state=False,
            load_scaler_state=not model_only,
        )
        if not model_only:
            start_epoch = int(checkpoint.get("epoch", -1)) + 1
            global_step = int(checkpoint.get("global_step", 0))
            best_metric = checkpoint.get("best_validation_metric")
            checks_without_improvement = int((checkpoint.get("metrics") or {}).get("checks_without_improvement", 0))
    auto_tune_cached_fusion_resources(model, args, device)
    train_dataset, train_loader = make_cached_loader(args, "train", train=True)
    _, val_loader = make_cached_loader(args, "val")
    label_counts = cached_label_counts(args.expert_cache_root, "train")
    if label_counts[0] < 1 or label_counts[1] < 1:
        raise RuntimeError(f"cached fusion training requires both classes; found {label_counts}")
    pos_weight = (
        torch.tensor([label_counts[0] / label_counts[1]], dtype=torch.float32, device=device)
        if args.class_balanced_loss else None
    )
    criterion = nn.BCEWithLogitsLoss(pos_weight=pos_weight)
    ckpt_dir = ensure_dir(Path(args.local_cache_dir) / "checkpoints")
    epoch_range = bounded_epoch_range(start_epoch, int(args.fusion_epochs), args.fusion_epochs_this_run)
    if (
        int(args.fusion_early_stopping_patience) > 0
        and checks_without_improvement >= int(args.fusion_early_stopping_patience)
    ):
        epoch_range = range(epoch_range.stop, epoch_range.stop)
    for epoch in epoch_range:
        model.train()
        train_dataset.set_epoch(epoch)
        dropout_rng = random.Random(int(args.seed) + epoch * 7919)
        accumulator = MetricAccumulator()
        for step, batch in enumerate(train_loader):
            if args.max_steps_per_epoch is not None and step >= int(args.max_steps_per_epoch):
                break
            labels = batch["labels"].to(device, non_blocking=True)
            outputs = cached_outputs_from_batch(batch, device)
            if float(args.fusion_expert_dropout) > 0:
                outputs = apply_fusion_expert_dropout(outputs, float(args.fusion_expert_dropout), dropout_rng)
            optimizer.zero_grad(set_to_none=True)
            with autocast_context(device, args.precision):
                fused = model(outputs)
                loss = criterion(fused["logit"], labels)
            if scaler is not None and getattr(scaler, "is_enabled", lambda: False)():
                scaler.scale(loss).backward()
                scaler.step(optimizer)
                scaler.update()
            else:
                loss.backward()
                optimizer.step()
            global_step += 1
            accumulator.update(loss, labels, fused["probability"], batch["datasets"])
            if args._wall_budget.should_stop():
                break
        train_metrics = accumulator.compute()
        val_metrics = evaluate_cached_fusion(model, val_loader, args, device)
        score = val_metrics.get("roc_auc")
        improved = best_metric is None or (score is not None and float(score) >= float(best_metric) + float(args.fusion_early_stopping_min_delta))
        if improved:
            best_metric = float(score) if score is not None else best_metric
            checks_without_improvement = 0
        else:
            checks_without_improvement += 1
        summary = {
            "stage": "cached_fusion",
            "epoch": epoch,
            "global_step": global_step,
            "train": train_metrics,
            "validation": val_metrics,
            "best_metric": best_metric,
            "improved": improved,
            "checks_without_improvement": checks_without_improvement,
            "cache": cache_report,
            "train_label_counts": label_counts,
            "time": timestamp(),
        }
        latest = ckpt_dir / "stage2_fusion_latest.pt"
        save_checkpoint(
            path=latest,
            stage="stage2",
            expert="fusion",
            epoch=epoch,
            global_step=global_step,
            model=model,
            optimizer=optimizer,
            scheduler=None,
            scaler=scaler,
            config=safe_config_dict(args),
            metrics=summary,
            best_metric=best_metric,
            include_clip_state=False,
        )
        write_json(ckpt_dir / "metrics.json", summary)
        append_jsonl(ckpt_dir / "training_log.jsonl", summary)
        if args.upload_latest_to_hf or args.hf_upload_every_epoch:
            hf.upload_file(latest, latest.name)
        if improved:
            best = ckpt_dir / "stage2_fusion_best.pt"
            shutil.copy2(latest, best)
            if args.upload_best_to_hf:
                hf.upload_file(best, best.name)
                save_module_safetensors(model, ckpt_dir / "stage2_fusion_best.safetensors", hf)
        if int(args.fusion_early_stopping_patience) > 0 and checks_without_improvement >= int(args.fusion_early_stopping_patience):
            break
        if args._wall_budget.should_stop():
            break
    bundle = ExpertBundle(fusion=model)
    save_final_package(args, hf, bundle, summary if 'summary' in locals() else {"cache": cache_report}, runtime)


def calibrate_cached_fusion(args: argparse.Namespace, hf: HFStore, runtime: RuntimeInfo) -> None:
    if args.eval_split != "val":
        raise ValueError("Cached calibration is validation-only; use --eval-split val")
    cache_report = validate_expert_cache(
        args.expert_cache_root,
        required_experts=EXPERT_ORDER,
        exact_expert_order=EXPERT_ORDER,
        verify_arrays=bool(args.verify_cache_arrays),
    )
    for split in ("val", "test"):
        if int(cache_report.get("counts", {}).get(split, 0)) < 1:
            raise RuntimeError(f"expert cache is missing required {split} records")
    device = torch.device(runtime.device)
    model = build_cached_fusion_model(args, hf, device)
    _, loader = make_cached_loader(args, "val", train=False)
    temperature = TemperatureScaler().to(device)
    optimizer = torch.optim.LBFGS(temperature.parameters(), lr=args.calibration_lr, max_iter=20)
    criterion = nn.BCEWithLogitsLoss()
    logits_list: List[Tensor] = []
    labels_list: List[Tensor] = []
    datasets: List[str] = []
    seen = 0
    with torch.no_grad():
        for batch in loader:
            labels = batch["labels"].to(device, non_blocking=True)
            outputs = cached_outputs_from_batch(batch, device)
            logits_list.append(model(outputs)["logit"].detach())
            labels_list.append(labels.detach())
            datasets.extend(str(value) for value in batch["datasets"])
            seen += labels.size(0)
            if args.max_eval_records is not None and seen >= int(args.max_eval_records):
                break
    if not logits_list:
        raise RuntimeError("No cached validation logits were available for calibration")
    logits = torch.cat(logits_list, dim=0)
    labels = torch.cat(labels_list, dim=0)

    def closure():
        optimizer.zero_grad(set_to_none=True)
        loss = criterion(temperature(logits), labels)
        loss.backward()
        return loss

    optimizer.step(closure)
    with torch.no_grad():
        calibrated_logits = temperature(logits)
        probabilities = torch.sigmoid(calibrated_logits)
        threshold_info = select_threshold(
            labels.detach().cpu().view(-1).long().tolist(),
            probabilities.detach().cpu().view(-1).float().tolist(),
            method=args.threshold_method,
            target_real_fpr=float(args.threshold_target_real_fpr),
            target_fake_recall=float(args.threshold_target_fake_recall),
        )
        threshold_info["calibration_target"] = "fusion"
        metrics = MetricAccumulator()
        metrics.update(criterion(calibrated_logits, labels), labels, probabilities, datasets)
        summary = {
            "stage": "stage3_cached_fusion",
            "temperature": float(temperature.temperature.detach().cpu().item()),
            "validation": metrics.compute(threshold=float(threshold_info["threshold"])),
            "threshold_selection": threshold_info,
            "cache": cache_report,
            "time": timestamp(),
        }
    ckpt_dir = ensure_dir(Path(args.local_cache_dir) / "checkpoints")
    calibration_path = ckpt_dir / "stage3_calibration.pt"
    save_checkpoint(
        path=calibration_path,
        stage="stage3",
        expert="temperature",
        epoch=0,
        global_step=0,
        model=temperature,
        optimizer=None,
        scheduler=None,
        scaler=None,
        config=safe_config_dict(args),
        metrics=summary,
        best_metric=-float(summary["validation"].get("loss", 0.0)),
        include_clip_state=False,
    )
    threshold_path = ckpt_dir / "threshold.json"
    write_json(threshold_path, threshold_info)
    write_json(ckpt_dir / "metrics_calibration.json", summary)
    append_jsonl(ckpt_dir / "training_log.jsonl", summary)
    args.threshold_checkpoint = str(threshold_path)
    if args.upload_best_to_hf or args.upload_latest_to_hf:
        hf.upload_file(calibration_path, calibration_path.name)
        hf.upload_file(threshold_path, threshold_path.name)
        hf.upload_file(ckpt_dir / "metrics_calibration.json", "metrics_calibration.json")
    save_final_package(args, hf, ExpertBundle(fusion=model, temperature=temperature), summary, runtime)
    print(json.dumps(summary, indent=2, default=json_default), flush=True)


def evaluate_cached_fusion_mode(args: argparse.Namespace, hf: HFStore, runtime: RuntimeInfo) -> None:
    cache_report = validate_expert_cache(
        args.expert_cache_root,
        required_experts=EXPERT_ORDER,
        exact_expert_order=EXPERT_ORDER,
        verify_arrays=bool(args.verify_cache_arrays),
    )
    split = str(args.eval_split)
    if int(cache_report.get("counts", {}).get(split, 0)) < 1:
        raise RuntimeError(f"expert cache is missing required {split} records")
    if not args.calibration_checkpoint or not args.threshold_checkpoint:
        raise RuntimeError("Cached evaluation requires --calibration-checkpoint and --threshold-checkpoint")
    device = torch.device(runtime.device)
    model = build_cached_fusion_model(args, hf, device)
    temperature = TemperatureScaler().to(device)
    if not load_optional_checkpoint(
        temperature,
        args.calibration_checkpoint,
        hf,
        device,
        "cached fusion temperature scaler",
    ):
        raise RuntimeError("Could not load cached fusion calibration checkpoint")
    threshold_path = resolve_checkpoint_path(args.threshold_checkpoint, hf)
    if not threshold_path:
        raise RuntimeError("Could not load cached fusion threshold checkpoint")
    threshold_metadata = json.loads(Path(threshold_path).read_text(encoding="utf-8"))
    if threshold_metadata.get("calibration_target") not in (None, "fusion"):
        raise RuntimeError("Cached fusion threshold was selected for a different calibration target")
    threshold = float(threshold_metadata["threshold"])
    _, loader = make_cached_loader(args, split, train=False)
    metrics = evaluate_cached_fusion(model, loader, args, device, threshold, temperature)
    metrics.update({
        "split": split,
        "threshold_selection": threshold_metadata,
        "cache": cache_report,
    })
    ckpt_dir = ensure_dir(Path(args.local_cache_dir) / "checkpoints")
    metrics_path = ckpt_dir / f"metrics_{split}.json"
    write_json(metrics_path, metrics)
    append_jsonl(ckpt_dir / "training_log.jsonl", {"stage": "cached_evaluation", "metrics": metrics, "time": timestamp()})
    save_final_package(args, hf, ExpertBundle(fusion=model, temperature=temperature), metrics, runtime)
    if args.hf_repo_id:
        hf.upload_file(metrics_path, metrics_path.name)
        hf.upload_file(ckpt_dir / "training_log.jsonl", "training_log.jsonl")
    print(json.dumps(metrics, indent=2, default=json_default), flush=True)


def run_doctor(args: argparse.Namespace, hf: HFStore, manifest_path: Path, stats: Dict[str, Any], runtime: RuntimeInfo) -> None:
    scratch = Path("/mnt/local-scratch")
    disk: Dict[str, Any] = {"path": str(scratch), "exists": scratch.exists()}
    if scratch.exists():
        usage = shutil.disk_usage(scratch)
        disk.update(
            {
                "total_gb": round(usage.total / (1024**3), 2),
                "free_gb": round(usage.free / (1024**3), 2),
                "used_gb": round(usage.used / (1024**3), 2),
            }
        )

    hf_status: Dict[str, Any] = {
        "repo_id": args.hf_repo_id,
        "token_resolved": bool(args.hf_token),
        "hub_library_available": HF_AVAILABLE,
    }
    if args.hf_repo_id and HF_AVAILABLE:
        try:
            hf.ensure_repo()
            hf_status["repo_access_or_create"] = "ok"
        except Exception as exc:
            hf_status["repo_access_or_create"] = f"failed: {exc}"

    labels = stats.get("by_label", {})
    split_counts = stats.get("by_split", {})
    checks = {
        "cuda_available": runtime.device == "cuda",
        "gpu_name": runtime.gpu_name,
        "bf16_supported": runtime.supports_bf16,
        "opencv_available": CV2_AVAILABLE,
        "disk": disk,
        "hf": hf_status,
        "dataset_roots": {root: Path(root).exists() for root in (args.data_roots or [])},
        "manifest_path": str(manifest_path),
        "manifest_total_records": stats.get("total", 0),
        "has_real_labels": int(labels.get("0", 0)) > 0,
        "has_fake_labels": int(labels.get("1", 0)) > 0,
        "label_counts": labels,
        "split_counts": {split: int(split_counts.get(split, 0)) for split in ["train", "val", "test"]},
        "dataset_counts": stats.get("by_dataset", {}),
        "manifest_metadata": {
            "data_roots": stats.get("data_roots"),
            "hf_dataset_repos": stats.get("hf_dataset_repos"),
            "limit_records": stats.get("limit_records"),
            "created_at": stats.get("created_at"),
            "manifest_version": stats.get("manifest_version"),
        },
        "notes": [
            "Kaggle token is not needed unless you separately download datasets with the Kaggle API.",
            "For smoke tests, empty val/test splits can be expected when --limit-records is small.",
        ],
    }
    if not checks["has_real_labels"] or not checks["has_fake_labels"]:
        print("[doctor] WARNING: manifest does not contain both real and fake labels.", flush=True)
    if int(split_counts.get(args.eval_split, 0)) == 0:
        print(f"[doctor] WARNING: eval split {args.eval_split!r} has zero records.", flush=True)
    print("[doctor] " + json.dumps(checks, indent=2, default=json_default), flush=True)


class HardwareSampler:
    def __init__(self, interval_seconds: float = 0.5) -> None:
        self.interval_seconds = max(0.1, float(interval_seconds))
        self.stop_event = threading.Event()
        self.gpu_util: List[float] = []
        self.gpu_memory_mb: List[float] = []
        self.cpu_ram_percent: List[float] = []
        self.cpu_ram_used_gb: List[float] = []
        self.thread = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        try:
            import psutil  # type: ignore
        except Exception:
            psutil = None
        while not self.stop_event.is_set():
            try:
                query = subprocess.run(
                    [
                        "nvidia-smi",
                        "--query-gpu=utilization.gpu,memory.used",
                        "--format=csv,noheader,nounits",
                    ],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                    text=True,
                    timeout=2,
                )
                if query.returncode == 0 and query.stdout.strip():
                    util, memory = query.stdout.strip().splitlines()[0].split(",")[:2]
                    self.gpu_util.append(float(util.strip()))
                    self.gpu_memory_mb.append(float(memory.strip()))
            except Exception:
                pass
            if psutil is not None:
                with contextlib.suppress(Exception):
                    vm = psutil.virtual_memory()
                    self.cpu_ram_percent.append(float(vm.percent))
                    self.cpu_ram_used_gb.append(float(vm.used) / 1024 ** 3)
            self.stop_event.wait(self.interval_seconds)

    def start(self) -> None:
        self.thread.start()

    def close(self) -> Dict[str, Any]:
        self.stop_event.set()
        self.thread.join(timeout=5)

        def percentile(values: Sequence[float], fraction: float) -> Optional[float]:
            if not values:
                return None
            ordered = sorted(values)
            return float(ordered[min(len(ordered) - 1, int((len(ordered) - 1) * fraction))])

        return {
            "gpu_util_avg": statistics.fmean(self.gpu_util) if self.gpu_util else None,
            "gpu_util_p10": percentile(self.gpu_util, 0.10),
            "gpu_memory_used_mb_max": max(self.gpu_memory_mb) if self.gpu_memory_mb else None,
            "cpu_ram_percent_avg": statistics.fmean(self.cpu_ram_percent) if self.cpu_ram_percent else None,
            "cpu_ram_percent_max": max(self.cpu_ram_percent) if self.cpu_ram_percent else None,
            "cpu_ram_used_gb_max": max(self.cpu_ram_used_gb) if self.cpu_ram_used_gb else None,
        }


def benchmark_training(args: argparse.Namespace, hf: HFStore, manifest_path: Path, stats: Dict[str, Any], runtime: RuntimeInfo) -> Dict[str, Any]:
    if not args.expert:
        raise ValueError("--expert is required for benchmark mode")
    if runtime.device != "cuda" and not args.allow_cpu_train:
        raise RuntimeError("benchmark mode requires CUDA unless --allow-cpu-train is set")
    device = torch.device(runtime.device)
    model = build_stage1_expert(args, device)
    benchmark_checkpoint_sha256: Optional[str] = None
    if args.resume:
        path = resolve_checkpoint_path(args.resume, hf)
        if path:
            checkpoint = safe_torch_load(path, map_location=device)
            load_model_state(model, checkpoint, strict=False)
            benchmark_checkpoint_sha256 = checkpoint_fingerprint(path)
    trainable = [parameter for parameter in model.parameters() if parameter.requires_grad]
    optimizer = torch.optim.AdamW(trainable, lr=float(args.lr), weight_decay=float(args.weight_decay))
    scaler = make_grad_scaler(device, args.precision)
    criterion = nn.BCEWithLogitsLoss()
    required_views = required_views_for_stage1(args.expert)
    auto_tune_stage1_resources(model, criterion, manifest_path, required_views, args, hf, stats, device)
    benchmark_dataset, loader = make_loader(manifest_path, "train", required_views, args, hf, stats, train=True)
    iterator = iter(loader)
    warmup = int(args.benchmark_warmup_steps)
    measured_steps = int(args.benchmark_steps)
    total_steps = warmup + measured_steps
    step_times: List[float] = []
    wait_times: List[float] = []
    sample_count = 0
    sampler = HardwareSampler(float(args.hardware_sample_interval))
    sampler.start()
    oom = False
    error: Optional[str] = None
    started = time.perf_counter()
    try:
        model.train()
        for step in range(total_steps):
            wait_started = time.perf_counter()
            try:
                batch = next(iterator)
            except StopIteration as exc:
                raise RuntimeError(f"benchmark dataset exhausted after {step} steps") from exc
            wait_seconds = time.perf_counter() - wait_started
            labels = batch["labels"].to(device, non_blocking=True)
            frames = batch["views"][required_views[0]].to(device, non_blocking=True)
            step_started = time.perf_counter()
            optimizer.zero_grad(set_to_none=True)
            try:
                with autocast_context(device, args.precision):
                    output = model(frames)
                    loss = criterion(output.logit, labels)
                if scaler is not None and getattr(scaler, "is_enabled", lambda: False)():
                    scaler.scale(loss).backward()
                    scaler.step(optimizer)
                    scaler.update()
                else:
                    loss.backward()
                    optimizer.step()
                if device.type == "cuda":
                    torch.cuda.synchronize()
            except RuntimeError as exc:
                if is_cuda_oom(exc):
                    oom = True
                    error = str(exc)
                    break
                raise
            step_seconds = time.perf_counter() - step_started
            if step >= warmup:
                step_times.append(step_seconds)
                wait_times.append(wait_seconds)
                sample_count += int(labels.shape[0])
            del labels, frames, batch, output, loss
    except Exception as exc:
        error = f"{type(exc).__name__}: {exc}"
    hardware = sampler.close()
    elapsed = time.perf_counter() - started

    def p95(values: Sequence[float]) -> Optional[float]:
        if not values:
            return None
        ordered = sorted(values)
        return float(ordered[min(len(ordered) - 1, math.ceil(len(ordered) * 0.95) - 1)])

    result: Dict[str, Any] = {
        "timestamp": timestamp(),
        "expert": args.expert,
        "checkpoint_sha256": benchmark_checkpoint_sha256,
        "num_workers": int(args.num_workers),
        "prefetch_factor": int(args.prefetch_factor),
        "batch_size": int(args.batch_size),
        "grad_accum_steps": int(args.grad_accum_steps),
        "clip_frame_chunk_size": int(args.clip_frame_chunk_size),
        "effective_batch_size": int(args.batch_size),
        "warmup_steps": warmup,
        "benchmark_steps_requested": measured_steps,
        "benchmark_steps_completed": len(step_times),
        "samples": sample_count,
        "samples_per_second": sample_count / max(1e-9, sum(step_times) + sum(wait_times)),
        "avg_seconds_per_step": statistics.fmean(step_times) if step_times else None,
        "avg_total_seconds_per_step": (
            statistics.fmean([step + wait for step, wait in zip(step_times, wait_times)])
            if step_times else None
        ),
        "step_time_p95": p95(step_times),
        "total_step_time_p95": p95([step + wait for step, wait in zip(step_times, wait_times)]),
        "dataloader_wait_avg": statistics.fmean(wait_times) if wait_times else None,
        "dataloader_wait_p95": p95(wait_times),
        "oom": oom,
        "crashed": bool(error and not oom),
        "worker_crashes": int(bool(error and "worker" in error.lower() and "timeout" not in error.lower())) if error else 0,
        "worker_timeouts": int(bool(error and "timeout" in error.lower())) if error else 0,
        "error": error,
        "elapsed_seconds": elapsed,
        "corrupt_or_skipped_reads": int(benchmark_dataset.skipped_videos + benchmark_dataset.skipped_errors),
        "hardware": dataclasses.asdict(runtime),
        **hardware,
    }
    output_path = Path(args.benchmark_output)
    atomic_write_json(output_path, result)
    print("[benchmark] " + json.dumps(result, indent=2, default=json_default), flush=True)
    if error:
        raise RuntimeError(f"benchmark failed: {error}")
    return result


# ---------------------------------------------------------------------------
# Prediction and final artifacts
# ---------------------------------------------------------------------------


def resolve_predict_video_path(spec: str, hf: HFStore) -> str:
    if spec.startswith("hf:"):
        repo_id, path_in_repo = parse_hf_file_spec(spec, hf.repo_id)
        # Prediction HF paths are usually model artifacts or dataset files. Try
        # dataset first because the user is passing a video; fall back to model.
        try:
            return hf.download_dataset_file(repo_id, path_in_repo)
        except Exception:
            return hf.download_model_file(repo_id, path_in_repo)
    return spec


def build_predict_av_context(
    args: argparse.Namespace,
    video_path: str,
    device: torch.device,
) -> Optional[Dict[str, Tensor]]:
    prepared = getattr(args, "av_prepared_npz", None)
    if prepared:
        with np.load(prepared, allow_pickle=False) as payload:
            return {
                name: torch.from_numpy(np.asarray(payload[name], dtype=np.float32)).unsqueeze(0).to(device)
                for name in ("mouth_tracks", "waveform", "track_mask", "quality")
            }
    yunet = getattr(args, "av_yunet_model", None)
    if not yunet:
        return None
    project_root = Path(__file__).resolve().parents[2]
    if str(project_root) not in sys.path:
        sys.path.insert(0, str(project_root))
    from core.av_joint import AVPreprocessor, YuNetFaceTracker

    tracker = YuNetFaceTracker(yunet, mouth_size=112, max_faces=4)
    context = AVPreprocessor(tracker).process(
        video_path,
        seconds=int(getattr(args, "av_seconds", 8)),
        language=str(getattr(args, "av_language", "unknown")),
    )
    if not context.applicable:
        print(f"[av] not applicable: {','.join(context.gate_reasons)}", flush=True)
        return None
    return context.as_tensor_inputs(torch, device)


@torch.no_grad()
def predict(args: argparse.Namespace, hf: HFStore, runtime: RuntimeInfo) -> Dict[str, Any]:
    if not args.predict_video:
        raise ValueError("--predict-video is required for --mode predict")
    device = torch.device(runtime.device)
    bundle = build_fusion_bundle(args, hf, device, load_experts=True)
    freeze_bundle_experts(bundle)
    assert bundle.fusion is not None
    bundle.fusion.eval()
    if bundle.temperature is not None:
        bundle.temperature.eval()

    video_path = resolve_predict_video_path(args.predict_video, hf)
    av_context = build_predict_av_context(args, video_path, device)
    rng = random.Random(int(args.seed))
    stage0_names = ["micro", "mid", "long"]
    if bool(args.use_spatial or args.spatial_checkpoint or args.spatial_stub):
        stage0_names.append("spatial")
    stage0_views = decode_video_views(video_path, stage0_names, args, train=False, rng=rng)
    if stage0_views is None:
        raise RuntimeError(f"Could not decode prediction video: {args.predict_video}")
    views = {k: v.unsqueeze(0).to(device) for k, v in stage0_views.items()}
    with autocast_context(device, args.precision):
        outputs = run_experts(
            bundle,
            views,
            include_extra_long=False,
            include_spatial=bool(args.use_spatial or args.spatial_checkpoint or args.spatial_stub),
            include_lip=bool(args.use_lip or args.lip_checkpoint or args.lip_stub),
            av_context=av_context,
        )
        g0 = DisagreementComputer.compute(outputs)
        escalation_stage = 0
        include_extra = False
        routing_bias = None
        if float(g0.mean().detach().cpu()) > float(args.disagreement_t1) and bundle.extra_long is not None:
            extra_views = decode_video_views(video_path, ["extra_long"], args, train=False, rng=rng)
            if extra_views is not None:
                views["extra_long"] = extra_views["extra_long"].unsqueeze(0).to(device)
                include_extra = True
                escalation_stage = 1
                outputs = run_experts(
                    bundle,
                    views,
                    include_extra_long=True,
                    include_spatial=bool(args.use_spatial or args.spatial_checkpoint or args.spatial_stub),
                    include_lip=bool(args.use_lip or args.lip_checkpoint or args.lip_stub),
                    av_context=av_context,
                )
                g1 = DisagreementComputer.compute(outputs)
                if float(g1.mean().detach().cpu()) > float(args.disagreement_t2):
                    escalation_stage = 2
                    routing_bias = {
                        "long": args.stage2_long_bias,
                        "extra_long": args.stage2_extra_long_bias,
                        "lip_sync": args.stage2_lip_bias,
                        "micro": args.stage2_micro_bias,
                        "mid": args.stage2_mid_bias,
                    }
        disagreement = DisagreementComputer.compute(outputs)
        fusion_out = bundle.fusion(outputs, routing_bias=routing_bias)
        raw_logit = fusion_out["logit"]
        if bundle.temperature is not None:
            logit = bundle.temperature(raw_logit)
            prob = torch.sigmoid(logit)
        else:
            prob = fusion_out["probability"]

    p = float(prob.squeeze().detach().cpu())
    label = "fake" if p >= 0.5 else "real"
    confidence = p if label == "fake" else 1.0 - p
    expert_weights = {name: float(t.squeeze().detach().cpu()) for name, t in fusion_out["expert_weights"].items()}
    expert_confidences = {out.name: float(out.confidence.squeeze().detach().cpu()) for out in outputs}
    result = {
        "label": label,
        "confidence": float(confidence),
        "fake_probability": p,
        "disagreement_score": float(disagreement.mean().detach().cpu()),
        "escalation_stage": int(escalation_stage),
        "expert_weights": {name: expert_weights.get(name, 0.0) for name in EXPERT_ORDER},
        "expert_confidences": {name: expert_confidences.get(name, 0.0) for name in EXPERT_ORDER},
    }
    av_output = next((output for output in outputs if output.name == "lip_sync" and output.diagnostics), None)
    if av_output is not None:
        result["av_joint"] = {
            name: value.detach().cpu().tolist()
            for name, value in (av_output.diagnostics or {}).items()
        }
    print(json.dumps(result, indent=2, sort_keys=True), flush=True)
    return result


def final_state_dict(bundle: ExpertBundle) -> Dict[str, Tensor]:
    state: Dict[str, Tensor] = {}
    for name, module in [
        ("micro", bundle.micro),
        ("mid", bundle.mid),
        ("long", bundle.long),
        ("extra_long", bundle.extra_long),
        ("spatial", bundle.spatial),
        ("lip_sync", bundle.lip_sync),
        ("fusion", bundle.fusion),
        ("temperature", bundle.temperature),
    ]:
        if module is None:
            continue
        for k, v in state_dict_for_checkpoint(module, include_clip_state=False).items():
            state[f"{name}.{k}"] = v
    return state


def model_card_text(args: argparse.Namespace, metrics: Dict[str, Any], runtime: RuntimeInfo) -> str:
    return f"""---
library_name: pytorch
tags:
- deepfake-detection
- video-classification
- multimodal
- mixture-of-experts
- temporal
---

# Temporal Deepfake MoE

This repository stores checkpoints and artifacts produced by
`temporal_deepfake_moe_hf_colab.py`.

## System

- Micro expert: short-range frame-difference artifact detector.
- Mid expert: CLIP frame encoder + temporal Transformer.
- Long expert: sparse CLIP frame encoder + temporal Transformer.
- Extra-long expert: optional inference-escalation expert.
- Spatial detector: external detector wrapper or stub.
- Lip-sync model: external audio-video wrapper or stub.
- Fusion: Transformer over variable expert tokens with reliability weighting.

## Runtime

- Device: {runtime.device}
- GPU: {runtime.gpu_name}
- VRAM GB: {runtime.total_vram_gb:.1f}
- Precision: {args.precision}
- Embedding dim: {args.embedding_dim}

## Metrics

```json
{json.dumps(metrics, indent=2, default=json_default)}
```

## Notes

The final training pipeline streams training-ready NPZ members directly from
read-only tar shards with a bounded per-worker handle cache. For compact NPZ-v2,
source-group-owned train/validation/test splits come from the pinned manifest.
In strict local-data mode no dataset file is downloaded from Hugging Face. The
spatial and AV experts are enabled only when their checkpoints are supplied.
Dataset labels are trusted scraper assumptions, not independently verified
ground truth; reported metrics measure proxy-label agreement. The pipeline does
not depend on Google Drive.
"""


def save_final_package(args: argparse.Namespace, hf: HFStore, bundle: ExpertBundle, metrics: Dict[str, Any], runtime: RuntimeInfo) -> None:
    out_dir = ensure_dir(Path(args.local_cache_dir) / "final_model_package")
    state = final_state_dict(bundle)
    if SAFETENSORS_AVAILABLE:
        final_path = out_dir / "final_model.safetensors"
    else:
        final_path = out_dir / "final_model.pt"
    temporary = final_path.with_suffix(final_path.suffix + f".{os.getpid()}.tmp")
    try:
        if SAFETENSORS_AVAILABLE:
            safetensors_save_file(state, str(temporary))  # type: ignore[misc]
        else:
            torch.save(state, temporary)
        os.replace(temporary, final_path)
    finally:
        temporary.unlink(missing_ok=True)
    config = safe_config_dict(args)
    config["runtime"] = dataclasses.asdict(runtime)
    config["artifact_saved_at"] = timestamp()
    write_json(out_dir / "config.json", config)
    write_json(out_dir / "metrics.json", metrics)
    if getattr(args, "threshold_checkpoint", None):
        threshold_source = Path(str(args.threshold_checkpoint))
        if threshold_source.is_file():
            shutil.copy2(threshold_source, out_dir / "threshold.json")
    with open(out_dir / "README.md", "w", encoding="utf-8") as f:
        f.write(model_card_text(args, metrics, runtime))
    # Keep a small log file even if no training_log exists yet.
    append_jsonl(out_dir / "training_log.jsonl", {"time": timestamp(), "event": "final_package", "metrics": metrics})
    print(f"[final] saved final package to {out_dir}", flush=True)
    if args.hf_repo_id:
        hf.upload_folder(out_dir, ".")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def str2bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in {"1", "true", "t", "yes", "y", "on"}:
        return True
    if text in {"0", "false", "f", "no", "n", "off"}:
        return False
    raise argparse.ArgumentTypeError(f"expected a boolean value, got {value!r}")


def add_bool_arg(parser: argparse.ArgumentParser, name: str, default: bool, help_text: str) -> None:
    dest = name.lstrip("-").replace("-", "_")
    parser.add_argument(name, dest=dest, nargs="?", const=True, default=default, type=str2bool, help=help_text)
    parser.add_argument("--no-" + name.lstrip("-"), dest=dest, action="store_false", help=argparse.SUPPRESS)


def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Colab Pro Hugging Face temporal multimodal deepfake MoE trainer",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument(
        "--mode",
        required=True,
        choices=[
            "doctor", "scan", "benchmark", "train_stage1", "train_stage2",
            "cache_experts", "train_cached_fusion", "calibrate_cached_fusion",
            "eval_cached_fusion", "calibrate", "eval", "predict",
        ],
    )
    p.add_argument("--expert", default=None, choices=["micro", "mid", "long", "extra_long"], help="Stage 1 expert to train/evaluate")

    # Data
    p.add_argument(
        "--data-roots",
        nargs="*",
        default=[],
        help=(
            "Local Colab dataset roots, e.g. "
            "/mnt/local-scratch/deepfake_moe/data/dfdc "
            "/mnt/local-scratch/deepfake_moe/data/celebdf "
            "/mnt/local-scratch/deepfake_moe/data/faceforensics "
            "/mnt/local-scratch/deepfake_moe/data/deepfake_eval"
        ),
    )
    p.add_argument("--hf-dataset-repos", nargs="*", default=[], help="HF dataset repos to scan/stream")
    p.add_argument("--precomputed-manifest", default=None, help="JSONL manifest of precomputed frame-view .npz files")
    p.add_argument("--precomputed-root", default=None, help="Root directory for relative paths in --precomputed-manifest")
    p.add_argument("--validation-manifest", default=None, help="Fixed validation JSONL manifest, separate from training")
    p.add_argument("--validation-root", default=None, help="Root for fixed validation archives/NPZ paths")
    p.add_argument("--test-manifest", default=None, help="Fixed test JSONL manifest, separate from training")
    p.add_argument("--test-root", default=None, help="Root for fixed test archives/NPZ paths")
    p.add_argument("--tar-handle-cache-size", type=int, default=4, help="Maximum open tar handles per DataLoader worker")
    p.add_argument("--max-npz-member-bytes", type=int, default=2 * 1024 ** 3, help="Safety limit for one NPZ tar member")
    p.add_argument("--compact-v2-max-faces", type=int, default=4, help="Padded face count for compact NPZ-v2 AV windows")
    add_bool_arg(p, "--strict-local-data", False, "Never scan or download HF dataset files; model checkpoint I/O remains allowed")
    p.add_argument("--local-cache-dir", default=DEFAULT_LOCAL_CACHE, help="Scratch/cache directory, e.g. /mnt/local-scratch/deepfake_moe/cache")
    p.add_argument("--rebuild-manifest", action="store_true")
    p.add_argument("--limit-records", type=int, default=None, help="Debug metadata/data limit")
    p.add_argument("--shuffle-buffer-size", type=int, default=128, help="Metadata shuffle buffer; frames are not cached")
    add_bool_arg(p, "--interleave-classes", True, "Alternate real/fake training records before shuffle buffering")
    add_bool_arg(p, "--balance-datasets", False, "Downsample dominant datasets during training")
    add_bool_arg(p, "--class-balanced-loss", True, "Use BCE pos_weight from manifest label counts")

    # Hugging Face storage
    p.add_argument("--hf-token", nargs="?", default=None, const=None, help="Optional HF token; also resolved from HF_TOKEN/HUGGING_FACE_HUB_TOKEN/HF_HUB_TOKEN")
    p.add_argument("--hf-repo-id", default=None)
    add_bool_arg(p, "--hf-private", False, "Create/use a private HF model repo")
    p.add_argument("--hf-checkpoint-dir", default=".", help="Remote subdirectory for checkpoints/artifacts")
    add_bool_arg(p, "--hf-upload-every-epoch", True, "Upload latest checkpoint after every epoch")
    add_bool_arg(p, "--hf-auto-resume", False, "Resume latest checkpoint from HF Hub when local checkpoint is absent")
    add_bool_arg(p, "--strict-hf-upload", False, "Crash training if HF upload retries are exhausted")

    # Runtime/training
    p.add_argument("--seed", type=int, default=1337)
    p.add_argument("--batch-size", type=int, default=1)
    p.add_argument("--grad-accum-steps", type=int, default=4)
    p.add_argument("--precision", default="auto", choices=["auto", "fp32", "fp16", "bf16"])
    p.add_argument("--embedding-dim", type=int, default=256)
    add_bool_arg(p, "--allow-large-embedding", False, "Allow embedding_dim=512 defaults on large GPUs")
    add_bool_arg(p, "--allow-cpu-train", False, "Allow tiny CPU training/debug runs")
    p.add_argument("--num-workers", type=int, default=0, help="0 is safest on Colab")
    p.add_argument("--prefetch-factor", type=int, default=2, help="Batches prefetched per DataLoader worker")
    add_bool_arg(p, "--auto-tune-batch-size", False, "Probe real forward/backward batches and ramp to the measured VRAM boundary")
    p.add_argument("--max-auto-batch-size", type=int, default=128)
    p.add_argument("--target-vram-fraction", type=float, default=0.94)
    p.add_argument("--vram-reserve-gib", type=float, default=4.0)
    p.add_argument("--target-ram-fraction", type=float, default=0.92)
    p.add_argument("--ram-reserve-gib", type=float, default=12.0)
    p.add_argument("--dataloader-timeout", type=float, default=0.0, help="Worker batch timeout; 0 disables")
    p.add_argument("--max-steps-per-epoch", type=int, default=None)
    p.add_argument("--max-eval-records", type=int, default=None)
    p.add_argument("--empty-cache-every-steps", type=int, default=25)
    p.add_argument("--log-every-steps", type=int, default=100, help="Print training progress every N batches; 0 disables")
    p.add_argument("--disable-tqdm", action="store_true", help="Disable live tqdm progress bars and keep plain logs only")
    p.add_argument("--max-grad-norm", type=float, default=1.0)
    p.add_argument("--benchmark-warmup-steps", type=int, default=20)
    p.add_argument("--benchmark-steps", type=int, default=100)
    p.add_argument("--benchmark-output", default="benchmark_result.json")
    p.add_argument("--hardware-sample-interval", type=float, default=0.5)

    # Frames/video
    p.add_argument("--image-size", type=int, default=DEFAULT_IMAGE_SIZE)
    p.add_argument("--micro-frames", type=int, default=32)
    p.add_argument("--mid-frames", type=int, default=16)
    p.add_argument("--long-frames", type=int, default=8)
    p.add_argument("--extra-long-frames", type=int, default=16)
    p.add_argument("--spatial-frames", type=int, default=12)

    # CLIP
    p.add_argument("--clip-model-name", default="openai/clip-vit-base-patch32")
    p.add_argument("--clip-backend", default="hf", choices=["hf", "openai", "auto"])
    add_bool_arg(p, "--freeze-clip", True, "Freeze CLIP image encoder")
    add_bool_arg(p, "--unfreeze-last-clip-block", False, "Unfreeze last CLIP block")
    p.add_argument("--clip-frame-chunk-size", default="auto", help="Small chunks avoid OOM; use auto or int")
    add_bool_arg(p, "--save-clip-state", False, "Include CLIP backbone weights in checkpoints")
    add_bool_arg(p, "--allow-random-clip-fallback", False, "Debug-only fallback when CLIP packages are unavailable")

    # Model dimensions
    p.add_argument("--expert-dropout", type=float, default=0.1)
    p.add_argument("--temporal-layers", type=int, default=2)
    p.add_argument("--extra-long-layers", type=int, default=2)
    p.add_argument("--temporal-heads", type=int, default=4)
    p.add_argument("--fusion-dim", type=int, default=256)
    p.add_argument("--fusion-layers", type=int, default=4)
    p.add_argument("--fusion-heads", type=int, default=4)
    p.add_argument("--fusion-dropout", type=float, default=0.1)

    # Stage 1
    p.add_argument("--epochs", type=int, default=3)
    p.add_argument("--epochs-this-run", type=int, default=None, help="Maximum additional expert epochs in this invocation")
    p.add_argument("--lr", type=float, default=1e-4)
    p.add_argument("--weight-decay", type=float, default=1e-4)

    # Stage 2
    p.add_argument("--fusion-epochs", type=int, default=10)
    p.add_argument("--fusion-epochs-this-run", type=int, default=None, help="Maximum additional fusion epochs in this invocation")
    p.add_argument("--fusion-lr", type=float, default=1e-4)
    p.add_argument("--fusion-weight-decay", type=float, default=1e-4)
    p.add_argument("--expert-cache-root", default=None, help="Resumable cached expert-output directory")
    p.add_argument("--cache-splits", nargs="+", default=["train", "val", "test"], choices=["train", "val", "test"])
    p.add_argument("--cache-shard-records", type=int, default=1024)
    add_bool_arg(p, "--compress-expert-cache", True, "Compress cache NPZ shards; disable on large-RAM local scratch for speed")
    add_bool_arg(p, "--cache-in-memory", False, "Preload expert cache arrays once for fast fusion epochs")
    p.add_argument("--cached-fusion-batch-size", type=int, default=512)
    p.add_argument("--max-auto-cached-batch-size", type=int, default=32768)
    add_bool_arg(p, "--rebuild-expert-cache", False, "Discard cache shards and regenerate from corrected experts")
    add_bool_arg(p, "--verify-cache-arrays", True, "Decode and shape-check every cache shard before fusion")
    add_bool_arg(p, "--upload-expert-cache-metadata", True, "Upload cache manifest/meta/validation, not large cache shards")
    p.add_argument("--fusion-early-stopping-patience", type=int, default=0, help="Validation checks without min-delta improvement; 0 disables")
    p.add_argument("--fusion-early-stopping-min-delta", type=float, default=0.0)
    add_bool_arg(p, "--freeze-experts", True, "Freeze experts during fusion training")
    add_bool_arg(p, "--cache-expert-outputs", False, "Optional small debug cache; full caching is intentionally not implemented")
    add_bool_arg(p, "--use-extra-long-in-fusion-training", False, "Run extra-long expert during fusion training")
    add_bool_arg(p, "--allow-untrained-experts", False, "Debug-only: allow fusion/eval/predict with missing expert checkpoints")
    add_bool_arg(p, "--fusion-use-disagreement-features", True, "Add per-expert disagreement summary features to fusion tokens")
    p.add_argument("--fusion-expert-dropout", type=float, default=0.10, help="Stage 2 token dropout probability")
    add_bool_arg(p, "--fusion-use-dataset-embedding", False, "Add learned dataset-domain embedding to fusion CLS token")

    # External experts
    add_bool_arg(p, "--use-spatial", False, "Enable spatial detector expert")
    p.add_argument("--spatial-checkpoint", default=None)
    add_bool_arg(p, "--spatial-stub", False, "Force spatial stub")
    add_bool_arg(p, "--use-lip", False, "Enable lip-sync expert")
    p.add_argument("--lip-checkpoint", default=None)
    add_bool_arg(p, "--lip-stub", False, "Force lip-sync stub")
    p.add_argument("--av-prepared-npz", default=None, help="Prepared joint AV tensors for predict mode")
    p.add_argument("--av-yunet-model", default=None, help="YuNet ONNX path for joint AV predict preprocessing")
    p.add_argument("--av-language", default="unknown")
    p.add_argument("--av-seconds", type=int, default=8, choices=[2, 4, 8])
    add_bool_arg(
        p,
        "--require-av-context",
        False,
        "Require av_prepared_path tensors for every sample when training joint AV fusion",
    )

    # Checkpoints
    p.add_argument("--resume", default=None, help="Explicit local path or hf:USER/REPO/path checkpoint")
    p.add_argument(
        "--resume-policy",
        default="full",
        choices=["full", "model-only", "fresh"],
        help="full=crash resume; model-only=phase transition with reset optimizer/epoch; fresh=ignore resumes",
    )
    add_bool_arg(p, "--auto-resume", False, "Resume local latest checkpoint")
    add_bool_arg(p, "--save-every-epoch", True, "Save numbered epoch checkpoints locally")
    add_bool_arg(p, "--save-best", True, "Save best checkpoint locally")
    add_bool_arg(p, "--upload-best-to-hf", True, "Upload best checkpoint immediately")
    add_bool_arg(p, "--upload-latest-to-hf", True, "Upload latest checkpoint after every epoch")
    add_bool_arg(p, "--upload-numbered-epoch-checkpoints", False, "Upload numbered epoch checkpoints in addition to latest/best")
    p.add_argument("--micro-checkpoint", default=None)
    p.add_argument("--mid-checkpoint", default=None)
    p.add_argument("--long-checkpoint", default=None)
    p.add_argument("--extra-long-checkpoint", default=None)
    p.add_argument("--fusion-checkpoint", default=None)
    p.add_argument("--calibration-checkpoint", default=None)

    # Calibration/eval/predict
    p.add_argument("--eval-split", default="val", choices=["train", "val", "test"])
    p.add_argument("--calibration-lr", type=float, default=0.05)
    p.add_argument(
        "--calibration-target",
        default="fusion",
        choices=["fusion", "micro", "mid", "long", "extra_long"],
        help="Model whose probabilities are calibrated on validation data",
    )
    p.add_argument("--threshold-checkpoint", default=None, help="Local path or hf: JSON selected on validation only")
    p.add_argument("--threshold-method", default="max_f1", choices=["max_f1", "target_real_fpr", "target_fake_recall"])
    p.add_argument("--threshold-target-real-fpr", type=float, default=0.01)
    p.add_argument("--threshold-target-fake-recall", type=float, default=0.95)
    p.add_argument("--max-wall-time-seconds", type=float, default=0.0, help="Stop at an epoch-safe boundary; 0 disables")
    p.add_argument("--wall-time-reserve-seconds", type=float, default=900.0, help="Reserve time for validation/checkpoint/upload")
    add_bool_arg(p, "--eval-include-extra-long", False, "Include extra-long expert during evaluation")
    p.add_argument("--predict-video", default=None)
    add_bool_arg(p, "--predict-use-extra-long", True, "Build extra-long expert for prediction escalation")
    p.add_argument("--disagreement-t1", type=float, default=1.25)
    p.add_argument("--disagreement-t2", type=float, default=1.75)
    p.add_argument("--stage2-long-bias", type=float, default=1.4)
    p.add_argument("--stage2-extra-long-bias", type=float, default=1.6)
    p.add_argument("--stage2-lip-bias", type=float, default=1.25)
    p.add_argument("--stage2-micro-bias", type=float, default=0.75)
    p.add_argument("--stage2-mid-bias", type=float, default=0.85)
    return p


def validate_args(args: argparse.Namespace, runtime: RuntimeInfo) -> None:
    if int(args.tar_handle_cache_size) < 1:
        raise ValueError("--tar-handle-cache-size must be >= 1")
    if int(args.max_npz_member_bytes) < 1:
        raise ValueError("--max-npz-member-bytes must be >= 1")
    if int(args.compact_v2_max_faces) < 1:
        raise ValueError("--compact-v2-max-faces must be >= 1")
    if int(args.prefetch_factor) < 1:
        raise ValueError("--prefetch-factor must be >= 1")
    if int(args.max_auto_batch_size) < 1:
        raise ValueError("--max-auto-batch-size must be >= 1")
    if int(args.max_auto_cached_batch_size) < 1:
        raise ValueError("--max-auto-cached-batch-size must be >= 1")
    if not 0.5 <= float(args.target_vram_fraction) < 1.0:
        raise ValueError("--target-vram-fraction must be in [0.5, 1.0)")
    if not 0.5 <= float(args.target_ram_fraction) < 1.0:
        raise ValueError("--target-ram-fraction must be in [0.5, 1.0)")
    if float(args.vram_reserve_gib) < 0 or float(args.ram_reserve_gib) < 0:
        raise ValueError("RAM/VRAM reserves must be non-negative")
    if float(args.dataloader_timeout) < 0:
        raise ValueError("--dataloader-timeout must be >= 0")
    if int(args.benchmark_warmup_steps) < 0 or int(args.benchmark_steps) < 1:
        raise ValueError("benchmark warmup/steps are invalid")
    if args.epochs_this_run is not None and int(args.epochs_this_run) < 1:
        raise ValueError("--epochs-this-run must be >= 1")
    if args.fusion_epochs_this_run is not None and int(args.fusion_epochs_this_run) < 1:
        raise ValueError("--fusion-epochs-this-run must be >= 1")
    if int(args.fusion_early_stopping_patience) < 0:
        raise ValueError("--fusion-early-stopping-patience must be >= 0")
    if float(args.fusion_early_stopping_min_delta) < 0:
        raise ValueError("--fusion-early-stopping-min-delta must be >= 0")
    if args.strict_local_data and args.hf_dataset_repos:
        raise ValueError("--strict-local-data cannot be combined with --hf-dataset-repos")
    for field in ("precomputed_manifest", "validation_manifest", "test_manifest"):
        value = getattr(args, field, None)
        if value and not Path(value).is_file():
            raise FileNotFoundError(f"--{field.replace('_', '-')} not found: {value}")
    if args.cache_expert_outputs and (args.limit_records is None or args.limit_records > 256):
        raise ValueError("--cache-expert-outputs is only allowed when --limit-records <= 256")
    if args.mode in {"train_stage1", "benchmark"} and not args.expert:
        raise ValueError(f"--expert is required for {args.mode}")
    if args.mode in {"cache_experts", "train_cached_fusion", "calibrate_cached_fusion", "eval_cached_fusion"} and not args.expert_cache_root:
        raise ValueError(f"--expert-cache-root is required for {args.mode}")
    if int(args.cache_shard_records) < 1:
        raise ValueError("--cache-shard-records must be >= 1")
    if int(args.cached_fusion_batch_size) < 1:
        raise ValueError("--cached-fusion-batch-size must be >= 1")
    if args.mode == "predict" and not args.predict_video:
        raise ValueError("--predict-video is required for predict mode")
    if (
        args.mode in {"benchmark", "train_stage1", "train_stage2", "cache_experts", "train_cached_fusion", "calibrate"}
        and not args.data_roots
        and not args.hf_dataset_repos
        and not args.precomputed_manifest
    ):
        print("[warn] no datasets provided; manifest may be empty", flush=True)
    if args.hf_repo_id and not HF_AVAILABLE:
        raise RuntimeError("huggingface_hub is required when --hf-repo-id is provided")
    if args.hf_repo_id and not args.hf_token:
        msg = (
            "--hf-repo-id was provided but no Hugging Face token was resolved. "
            "Set os.environ['HF_TOKEN'] in Colab or export HF_TOKEN before running. "
            "Public read-only eval/predict may work without a token; checkpoint upload/private repos will not."
        )
        if args.mode in {"train_stage1", "train_stage2", "cache_experts", "train_cached_fusion", "calibrate_cached_fusion", "calibrate"} or args.hf_private:
            raise RuntimeError(msg)
        print(f"[hf] WARNING: {msg}", flush=True)
    if runtime.device == "cpu" and args.mode in {"benchmark", "train_stage1", "train_stage2", "train_cached_fusion"} and not args.allow_cpu_train:
        print("[runtime] CPU detected. Training will raise unless --allow-cpu-train is passed.", flush=True)
    if int(args.embedding_dim) not in {256, 512}:
        print("[warn] embedding_dim is expected to be 256 or 512 for checkpoint compatibility", flush=True)


def print_runtime_summary(args: argparse.Namespace, runtime: RuntimeInfo) -> None:
    scratch_exists = Path("/mnt/local-scratch").exists()
    summary = {
        "gpu_name": runtime.gpu_name,
        "vram_gb": round(runtime.total_vram_gb, 2),
        "cuda_available": runtime.device == "cuda",
        "bf16_supported": runtime.supports_bf16,
        "precision": args.precision,
        "batch_size": args.batch_size,
        "grad_accum_steps": args.grad_accum_steps,
        "clip_frame_chunk_size": args.clip_frame_chunk_size,
        "embedding_dim": args.embedding_dim,
        "num_workers": args.num_workers,
        "freeze_clip": args.freeze_clip,
        "local_cache_dir": args.local_cache_dir,
        "suggested_data_root": "/mnt/local-scratch/deepfake_moe/data" if scratch_exists else None,
    }
    print("[runtime] " + json.dumps(summary, indent=2, default=json_default), flush=True)
    if _gpu_name_has(runtime, "A100") and runtime.total_vram_gb >= 70:
        print(
            "[runtime] A100 80GB recommendation: precision=bf16, batch_size=1 initially, "
            "grad_accum_steps=2 or 4, clip_frame_chunk_size=8 initially, embedding_dim=256 initially, "
            "num_workers=0 for smoke tests and 2 later.",
            flush=True,
        )


def main(argv: Optional[Sequence[str]] = None) -> None:
    parser = build_arg_parser()
    args = parser.parse_args(argv)
    args.hf_token = resolve_hf_token(args.hf_token)
    runtime = detect_runtime()
    args = apply_device_safe_defaults(args, runtime)
    validate_args(args, runtime)
    configure_torch_for_throughput()
    args._wall_budget = WallTimeBudget(
        max_seconds=float(args.max_wall_time_seconds),
        reserve_seconds=float(args.wall_time_reserve_seconds),
    )
    set_seed(int(args.seed))
    ensure_dir(args.local_cache_dir)
    configure_cache_environment(args.local_cache_dir)
    print_runtime_summary(args, runtime)

    hf = HFStore(
        repo_id=args.hf_repo_id,
        token=args.hf_token,
        private=bool(args.hf_private),
        checkpoint_dir=args.hf_checkpoint_dir,
        local_cache_dir=args.local_cache_dir,
        strict_upload=bool(args.strict_hf_upload),
    )
    hf.strict_local_data = bool(args.strict_local_data)
    reuse_saved_auto_max_tuning(args)
    if args.hf_repo_id and args.mode in {"train_stage1", "train_stage2", "cache_experts", "train_cached_fusion", "calibrate_cached_fusion", "calibrate"}:
        hf.ensure_repo()

    if args.mode == "predict":
        predict(args, hf, runtime)
        return

    if args.mode == "train_cached_fusion":
        train_cached_fusion(args, hf, runtime)
        return
    if args.mode == "calibrate_cached_fusion":
        calibrate_cached_fusion(args, hf, runtime)
        return
    if args.mode == "eval_cached_fusion":
        evaluate_cached_fusion_mode(args, hf, runtime)
        return

    manifest_path, stats = build_manifest(args, hf)
    print("[manifest] " + json.dumps(stats, indent=2, default=json_default), flush=True)
    if args.mode == "doctor":
        run_doctor(args, hf, manifest_path, stats, runtime)
        return
    if stats.get("total", 0) == 0 and args.mode != "scan":
        raise RuntimeError("Manifest is empty. Check --data-roots, --hf-dataset-repos, and label inference.")
    if args.mode == "scan":
        return
    if args.mode == "benchmark":
        benchmark_training(args, hf, manifest_path, stats, runtime)
    elif args.mode == "train_stage1":
        train_stage1(args, hf, manifest_path, stats, runtime)
    elif args.mode == "train_stage2":
        train_stage2_fusion(args, hf, manifest_path, stats, runtime)
    elif args.mode == "cache_experts":
        cache_expert_outputs(args, hf, manifest_path, stats, runtime)
    elif args.mode == "calibrate":
        calibrate(args, hf, manifest_path, stats, runtime)
    elif args.mode == "eval":
        evaluate_mode(args, hf, manifest_path, stats, runtime)
    else:
        raise ValueError(f"Unsupported mode: {args.mode}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n[exit] interrupted by user", file=sys.stderr)
        raise
    except Exception as exc:
        print(f"[error] {exc}", file=sys.stderr)
        traceback.print_exc()
        raise
