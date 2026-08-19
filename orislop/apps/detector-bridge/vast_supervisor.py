#!/usr/bin/env python3
"""Single-container process supervisor for Orislop on Vast.ai.

Vast instances are already Docker containers, so the cloud Compose topology
cannot be nested inside them.  This process starts Ollama, the detector bridge,
and (optionally) cloudflared as sibling processes in one GPU container.  It
also performs strict configuration and hardware checks before billing time is
spent downloading models.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import time
from typing import Any, Mapping, Sequence
import urllib.error
import urllib.request


APP_ROOT = Path(os.environ.get("ORISLOP_APP_ROOT", "/app"))
MODEL_ROOT = Path(os.environ.get("ORISLOP_MODEL_ROOT", "/models"))
STATUS_ROOT = Path(os.environ.get("ORISLOP_STATUS_ROOT", "/run/orislop-vast"))
SERVER_SCRIPT = APP_ROOT / "apps" / "detector-bridge" / "server.py"
OLLAMA_URL = "http://127.0.0.1:11434"
MODEL_NAME_RE = re.compile(r"^[A-Za-z0-9._:/-]+$")
RUNTIME_ENV_KEYS = {
    "HOME",
    "HOSTNAME",
    "LANG",
    "LC_ALL",
    "LD_LIBRARY_PATH",
    "PATH",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
    "TMPDIR",
    "CUDA_DEVICE_ORDER",
    "CUDA_VISIBLE_DEVICES",
    "CUDA_MODULE_LOADING",
    "NVIDIA_DRIVER_CAPABILITIES",
    "NVIDIA_VISIBLE_DEVICES",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
}
DETECTOR_ENV_KEYS = {
    "DATABASE_URL",
    "HF_HOME",
    "HF_HUB_CACHE",
    "HF_TOKEN",
    "TRANSFORMERS_CACHE",
    "TORCH_HOME",
    "BRAVE_SEARCH_API_KEY",
    "GOOGLE_FACT_CHECK_API_KEY",
    "PYTORCH_CUDA_ALLOC_CONF",
    "TOKENIZERS_PARALLELISM",
    "OMP_NUM_THREADS",
    "MKL_NUM_THREADS",
    "HF_XET_HIGH_PERFORMANCE",
}

REQUIRED_CLOUD_SETTINGS = (
    "ORISLOP_API_TOKENS",
    "ORISLOP_ALLOWED_EXTENSION_ORIGINS",
    "ORISLOP_GOOGLE_OAUTH_CLIENT_ID",
    "ORISLOP_TOKEN_SECRET",
    "ORISLOP_CONTENT_HMAC_SECRET",
    "DATABASE_URL",
    "ORISLOP_DIAGNOSTIC_BUCKET",
    "ORISLOP_S3_ENDPOINT",
    "ORISLOP_S3_ACCESS_KEY_ID",
    "ORISLOP_S3_SECRET_ACCESS_KEY",
)

LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
DIRECT_TESTING_ACK = "I_UNDERSTAND_PORT_4317_MUST_NOT_BE_PUBLIC"

FULL_STACK_PATHS = {
    "ORISLOP_AV_JOINT_MODEL_PATH": "joint AV TorchScript model",
    "ORISLOP_AV_JOINT_METADATA_PATH": "joint AV metadata",
    "ORISLOP_YUNET_MODEL_PATH": "YuNet face detector",
    "ORISLOP_TEMPORAL_AV_FUSION_PATH": "AV phase-two fusion",
    "ORISLOP_TEMPORAL_AV_CALIBRATION_PATH": "AV phase-two calibration",
}
FULL_STACK_HF_FILES = {
    "ORISLOP_AV_JOINT_MODEL_PATH": "ORISLOP_AV_JOINT_HF_MODEL_FILE",
    "ORISLOP_AV_JOINT_METADATA_PATH": "ORISLOP_AV_JOINT_HF_METADATA_FILE",
    "ORISLOP_YUNET_MODEL_PATH": "ORISLOP_AV_JOINT_HF_YUNET_FILE",
    "ORISLOP_TEMPORAL_AV_FUSION_PATH": "ORISLOP_AV_JOINT_HF_PHASE2_FUSION_FILE",
    "ORISLOP_TEMPORAL_AV_CALIBRATION_PATH": "ORISLOP_AV_JOINT_HF_PHASE2_CALIBRATION_FILE",
}


class PreflightError(RuntimeError):
    """Raised when launching would be unsafe or predictably fail."""


def log(message: str, **fields: Any) -> None:
    suffix = " " + json.dumps(fields, sort_keys=True, default=str) if fields else ""
    print(f"[orislop-vast] {message}{suffix}", flush=True)


def enabled(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise PreflightError(f"Invalid boolean value: {value!r}")


def first_api_token(env: Mapping[str, str]) -> str:
    raw = env.get("ORISLOP_API_TOKENS", "")
    return next((part.strip() for part in raw.split(",") if part.strip()), "")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def immutable_hf_revision(value: str) -> bool:
    return re.fullmatch(r"[0-9a-fA-F]{40}", value.strip()) is not None


def validate_local_full_stack(env: Mapping[str, str]) -> list[str]:
    errors: list[str] = []
    paths = {name: Path(env.get(name, "")).expanduser() for name in FULL_STACK_PATHS}
    for name, label in FULL_STACK_PATHS.items():
        if not paths[name].is_file():
            errors.append(f"{label} file does not exist: {paths[name]}")
    if errors:
        return errors
    try:
        metadata = json.loads(paths["ORISLOP_AV_JOINT_METADATA_PATH"].read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return [f"Joint AV metadata is invalid: {error}"]
    hash_contract = {
        "ORISLOP_AV_JOINT_MODEL_PATH": str(metadata.get("sha256") or ""),
        "ORISLOP_TEMPORAL_AV_FUSION_PATH": str(metadata.get("phase2FusionSha256") or ""),
        "ORISLOP_TEMPORAL_AV_CALIBRATION_PATH": str(metadata.get("phase2CalibrationSha256") or ""),
        "ORISLOP_YUNET_MODEL_PATH": str(
            metadata.get("yunetSha256") or env.get("ORISLOP_YUNET_MODEL_SHA256", "")
        ),
    }
    for path_name, expected in hash_contract.items():
        label = FULL_STACK_PATHS[path_name]
        if re.fullmatch(r"[0-9a-fA-F]{64}", expected) is None:
            errors.append(f"{label} is missing a valid pinned SHA-256")
            continue
        actual = sha256_file(paths[path_name])
        if actual.lower() != expected.lower():
            errors.append(f"{label} SHA-256 mismatch: expected {expected.lower()}, got {actual}")
    return errors


def materialize_full_stack_artifacts(env: Mapping[str, str]) -> dict[str, str]:
    resolved = dict(env)
    if not enabled(resolved.get("ORISLOP_REQUIRE_FULL_MODEL_STACK"), default=True):
        return resolved
    if all(Path(resolved.get(name, "")).expanduser().is_file() for name in FULL_STACK_PATHS):
        return resolved
    repo_id = resolved.get("ORISLOP_AV_JOINT_HF_REPO_ID", "").strip()
    revision = resolved.get("ORISLOP_AV_JOINT_HF_REVISION", "").strip()
    if not repo_id or not immutable_hf_revision(revision):
        raise PreflightError(
            "Full-stack AV files are absent and the fallback HF repository/revision is not fully pinned"
        )
    try:
        from huggingface_hub import hf_hub_download
    except ImportError as error:
        raise PreflightError("huggingface-hub is required to download full-stack AV artifacts") from error
    cache_dir = MODEL_ROOT / "huggingface" / "hub"
    cache_dir.mkdir(parents=True, exist_ok=True)
    for path_name, file_name_var in FULL_STACK_HF_FILES.items():
        filename = resolved.get(file_name_var, "").strip()
        if not filename:
            raise PreflightError(f"{file_name_var} is required for the full-stack HF artifact package")
        log("downloading pinned full-stack artifact", repo=repo_id, revision=revision, filename=filename)
        try:
            resolved[path_name] = hf_hub_download(
                repo_id=repo_id,
                filename=filename,
                revision=revision,
                token=resolved.get("HF_TOKEN") or None,
                cache_dir=str(cache_dir),
            )
        except Exception as error:
            raise PreflightError(
                f"Could not download pinned full-stack artifact {repo_id}@{revision}:{filename}: {error}"
            ) from error
    return resolved


def validate_configuration(
    env: Mapping[str, str],
    *,
    check_model_path: bool = True,
) -> list[str]:
    errors: list[str] = []
    require_tunnel = enabled(env.get("ORISLOP_REQUIRE_CLOUDFLARE"), default=True)
    if require_tunnel:
        for name in REQUIRED_CLOUD_SETTINGS:
            value = env.get(name, "").strip()
            if not value or "replace_" in value.lower() or "changeme" in value.lower():
                errors.append(f"{name} is required and may not be a placeholder")

    origins = [
        item.strip()
        for item in env.get("ORISLOP_ALLOWED_EXTENSION_ORIGINS", "").split(",")
        if item.strip()
    ]
    if not origins or any(not item.startswith("chrome-extension://") for item in origins):
        errors.append("ORISLOP_ALLOWED_EXTENSION_ORIGINS must contain exact chrome-extension:// origins")

    token = first_api_token(env)
    if token and len(token) < 32:
        errors.append("Every ORISLOP_API_TOKENS token must be at least 32 characters")
    for candidate in (part.strip() for part in env.get("ORISLOP_API_TOKENS", "").split(",")):
        if candidate and len(candidate) < 32:
            errors.append("Every ORISLOP_API_TOKENS token must be at least 32 characters")
            break

    token_secret = env.get("ORISLOP_TOKEN_SECRET", "")
    hmac_secret = env.get("ORISLOP_CONTENT_HMAC_SECRET", "")
    if token_secret and len(token_secret) < 32:
        errors.append("ORISLOP_TOKEN_SECRET must be at least 32 characters")
    if hmac_secret and len(hmac_secret) < 32:
        errors.append("ORISLOP_CONTENT_HMAC_SECRET must be at least 32 characters")
    if token_secret and hmac_secret and token_secret == hmac_secret:
        errors.append("Token and content-HMAC secrets must be different")

    if require_tunnel and not env.get("CLOUDFLARE_TUNNEL_TOKEN", "").strip():
        errors.append("CLOUDFLARE_TUNNEL_TOKEN is required unless direct testing is explicitly enabled")
    if not require_tunnel:
        acknowledgement = env.get("ORISLOP_VAST_DIRECT_TESTING_ACK", "")
        if acknowledgement != DIRECT_TESTING_ACK:
            errors.append(
                "Direct testing requires ORISLOP_VAST_DIRECT_TESTING_ACK="
                + DIRECT_TESTING_ACK
            )
        detector_host = env.get("ORISLOP_DETECTOR_HOST", "127.0.0.1").strip().lower()
        if detector_host not in LOOPBACK_HOSTS:
            errors.append("Direct testing must bind ORISLOP_DETECTOR_HOST to loopback only")

    ollama_model = env.get("ORISLOP_OLLAMA_MODEL", "qwen2.5:1.5b-instruct")
    if not MODEL_NAME_RE.fullmatch(ollama_model):
        errors.append("ORISLOP_OLLAMA_MODEL contains invalid characters")
    ollama_device = env.get("ORISLOP_OLLAMA_DEVICE", "auto").strip().lower()
    if ollama_device not in {"auto", "cpu", "gpu"}:
        errors.append("ORISLOP_OLLAMA_DEVICE must be auto, cpu, or gpu")

    if enabled(env.get("ORISLOP_TEMPORAL_ENABLED"), default=True):
        package_path = env.get("ORISLOP_TEMPORAL_PACKAGE_PATH", "").strip()
        repo_id = env.get("ORISLOP_TEMPORAL_HF_REPO_ID", "").strip()
        if bool(package_path) == bool(repo_id):
            errors.append("Set exactly one temporal source: local package path or private HF repository")
        elif package_path and check_model_path and not Path(package_path).is_dir():
            errors.append(f"Temporal package directory does not exist: {package_path}")
        elif repo_id:
            if not env.get("ORISLOP_TEMPORAL_HF_REVISION", "").strip():
                errors.append("ORISLOP_TEMPORAL_HF_REVISION must pin an immutable commit")
            if not env.get("ORISLOP_TEMPORAL_MODEL_SHA256", "").strip():
                errors.append("ORISLOP_TEMPORAL_MODEL_SHA256 is required for hosted temporal artifacts")

    full_stack = enabled(env.get("ORISLOP_REQUIRE_FULL_MODEL_STACK"), default=False)
    if full_stack:
        if not enabled(env.get("ORISLOP_TEMPORAL_ENABLED"), default=True):
            errors.append("Full model stack requires ORISLOP_TEMPORAL_ENABLED=1")
        if not enabled(env.get("ORISLOP_AV_JOINT_ENABLED"), default=True):
            errors.append("Full model stack requires ORISLOP_AV_JOINT_ENABLED=1")
        local_complete = all(env.get(name, "").strip() for name in FULL_STACK_PATHS)
        repo_id = env.get("ORISLOP_AV_JOINT_HF_REPO_ID", "").strip()
        revision = env.get("ORISLOP_AV_JOINT_HF_REVISION", "").strip()
        if not local_complete:
            if not repo_id:
                errors.append("Full model stack requires local AV artifacts or ORISLOP_AV_JOINT_HF_REPO_ID")
            if not immutable_hf_revision(revision):
                errors.append("ORISLOP_AV_JOINT_HF_REVISION must be a full immutable 40-character commit")
            for file_name_var in FULL_STACK_HF_FILES.values():
                if not env.get(file_name_var, "").strip():
                    errors.append(f"{file_name_var} is required for the full-stack HF artifact package")
        if check_model_path and local_complete:
            errors.extend(validate_local_full_stack(env))

    return list(dict.fromkeys(errors))


def parse_gpu_csv(line: str) -> dict[str, Any]:
    parts = [part.strip() for part in line.split(",")]
    if len(parts) < 3:
        raise PreflightError(f"Unexpected nvidia-smi output: {line!r}")
    try:
        memory_mib = int(float(parts[1]))
    except ValueError as error:
        raise PreflightError(f"Invalid GPU memory value: {parts[1]!r}") from error
    return {"name": parts[0], "memory_mib": memory_mib, "driver": parts[2]}


def query_gpu() -> dict[str, Any]:
    command = [
        "nvidia-smi",
        "--query-gpu=name,memory.total,driver_version",
        "--format=csv,noheader,nounits",
    ]
    try:
        result = subprocess.run(command, check=True, capture_output=True, text=True, timeout=30)
    except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        raise PreflightError(f"nvidia-smi failed; the Vast instance has no usable NVIDIA GPU: {error}") from error
    lines = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    if len(lines) != 1:
        raise PreflightError(f"Expected exactly one visible GPU, found {len(lines)}")
    return parse_gpu_csv(lines[0])


def system_ram_gib() -> float:
    meminfo = Path("/proc/meminfo")
    if not meminfo.is_file():
        raise PreflightError("/proc/meminfo is unavailable")
    for line in meminfo.read_text(encoding="utf-8").splitlines():
        if line.startswith("MemTotal:"):
            kib = int(line.split()[1])
            return kib / 1024 / 1024
    raise PreflightError("MemTotal is missing from /proc/meminfo")


def choose_ollama_device(requested: str, gpu_memory_mib: int) -> str:
    normalized = requested.strip().lower()
    if normalized in {"cpu", "gpu"}:
        return normalized
    if normalized != "auto":
        raise PreflightError("ORISLOP_OLLAMA_DEVICE must be auto, cpu, or gpu")
    # Preserve the 24 GB card for the temporal/spatial ensemble.  Qwen 1.5B is
    # inexpensive on CPU, while a detector OOM would break the entire request.
    return "gpu" if gpu_memory_mib >= 32 * 1024 else "cpu"


def hardware_preflight(env: Mapping[str, str]) -> dict[str, Any]:
    gpu = query_gpu()
    cpu_count = os.cpu_count() or 0
    ram_gib = system_ram_gib()
    MODEL_ROOT.mkdir(parents=True, exist_ok=True)
    disk = shutil.disk_usage(MODEL_ROOT)
    disk_free_gib = disk.free / 1024**3
    min_vram_gib = float(env.get("ORISLOP_PREFLIGHT_MIN_VRAM_GIB", "20"))
    min_ram_gib = float(env.get("ORISLOP_PREFLIGHT_MIN_RAM_GIB", "24"))
    min_cpu = int(env.get("ORISLOP_PREFLIGHT_MIN_CPU", "8"))
    min_disk_gib = float(env.get("ORISLOP_PREFLIGHT_MIN_DISK_FREE_GIB", "25"))

    errors: list[str] = []
    if gpu["memory_mib"] < min_vram_gib * 1024:
        errors.append(f"GPU has {gpu['memory_mib'] / 1024:.1f} GiB; {min_vram_gib:.1f} GiB required")
    if ram_gib < min_ram_gib:
        errors.append(f"System has {ram_gib:.1f} GiB RAM; {min_ram_gib:.1f} GiB required")
    if cpu_count < min_cpu:
        errors.append(f"System has {cpu_count} CPUs; {min_cpu} required")
    if disk_free_gib < min_disk_gib:
        errors.append(f"Only {disk_free_gib:.1f} GiB disk is free; {min_disk_gib:.1f} GiB required")
    if errors:
        raise PreflightError("Hardware preflight failed: " + "; ".join(errors))

    ollama_device = choose_ollama_device(env.get("ORISLOP_OLLAMA_DEVICE", "auto"), gpu["memory_mib"])
    return {
        "gpu": gpu,
        "cpu_count": cpu_count,
        "ram_gib": round(ram_gib, 1),
        "disk_free_gib": round(disk_free_gib, 1),
        "ollama_device": ollama_device,
        "recommended_gpu": "RTX 3090" in gpu["name"],
    }


def write_status(phase: str, *, started_at: float, **details: Any) -> None:
    STATUS_ROOT.mkdir(parents=True, exist_ok=True)
    payload = {
        "phase": phase,
        "elapsed_seconds": round(time.monotonic() - started_at, 1),
        "updated_at_epoch": int(time.time()),
        **details,
    }
    temporary = STATUS_ROOT / "status.json.tmp"
    temporary.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(STATUS_ROOT / "status.json")
    log(phase, **details)


def request_json(
    url: str,
    *,
    method: str = "GET",
    payload: Mapping[str, Any] | None = None,
    headers: Mapping[str, str] | None = None,
    timeout: float = 10,
) -> tuple[int, Any]:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request_headers = {"Accept": "application/json", **(dict(headers or {}))}
    if body is not None:
        request_headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=body, method=method, headers=request_headers)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
            return response.status, json.loads(raw) if raw else None
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", errors="replace")
        try:
            decoded: Any = json.loads(raw)
        except json.JSONDecodeError:
            decoded = raw
        return error.code, decoded


def wait_for_url(
    url: str,
    process: subprocess.Popen[Any],
    timeout_seconds: float,
    peers: Sequence[tuple[str, subprocess.Popen[Any]]] = (),
) -> None:
    deadline = time.monotonic() + timeout_seconds
    last_error = ""
    while time.monotonic() < deadline:
        return_code = process.poll()
        if return_code is not None:
            raise PreflightError(f"{process.args!r} exited with status {return_code}")
        for peer_name, peer in peers:
            peer_return_code = peer.poll()
            if peer_return_code is not None:
                raise PreflightError(f"Required process {peer_name} exited with status {peer_return_code}")
        try:
            status, _ = request_json(url, timeout=5)
            if status == 200:
                return
            last_error = f"HTTP {status}"
        except Exception as error:  # Network readiness intentionally retries.
            last_error = str(error)
        time.sleep(2)
    raise PreflightError(f"Timed out waiting for {url}: {last_error}")


def child_environment(env: Mapping[str, str], hardware: Mapping[str, Any]) -> dict[str, str]:
    child = dict(env)
    require_tunnel = enabled(env.get("ORISLOP_REQUIRE_CLOUDFLARE"), default=True)
    direct_testing = not require_tunnel
    child.update({
        "ORISLOP_DETECTOR_HOST": "127.0.0.1" if direct_testing else "0.0.0.0",
        "ORISLOP_DETECTOR_PORT": env.get("ORISLOP_DETECTOR_PORT", "4317"),
        "ORISLOP_REQUIRE_API_AUTH": "0" if direct_testing else "1",
        "ORISLOP_ALLOW_ORIGINLESS_POSTS": "0",
        "ORISLOP_CLOUD_HEAVY_ENABLED": "1",
        "ORISLOP_CLOUD_HEAVY_DEVICE": "cuda",
        "ORISLOP_REQUIRE_FULL_MODEL_STACK": env.get("ORISLOP_REQUIRE_FULL_MODEL_STACK", "1"),
        "ORISLOP_TEMPORAL_ENABLED": "1",
        "ORISLOP_TEMPORAL_LEGACY_FALLBACK": "0",
        "ORISLOP_TEMPORAL_ROLLOUT": env.get("ORISLOP_TEMPORAL_ROLLOUT", "corroborated"),
        "ORISLOP_AV_JOINT_ENABLED": "1",
        "ORISLOP_SPATIAL_DEVICE": "cuda",
        "ORISLOP_SPATIAL_AUX_DEVICE": env.get("ORISLOP_SPATIAL_AUX_DEVICE", "cpu"),
        "ORISLOP_TRANSCRIPTION_DEVICE": env.get("ORISLOP_TRANSCRIPTION_DEVICE", "cpu"),
        "ORISLOP_TRANSCRIPTION_COMPUTE_TYPE": env.get("ORISLOP_TRANSCRIPTION_COMPUTE_TYPE", "int8"),
        "ORISLOP_OLLAMA_URL": OLLAMA_URL,
        "ORISLOP_TRUSTED_OLLAMA_HOST": "127.0.0.1",
        "ORISLOP_TEMP_MEDIA_ROOT": env.get("ORISLOP_TEMP_MEDIA_ROOT", "/run/orislop-media"),
        "ORISLOP_DETECTOR_CACHE": env.get("ORISLOP_DETECTOR_CACHE", str(MODEL_ROOT / "orislop-cache")),
        "OLLAMA_MODELS": env.get("OLLAMA_MODELS", str(MODEL_ROOT / "ollama")),
        "HF_HOME": env.get("HF_HOME", str(MODEL_ROOT / "huggingface")),
        "HF_HUB_CACHE": env.get("HF_HUB_CACHE", str(MODEL_ROOT / "huggingface" / "hub")),
        "TRANSFORMERS_CACHE": env.get(
            "TRANSFORMERS_CACHE", str(MODEL_ROOT / "huggingface" / "transformers")
        ),
        "TORCH_HOME": env.get("TORCH_HOME", str(MODEL_ROOT / "torch")),
        "ORISLOP_RESOLVED_OLLAMA_DEVICE": str(hardware["ollama_device"]),
    })
    for path_name in (
        "ORISLOP_TEMP_MEDIA_ROOT",
        "ORISLOP_DETECTOR_CACHE",
        "OLLAMA_MODELS",
        "HF_HOME",
        "TRANSFORMERS_CACHE",
        "TORCH_HOME",
    ):
        Path(child[path_name]).mkdir(parents=True, exist_ok=True)
    return child


def minimal_runtime_environment(env: Mapping[str, str]) -> dict[str, str]:
    """Keep service-specific child processes from inheriting unrelated secrets."""
    return {key: value for key, value in env.items() if key in RUNTIME_ENV_KEYS}


def detector_environment(env: Mapping[str, str]) -> dict[str, str]:
    allowed = minimal_runtime_environment(env)
    allowed.update({
        key: value
        for key, value in env.items()
        if key.startswith("ORISLOP_") or key in DETECTOR_ENV_KEYS
    })
    allowed.pop("CLOUDFLARE_TUNNEL_TOKEN", None)
    return allowed


def redacted_command(command: Sequence[str]) -> list[str]:
    redacted = list(command)
    for index, value in enumerate(redacted[:-1]):
        if value in {"--token", "--password", "--secret"}:
            redacted[index + 1] = "***REDACTED***"
    return redacted


def start_process(name: str, command: Sequence[str], env: Mapping[str, str]) -> subprocess.Popen[Any]:
    log("starting process", name=name, command=redacted_command(command))
    try:
        return subprocess.Popen(list(command), env=dict(env))
    except FileNotFoundError as error:
        raise PreflightError(f"Cannot start {name}; executable is missing: {command[0]}") from error


def prepare_ollama(env: Mapping[str, str], hardware: Mapping[str, Any]) -> tuple[subprocess.Popen[Any], dict[str, str]]:
    ollama_env = minimal_runtime_environment(env)
    ollama_env["OLLAMA_HOST"] = "127.0.0.1:11434"
    ollama_env["OLLAMA_MODELS"] = env["OLLAMA_MODELS"]
    ollama_env["OLLAMA_KEEP_ALIVE"] = env.get("ORISLOP_OLLAMA_KEEP_ALIVE", "24h")
    if hardware["ollama_device"] == "cpu":
        ollama_env["CUDA_VISIBLE_DEVICES"] = "-1"
    process = start_process("ollama", ["ollama", "serve"], ollama_env)
    try:
        wait_for_url(f"{OLLAMA_URL}/api/tags", process, 180)

        model = env.get("ORISLOP_OLLAMA_MODEL", "qwen2.5:1.5b-instruct")
        show = subprocess.run(["ollama", "show", model], env=ollama_env, capture_output=True, text=True)
        if show.returncode != 0:
            gguf_value = env.get("ORISLOP_OLLAMA_GGUF_PATH", "").strip()
            if gguf_value:
                gguf = Path(gguf_value).expanduser().resolve()
                if not gguf.is_file():
                    raise PreflightError(f"Bundled Ollama GGUF is missing: {gguf}")
                expected = env.get("ORISLOP_OLLAMA_GGUF_SHA256", "").strip().lower()
                if not re.fullmatch(r"[0-9a-f]{64}", expected):
                    raise PreflightError("ORISLOP_OLLAMA_GGUF_SHA256 must pin the bundled GGUF")
                actual = sha256_file(gguf)
                if actual != expected:
                    raise PreflightError(
                        f"Bundled Ollama GGUF SHA-256 mismatch: expected {expected}, got {actual}"
                    )
                STATUS_ROOT.mkdir(parents=True, exist_ok=True)
                modelfile = STATUS_ROOT / "Qwen2.5.Modelfile"
                modelfile.write_text(f"FROM {gguf}\n", encoding="utf-8")
                log("creating Ollama model from bundled verified GGUF", model=model, gguf=str(gguf))
                subprocess.run(
                    ["ollama", "create", model, "--file", str(modelfile)],
                    env=ollama_env,
                    check=True,
                )
            else:
                log("pulling Ollama model", model=model)
                subprocess.run(["ollama", "pull", model], env=ollama_env, check=True)
        status, response = request_json(
            f"{OLLAMA_URL}/api/generate",
            method="POST",
            payload={
                "model": model,
                "prompt": "Reply only with OK.",
                "stream": False,
                "keep_alive": env.get("ORISLOP_OLLAMA_KEEP_ALIVE", "24h"),
                "options": {"num_predict": 4, "temperature": 0},
            },
            timeout=180,
        )
        if status != 200 or not isinstance(response, dict):
            raise PreflightError(f"Ollama warmup failed with HTTP {status}: {response!r}")
        return process, ollama_env
    except Exception:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
        raise


def diagnostic_health(env: Mapping[str, str]) -> Any:
    token = first_api_token(env)
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    try:
        _, payload = request_json(
            f"http://127.0.0.1:{env.get('ORISLOP_DETECTOR_PORT', '4317')}/health",
            headers=headers,
            timeout=10,
        )
        return payload
    except Exception as error:
        return {"error": str(error)}


def terminate_all(processes: Sequence[tuple[str, subprocess.Popen[Any]]]) -> None:
    for name, process in reversed(processes):
        if process.poll() is None:
            log("stopping process", name=name)
            process.terminate()
    deadline = time.monotonic() + 15
    for _, process in reversed(processes):
        if process.poll() is None:
            try:
                process.wait(timeout=max(0.1, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                process.kill()


def run_supervisor(env: Mapping[str, str]) -> int:
    started_at = time.monotonic()
    configuration_errors = validate_configuration(env, check_model_path=False)
    if configuration_errors:
        raise PreflightError("Configuration preflight failed:\n- " + "\n- ".join(configuration_errors))
    hardware = hardware_preflight(env)
    write_status("preflight-passed", started_at=started_at, hardware=hardware)

    resolved_env = materialize_full_stack_artifacts(env)
    configuration_errors = validate_configuration(resolved_env, check_model_path=True)
    if configuration_errors:
        raise PreflightError("Artifact preflight failed:\n- " + "\n- ".join(configuration_errors))
    child_env = child_environment(resolved_env, hardware)
    processes: list[tuple[str, subprocess.Popen[Any]]] = []
    tunnel_token_file: Path | None = None
    stopping = False

    def request_stop(signum: int, _frame: Any) -> None:
        nonlocal stopping
        stopping = True
        log("shutdown requested", signal=signum)

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)

    try:
        ollama, _ = prepare_ollama(child_env, hardware)
        processes.append(("ollama", ollama))
        write_status(
            "ollama-ready",
            started_at=started_at,
            model=child_env.get("ORISLOP_OLLAMA_MODEL", "qwen2.5:1.5b-instruct"),
            device=hardware["ollama_device"],
        )

        tunnel_token = child_env.get("CLOUDFLARE_TUNNEL_TOKEN", "").strip()
        if tunnel_token:
            tunnel_token_file = STATUS_ROOT / "cloudflared-token"
            tunnel_token_file.write_text(tunnel_token, encoding="utf-8")
            tunnel_token_file.chmod(0o600)
            tunnel_env = minimal_runtime_environment(child_env)
            cloudflared = start_process(
                "cloudflared",
                [
                    "cloudflared",
                    "tunnel",
                    "--no-autoupdate",
                    "run",
                    "--token-file",
                    str(tunnel_token_file),
                ],
                tunnel_env,
            )
            processes.append(("cloudflared", cloudflared))

        if not SERVER_SCRIPT.is_file():
            raise PreflightError(f"Detector server is missing: {SERVER_SCRIPT}")
        detector_env = detector_environment(child_env)
        server = start_process("detector", [sys.executable, "-u", str(SERVER_SCRIPT)], detector_env)
        processes.append(("detector", server))
        port = child_env.get("ORISLOP_DETECTOR_PORT", "4317")
        startup_timeout = float(child_env.get("ORISLOP_STARTUP_TIMEOUT_SECONDS", "1800"))
        try:
            wait_for_url(
                f"http://127.0.0.1:{port}/ready",
                server,
                startup_timeout,
                peers=processes,
            )
        except Exception:
            log("detector readiness diagnostics", health=diagnostic_health(child_env))
            raise
        write_status("ready", started_at=started_at, hardware=hardware, port=int(port))

        while not stopping:
            for name, process in processes:
                return_code = process.poll()
                if return_code is not None:
                    raise PreflightError(f"Required process {name} exited with status {return_code}")
            time.sleep(1)
        return 0
    finally:
        try:
            write_status("stopping", started_at=started_at)
        finally:
            terminate_all(processes)
            if tunnel_token_file is not None:
                tunnel_token_file.unlink(missing_ok=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--preflight-only",
        action="store_true",
        help="Validate configuration and hardware without starting or downloading models.",
    )
    parser.add_argument(
        "--config-only",
        action="store_true",
        help="Validate environment syntax without requiring Linux, a GPU, or local model files.",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    env = dict(os.environ)
    try:
        errors = validate_configuration(
            env,
            check_model_path=not (args.config_only or args.preflight_only),
        )
        if errors:
            raise PreflightError("Configuration preflight failed:\n- " + "\n- ".join(errors))
        if args.config_only:
            log("configuration valid")
            return 0
        if args.preflight_only:
            log("preflight valid", hardware=hardware_preflight(env))
            return 0
        return run_supervisor(env)
    except (PreflightError, subprocess.CalledProcessError, ValueError, OSError) as error:
        log("fatal", error=str(error))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
