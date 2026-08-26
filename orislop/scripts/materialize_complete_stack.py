#!/usr/bin/env python3
"""Resumably download, verify, and configure one Orislop HF release."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import time
from typing import Any, Callable, Mapping, Sequence


REVISION_RE = re.compile(r"^[0-9a-fA-F]{40}$")
SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")
DEFAULT_REPO = "gonnerthetooner/orislop-complete-stack-v1"
DEFAULT_REVISION = "09f0510580de5a8c11393adc7d7905ab40b200ab"
DEFAULT_MANIFEST_SHA256 = "f64fecb421f435cdd7e7e46374a965ea4708ae509a19c761a64e7314fef5c7dc"
DEFAULT_RELEASE_BYTES = 2_794_404_210


class MaterializeError(RuntimeError):
    pass


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def valid_file(path: Path, record: Mapping[str, Any]) -> bool:
    try:
        size = int(record["bytes"])
        expected = str(record["sha256"]).lower()
    except (KeyError, TypeError, ValueError):
        return False
    return (
        path.is_file()
        and path.stat().st_size == size
        and SHA256_RE.fullmatch(expected) is not None
        and sha256_file(path) == expected
    )


def load_manifest(root: Path) -> dict[str, Any]:
    path = root / "artifact_manifest.json"
    if not path.is_file():
        raise MaterializeError(f"Complete-stack manifest is missing: {path}")
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("artifactType") != "orislop-complete-runnable-stack":
        raise MaterializeError("HF repository is not an Orislop complete-stack release")
    if not isinstance(payload.get("files"), dict) or not payload["files"]:
        raise MaterializeError("Complete-stack manifest has no file inventory")
    expected_root = root.resolve()
    for relative, record in payload["files"].items():
        target = (root / relative).resolve()
        if not target.is_relative_to(expected_root):
            raise MaterializeError(f"Unsafe manifest path: {relative}")
        if not isinstance(record, dict):
            raise MaterializeError(f"Invalid manifest record: {relative}")
        try:
            byte_count = int(record["bytes"])
        except (KeyError, TypeError, ValueError) as error:
            raise MaterializeError(f"Invalid manifest byte count: {relative}") from error
        if byte_count < 0 or SHA256_RE.fullmatch(str(record.get("sha256", ""))) is None:
            raise MaterializeError(f"Invalid manifest integrity record: {relative}")
    return payload


def verify(root: Path, manifest: Mapping[str, Any]) -> None:
    files = manifest["files"]
    for index, (relative, record) in enumerate(files.items(), start=1):
        target = root / relative
        if not valid_file(target, record):
            if not target.is_file():
                raise MaterializeError(f"Complete-stack file is missing: {relative}")
            raise MaterializeError(f"Complete-stack size or SHA-256 mismatch: {relative}")
        if index % 25 == 0 or index == len(files):
            print(f"[verification] {index}/{len(files)}", flush=True)


def verified_existing_bytes(root: Path, expected_manifest_sha256: str) -> int:
    manifest_path = root / "artifact_manifest.json"
    if not manifest_path.is_file() or sha256_file(manifest_path) != expected_manifest_sha256.lower():
        return 0
    try:
        manifest = load_manifest(root)
    except (MaterializeError, OSError, json.JSONDecodeError):
        return 0
    return sum(
        int(record["bytes"])
        for relative, record in manifest["files"].items()
        if valid_file(root / relative, record)
    )


def write_phase_status(status_file: Path | None, phase: str, **details: Any) -> None:
    print(f"[{phase}] " + json.dumps(details, sort_keys=True), flush=True)
    if status_file is None:
        return
    status_file.parent.mkdir(parents=True, exist_ok=True)
    payload = {"phase": phase, "state": "starting", "updated_at_epoch": int(time.time()), **details}
    temporary = status_file.with_suffix(status_file.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, status_file)


DownloadFunction = Callable[..., str]


def download_with_retries(
    downloader: DownloadFunction,
    *,
    repo: str,
    revision: str,
    filename: str,
    destination: Path,
    token: str,
    force_download: bool,
    attempts: int = 4,
) -> Path:
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return Path(downloader(
                repo_id=repo,
                revision=revision,
                filename=filename,
                token=token,
                local_dir=str(destination),
                force_download=force_download or attempt > 1,
            )).resolve()
        except Exception as error:  # The hub client owns the resumable partial file.
            last_error = error
            if attempt < attempts:
                print(f"[download] retry {attempt}/{attempts - 1} for {filename}: {type(error).__name__}", flush=True)
                time.sleep(min(2 ** (attempt - 1), 8))
    raise MaterializeError(
        f"Could not download {filename} after {attempts} attempts: {last_error}"
    ) from last_error


def materialize_release(
    *,
    downloader: DownloadFunction,
    repo: str,
    revision: str,
    destination: Path,
    token: str,
    expected_manifest_sha256: str,
    expected_release_bytes: int,
    status_file: Path | None = None,
) -> dict[str, Any]:
    destination.mkdir(parents=True, exist_ok=True)
    manifest_path = destination / "artifact_manifest.json"
    write_phase_status(status_file, "download", item="artifact_manifest.json")
    if not manifest_path.is_file() or sha256_file(manifest_path) != expected_manifest_sha256.lower():
        downloaded_manifest = download_with_retries(
            downloader,
            repo=repo,
            revision=revision,
            filename="artifact_manifest.json",
            destination=destination,
            token=token,
            force_download=manifest_path.exists(),
        )
        if downloaded_manifest != manifest_path.resolve() and downloaded_manifest.is_file():
            manifest_path.write_bytes(downloaded_manifest.read_bytes())
    if not manifest_path.is_file() or sha256_file(manifest_path) != expected_manifest_sha256.lower():
        raise MaterializeError("Complete-stack manifest receipt does not match the pinned release")
    manifest = load_manifest(destination)
    total_bytes = sum(int(record["bytes"]) for record in manifest["files"].values())
    if expected_release_bytes and total_bytes != expected_release_bytes:
        raise MaterializeError(
            f"Manifest byte total is {total_bytes}; expected {expected_release_bytes}"
        )
    reused = 0
    downloaded = 0
    for index, (relative, record) in enumerate(manifest["files"].items(), start=1):
        target = destination / relative
        if valid_file(target, record):
            reused += 1
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            downloaded_path = download_with_retries(
                downloader,
                repo=repo,
                revision=revision,
                filename=relative,
                destination=destination,
                token=token,
                force_download=target.exists(),
            )
            if downloaded_path != target.resolve() and downloaded_path.is_file():
                shutil.copy2(downloaded_path, target)
            if not valid_file(target, record):
                raise MaterializeError(f"Downloaded file failed size/SHA-256 verification: {relative}")
            downloaded += 1
        if index % 25 == 0 or index == len(manifest["files"]):
            print(
                f"[download] {index}/{len(manifest['files'])} reused={reused} downloaded={downloaded}",
                flush=True,
            )
    write_phase_status(status_file, "verification", files=len(manifest["files"]))
    verify(destination, manifest)
    return {
        "manifest": manifest,
        "reusedFiles": reused,
        "downloadedFiles": downloaded,
        "totalBytes": total_bytes,
    }


def manifest_sha(manifest: Mapping[str, Any], relative: str) -> str:
    record = manifest["files"].get(relative)
    if not isinstance(record, dict):
        raise MaterializeError(f"Manifest does not contain required file: {relative}")
    digest = str(record.get("sha256") or "").lower()
    if SHA256_RE.fullmatch(digest) is None:
        raise MaterializeError(f"Manifest has an invalid hash for: {relative}")
    return digest


def require_path(root: Path, relative: str, *, directory: bool = False) -> Path:
    target = (root / relative).resolve()
    expected = target.is_dir() if directory else target.is_file()
    if not expected:
        kind = "directory" if directory else "file"
        raise MaterializeError(f"Required complete-stack {kind} is missing: {relative}")
    return target


def env_lines(root: Path, manifest: Mapping[str, Any], repo: str, revision: str) -> list[str]:
    temporal = require_path(root, "orislop/temporal/final_model_package", directory=True)
    temporal_weights_relative = next(
        name
        for name in (
            "orislop/temporal/final_model_package/final_model.safetensors",
            "orislop/temporal/final_model_package/final_model.pt",
        )
        if (root / name).is_file()
    )
    av_model = require_path(root, "orislop/av/orislop_av_joint_v1.ts")
    av_metadata = require_path(root, "orislop/av/orislop_av_joint_v1.json")
    yunet = require_path(root, "orislop/av/face_detection_yunet_2023mar.onnx")
    fusion = require_path(root, "orislop/temporal/phase2_av/stage2_temporal_av_fusion.pt")
    calibration = require_path(root, "orislop/temporal/phase2_av/stage3_temporal_av_calibration.pt")
    standalone_spatial = require_path(root, "orislop/spatial/standalone/fusion_model_cls_v2.pt")
    ai_model = require_path(root, "upstream/lightweight-ai-image-detector", directory=True)
    vision_model = require_path(root, "upstream/vit-base-patch16-224", directory=True)
    public_frame = require_path(root, "upstream/public-frame-detector", directory=True)
    aegis = require_path(root, "upstream/aegis-motion/checkpoint_best.pt")
    whisper = require_path(root, "upstream/faster-whisper-tiny", directory=True)
    qwen = require_path(root, "upstream/qwen2.5-1.5b-instruct-gguf/qwen2.5-1.5b-instruct-q4_k_m.gguf")
    return [
        "# Generated by materialize_complete_stack.py; contains no secrets.",
        f"ORISLOP_COMPLETE_STACK_REPO={repo}",
        f"ORISLOP_COMPLETE_STACK_REVISION={revision}",
        f"ORISLOP_COMPLETE_STACK_ROOT={root}",
        "ORISLOP_REQUIRE_FULL_MODEL_STACK=1",
        "ORISLOP_TEMPORAL_ENABLED=1",
        f"ORISLOP_TEMPORAL_PACKAGE_PATH={temporal}",
        "ORISLOP_TEMPORAL_HF_REPO_ID=",
        "ORISLOP_TEMPORAL_HF_REVISION=",
        f"ORISLOP_TEMPORAL_MODEL_SHA256={manifest_sha(manifest, temporal_weights_relative)}",
        "ORISLOP_TEMPORAL_LEGACY_FALLBACK=0",
        "ORISLOP_TEMPORAL_ROLLOUT=corroborated",
        "ORISLOP_AV_JOINT_ENABLED=1",
        f"ORISLOP_AV_JOINT_MODEL_PATH={av_model}",
        f"ORISLOP_AV_JOINT_METADATA_PATH={av_metadata}",
        f"ORISLOP_YUNET_MODEL_PATH={yunet}",
        f"ORISLOP_YUNET_MODEL_SHA256={manifest_sha(manifest, 'orislop/av/face_detection_yunet_2023mar.onnx')}",
        f"ORISLOP_TEMPORAL_AV_FUSION_PATH={fusion}",
        f"ORISLOP_TEMPORAL_AV_CALIBRATION_PATH={calibration}",
        f"ORISLOP_SPATIAL_CHECKPOINT_PATH={standalone_spatial}",
        f"ORISLOP_AI_MODEL_SOURCE={ai_model}",
        f"ORISLOP_VISION_MODEL_SOURCE={vision_model}",
        f"ORISLOP_PUBLIC_FRAME_MODEL_DIR={public_frame}",
        f"ORISLOP_AEGIS_CHECKPOINT_PATH={aegis}",
        f"ORISLOP_TRANSCRIPTION_MODEL={whisper}",
        f"ORISLOP_OLLAMA_GGUF_PATH={qwen}",
        f"ORISLOP_OLLAMA_GGUF_SHA256={manifest_sha(manifest, 'upstream/qwen2.5-1.5b-instruct-gguf/qwen2.5-1.5b-instruct-q4_k_m.gguf')}",
        "ORISLOP_OLLAMA_MODEL=orislop-qwen2.5:1.5b-instruct",
        "ORISLOP_CLIP_MODEL_SOURCE=openai/clip-vit-base-patch32",
        "ORISLOP_TEMPORAL_CLIP_MODEL_SOURCE=openai/clip-vit-base-patch32",
        "ORISLOP_TEMPORAL_CLIP_MODEL_REVISION=3d74acf9a28c67741b2f4f2ea7635f0aaf6f0268",
        "ORISLOP_SPATIAL_DEVICE=cuda",
        "ORISLOP_SPATIAL_AUX_DEVICE=cpu",
        "ORISLOP_TRANSCRIPTION_DEVICE=cpu",
        "ORISLOP_TRANSCRIPTION_COMPUTE_TYPE=int8",
        "ORISLOP_CLOUD_BETA_AUTOMATIC_HIDES=0",
        "ORISLOP_VISUAL_ROLLOUT_MODE=shadow",
    ]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default=DEFAULT_REPO)
    parser.add_argument("--revision", default=DEFAULT_REVISION, help="Full 40-character HF commit")
    parser.add_argument("--destination", default="/models/orislop-complete-stack")
    parser.add_argument("--env-output", default="/models/orislop-complete-stack/model.env")
    parser.add_argument("--expected-manifest-sha256", default=DEFAULT_MANIFEST_SHA256)
    parser.add_argument("--expected-release-bytes", type=int, default=DEFAULT_RELEASE_BYTES)
    parser.add_argument("--status-file", default="")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if REVISION_RE.fullmatch(args.revision) is None:
        raise MaterializeError("--revision must be a full immutable 40-character commit")
    if SHA256_RE.fullmatch(args.expected_manifest_sha256) is None:
        raise MaterializeError("--expected-manifest-sha256 must be a 64-character SHA-256")
    token = os.environ.get("HF_TOKEN", "").strip()
    if not token:
        raise MaterializeError(
            "HF_TOKEN is missing. Export a newly rotated Hugging Face read token and run again; this launcher never prompts."
        )
    try:
        from huggingface_hub import hf_hub_download
    except ImportError as error:
        raise MaterializeError("Install huggingface-hub before materializing the release") from error
    destination = Path(args.destination).expanduser().resolve()
    status_file = Path(args.status_file).expanduser().resolve() if args.status_file else None
    result = materialize_release(
        downloader=hf_hub_download,
        repo=args.repo,
        revision=args.revision,
        destination=destination,
        token=token,
        expected_manifest_sha256=args.expected_manifest_sha256,
        expected_release_bytes=args.expected_release_bytes,
        status_file=status_file,
    )
    write_phase_status(status_file, "materialization", destination=str(destination))
    env_output = Path(args.env_output).expanduser().resolve()
    env_output.parent.mkdir(parents=True, exist_ok=True)
    temporary = env_output.with_suffix(env_output.suffix + ".tmp")
    temporary.write_text(
        "\n".join(env_lines(destination, result["manifest"], args.repo, args.revision)) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, env_output)
    print(json.dumps({
        "status": "complete-stack-materialized",
        "repo": args.repo,
        "revision": args.revision,
        "root": str(destination),
        "env": str(env_output),
        "source": str(destination / "runtime" / "source"),
        "verifiedFiles": len(result["manifest"]["files"]),
        "reusedFiles": result["reusedFiles"],
        "downloadedFiles": result["downloadedFiles"],
        "completeOffline": bool(result["manifest"].get("completeOffline")),
    }, indent=2), flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except MaterializeError as error:
        print(f"[failed] {error}", flush=True)
        raise SystemExit(2) from None
