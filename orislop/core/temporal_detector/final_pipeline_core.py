#!/usr/bin/env python3
"""Shared, dependency-light primitives for the two-session final pipeline.

This module deliberately uses only the Python standard library plus NumPy for
NPZ decoding.  It is importable by the CPU pack builder, the PyTorch trainer,
the launcher, and the test suite without triggering model downloads.
"""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
import re
import tarfile
import tempfile
import time
from collections import Counter, OrderedDict, defaultdict
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Dict, Iterable, Iterator, List, Mapping, Optional, Sequence, Set, Tuple


GIB = 1024 ** 3
PACK_FORMAT_VERSION = 1
REQUIRED_PACK_FILES = ("manifest.jsonl", "pack.json", "READY")


class PackError(RuntimeError):
    """Base class for actionable pack and tar errors."""


class MissingArchiveError(PackError, FileNotFoundError):
    pass


class MissingMemberError(PackError, FileNotFoundError):
    pass


class CorruptNPZError(PackError):
    pass


class UnsafePathError(PackError, ValueError):
    pass


def utc_now() -> str:
    import datetime

    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path, chunk_size: int = 8 * 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(chunk_size)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def atomic_write_bytes(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    temp_path = Path(temp_name)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
    finally:
        with contextlib.suppress(FileNotFoundError):
            temp_path.unlink()


def atomic_write_json(path: Path, value: Any) -> None:
    atomic_write_bytes(path, (json.dumps(value, indent=2, sort_keys=True) + "\n").encode("utf-8"))


def safe_relative_posix(value: str, field: str) -> str:
    normalized = str(value).replace("\\", "/")
    path = PurePosixPath(normalized)
    if not normalized or path.is_absolute() or ".." in path.parts:
        raise UnsafePathError(f"unsafe {field}: {value!r}")
    cleaned = str(path)
    if cleaned in {"", "."}:
        raise UnsafePathError(f"empty {field}: {value!r}")
    return cleaned


def resolve_inside(root: Path, relative: str, field: str) -> Path:
    safe = safe_relative_posix(relative, field)
    root_resolved = root.resolve()
    candidate = (root_resolved / Path(*PurePosixPath(safe).parts)).resolve()
    try:
        candidate.relative_to(root_resolved)
    except ValueError as exc:
        raise UnsafePathError(f"{field} escapes pack root: {relative!r}") from exc
    return candidate


def normalize_manifest_row(raw: Mapping[str, Any], line_no: int = 0) -> Dict[str, Any]:
    row = dict(raw)
    member = row.get("member_path", row.get("npz_member_path", row.get("member")))
    archive = row.get("archive_path")
    video_path = row.get("video_path", row.get("path", row.get("npz_path", member)))
    if video_path is None:
        raise PackError(f"manifest line {line_no}: missing video_path/path/member_path")
    try:
        label = int(row["label"])
    except Exception as exc:
        raise PackError(f"manifest line {line_no}: missing or invalid label") from exc
    if label not in (0, 1):
        raise PackError(f"manifest line {line_no}: label must be 0 or 1, got {label}")
    row["video_path"] = str(video_path)
    row["label"] = label
    row["split"] = str(row.get("split", "train"))
    row["dataset"] = str(row.get("dataset", "unknown"))
    if archive is not None:
        row["archive_path"] = safe_relative_posix(str(archive), "archive_path")
        if member is None:
            raise PackError(f"manifest line {line_no}: archive_path requires member_path")
        row["member_path"] = safe_relative_posix(str(member), "member_path")
        row["video_path"] = row["member_path"]
        row["source"] = "tar_precomputed"
    else:
        row["source"] = str(row.get("source", "precomputed"))
    identity = str(
        row.get("sample_id")
        or row.get("content_sha256")
        or row.get("sha256")
        or f"{row.get('archive_path', '')}:{row['video_path']}"
    )
    row["sample_id"] = identity
    if "content_sha256" not in row and row.get("sha256"):
        row["content_sha256"] = str(row["sha256"])
    if row.get("size_bytes") is not None:
        row["size_bytes"] = int(row["size_bytes"])
    return row


def iter_jsonl(path: Path) -> Iterator[Tuple[int, Dict[str, Any]]]:
    with path.open("r", encoding="utf-8") as handle:
        for line_no, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                raw = json.loads(line)
            except json.JSONDecodeError as exc:
                raise PackError(f"invalid JSON in {path}:{line_no}: {exc}") from exc
            if not isinstance(raw, dict):
                raise PackError(f"manifest row must be an object in {path}:{line_no}")
            yield line_no, normalize_manifest_row(raw, line_no)


def manifest_digest(path: Path) -> str:
    digest = hashlib.sha256()
    for _, row in iter_jsonl(path):
        digest.update(canonical_json(row).encode("utf-8"))
        digest.update(b"\n")
    return digest.hexdigest()


class TarHandleCache:
    """Process-local bounded LRU cache of read-only tar handles.

    DataLoader workers receive independent dataset instances/process memory.
    The PID guard also makes accidental post-fork reuse safe.
    """

    def __init__(self, root: str | Path, max_open: int = 4, max_member_bytes: int = 2 * GIB) -> None:
        if int(max_open) < 1:
            raise ValueError("max_open must be >= 1")
        self.root = Path(root)
        self.max_open = int(max_open)
        self.max_member_bytes = int(max_member_bytes)
        self._pid = os.getpid()
        self._handles: "OrderedDict[str, tarfile.TarFile]" = OrderedDict()

    def _after_fork_guard(self) -> None:
        if self._pid != os.getpid():
            self.close()
            self._pid = os.getpid()

    def _archive_file(self, archive_path: str) -> Path:
        path = resolve_inside(self.root, archive_path, "archive_path")
        if not path.is_file():
            raise MissingArchiveError(f"archive does not exist: {path}")
        return path

    def _get(self, archive_path: str) -> tarfile.TarFile:
        self._after_fork_guard()
        safe = safe_relative_posix(archive_path, "archive_path")
        existing = self._handles.pop(safe, None)
        if existing is not None:
            self._handles[safe] = existing
            return existing
        path = self._archive_file(safe)
        try:
            handle = tarfile.open(path, mode="r:*")
        except (tarfile.TarError, OSError) as exc:
            raise PackError(f"could not open tar archive {path}: {exc}") from exc
        self._handles[safe] = handle
        while len(self._handles) > self.max_open:
            _, old = self._handles.popitem(last=False)
            old.close()
        return handle

    def read_member(self, archive_path: str, member_path: str) -> bytes:
        safe_member = safe_relative_posix(member_path, "member_path")
        archive = self._get(archive_path)
        try:
            info = archive.getmember(safe_member)
        except KeyError as exc:
            raise MissingMemberError(f"missing tar member {safe_member!r} in {archive_path!r}") from exc
        if not info.isfile():
            raise MissingMemberError(f"tar member is not a regular file: {archive_path}:{safe_member}")
        if info.size < 1 or info.size > self.max_member_bytes:
            raise PackError(
                f"tar member size is unsafe ({info.size} bytes): {archive_path}:{safe_member}"
            )
        extracted = archive.extractfile(info)
        if extracted is None:
            raise MissingMemberError(f"could not extract tar member: {archive_path}:{safe_member}")
        payload = extracted.read(self.max_member_bytes + 1)
        if len(payload) != info.size:
            raise PackError(
                f"short read for {archive_path}:{safe_member}; expected={info.size} actual={len(payload)}"
            )
        return payload

    def member_size(self, archive_path: str, member_path: str) -> int:
        safe_member = safe_relative_posix(member_path, "member_path")
        archive = self._get(archive_path)
        try:
            info = archive.getmember(safe_member)
        except KeyError as exc:
            raise MissingMemberError(f"missing tar member {safe_member!r} in {archive_path!r}") from exc
        if not info.isfile():
            raise MissingMemberError(f"tar member is not a regular file: {archive_path}:{safe_member}")
        if info.size < 1 or info.size > self.max_member_bytes:
            raise PackError(
                f"tar member size is unsafe ({info.size} bytes): {archive_path}:{safe_member}"
            )
        return int(info.size)

    def close(self) -> None:
        while self._handles:
            _, handle = self._handles.popitem(last=False)
            with contextlib.suppress(Exception):
                handle.close()

    def __enter__(self) -> "TarHandleCache":
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()

    def __del__(self) -> None:
        self.close()


def decode_npz_views(
    payload: bytes,
    required_views: Sequence[str],
    identity: str = "<memory>",
) -> Dict[str, Any]:
    """Decode legacy materialized views or compact Orislop NPZ-v2 views.

    Legacy training packs store arrays named ``micro``, ``mid``, ``long``, and
    ``extra_long``.  ``orislop-youtube-prepared-v2`` stores one JPEG frame bank
    plus ``temporal_*_indices`` arrays instead.  This adapter intentionally
    accepts both formats so old checkpoints and packs remain reproducible.
    """

    try:
        import numpy as np

        result: Dict[str, Any] = {}
        frame_cache: Dict[int, Any] = {}
        with np.load(io.BytesIO(payload), allow_pickle=False) as data:
            for view in required_views:
                if view in data.files:
                    array = data[view]
                else:
                    index_key = (
                        "spatial_indices"
                        if view == "spatial"
                        else f"temporal_{view}_indices"
                    )
                    if index_key not in data.files:
                        raise CorruptNPZError(
                            f"{identity} is missing required view {view!r} "
                            f"(also checked {index_key!r})"
                        )
                    indices = np.asarray(data[index_key]).reshape(-1)
                    if indices.size == 0:
                        raise CorruptNPZError(f"{identity}:{index_key} is empty")
                    frames = []
                    for raw_index in indices:
                        frame_index = int(raw_index)
                        frame_key = f"frame_jpeg_{frame_index:03d}"
                        if frame_key not in data.files:
                            raise CorruptNPZError(
                                f"{identity}:{index_key} references missing {frame_key!r}"
                            )
                        if frame_index not in frame_cache:
                            encoded = np.asarray(data[frame_key], dtype=np.uint8).reshape(-1)
                            frame_cache[frame_index] = _decode_jpeg_rgb(
                                encoded, f"{identity}:{frame_key}"
                            )
                        frames.append(frame_cache[frame_index])
                    array = np.stack(frames, axis=0)
                if array.dtype.hasobject:
                    raise CorruptNPZError(f"{identity}:{view} contains object data")
                if array.ndim != 4:
                    raise CorruptNPZError(
                        f"{identity}:{view} must be rank 4, got shape={tuple(array.shape)}"
                    )
                if array.shape[-1] != 3 and array.shape[1] != 3:
                    raise CorruptNPZError(
                        f"{identity}:{view} must have an RGB channel dimension, got shape={tuple(array.shape)}"
                    )
                result[view] = array
        return result
    except CorruptNPZError:
        raise
    except Exception as exc:
        raise CorruptNPZError(f"could not decode NPZ {identity}: {exc}") from exc


def _decode_jpeg_rgb(encoded: Any, identity: str) -> Any:
    """Decode a JPEG byte vector without imposing a single image dependency."""

    import numpy as np

    try:
        import cv2  # type: ignore

        bgr = cv2.imdecode(np.asarray(encoded, dtype=np.uint8), cv2.IMREAD_COLOR)
        if bgr is None:
            raise ValueError("OpenCV returned no image")
        return cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    except ImportError:
        try:
            from PIL import Image

            with Image.open(io.BytesIO(np.asarray(encoded, dtype=np.uint8).tobytes())) as image:
                return np.asarray(image.convert("RGB")).copy()
        except ImportError as exc:
            raise CorruptNPZError(
                f"{identity} needs opencv-python-headless or Pillow for JPEG decoding"
            ) from exc
    except Exception as exc:
        raise CorruptNPZError(f"could not decode JPEG {identity}: {exc}") from exc


def _pad_or_trim_axis(array: Any, size: int, axis: int, fill: float = 0.0) -> Any:
    import numpy as np

    current = int(array.shape[axis])
    if current == size:
        return array
    if current > size:
        slices = [slice(None)] * array.ndim
        slices[axis] = slice(0, size)
        return array[tuple(slices)]
    shape = list(array.shape)
    shape[axis] = size - current
    padding = np.full(shape, fill, dtype=array.dtype)
    return np.concatenate((array, padding), axis=axis)


def _av_window_indices(data: Any) -> List[int]:
    return sorted(
        {
            int(match.group(1))
            for name in data.files
            for match in [re.fullmatch(r"lip_(\d{3})_mouth", name)]
            if match is not None
        }
    )


def _decode_av_window_from_data(
    data: Any,
    index: int,
    identity: str,
    *,
    max_faces: int,
    frames: int,
    waveform_samples: int,
) -> Dict[str, Any]:
    import numpy as np

    prefix = f"lip_{index:03d}"
    required = (
        f"{prefix}_mouth",
        f"{prefix}_waveform_pcm16",
        f"{prefix}_mask",
        f"{prefix}_quality",
    )
    missing = [name for name in required if name not in data.files]
    if missing:
        raise CorruptNPZError(f"{identity} AV window {index} is missing {missing}")
    mouth = np.asarray(data[required[0]])
    waveform_source = np.asarray(data[required[1]])
    track_mask = np.asarray(data[required[2]], dtype=np.float32)
    quality = np.asarray(data[required[3]], dtype=np.float32)
    if mouth.dtype.hasobject or waveform_source.dtype.hasobject:
        raise CorruptNPZError(f"{identity}:{prefix} contains object data")
    if mouth.ndim != 5 or mouth.shape[1] != 3:
        raise CorruptNPZError(
            f"{identity}:{required[0]} must be [F,3,T,H,W], got {mouth.shape}"
        )
    if track_mask.ndim != 2 or quality.ndim != 2 or quality.shape[-1] != 6:
        raise CorruptNPZError(f"{identity}:{prefix} has invalid mask/quality shapes")
    source_faces = min(int(mouth.shape[0]), int(track_mask.shape[0]), int(quality.shape[0]))
    mouth = mouth[:source_faces]
    track_mask = track_mask[:source_faces]
    quality = quality[:source_faces]
    mouth = _pad_or_trim_axis(mouth, int(frames), axis=2)
    track_mask = _pad_or_trim_axis(track_mask, int(frames), axis=1)
    mouth = _pad_or_trim_axis(mouth, int(max_faces), axis=0)
    track_mask = _pad_or_trim_axis(track_mask, int(max_faces), axis=0)
    quality = _pad_or_trim_axis(quality, int(max_faces), axis=0)
    waveform = waveform_source.astype(np.float32).reshape(-1)
    if waveform_source.dtype == np.int16:
        waveform /= 32768.0
    waveform = _pad_or_trim_axis(waveform, int(waveform_samples), axis=0)
    return {
        "window_index": index,
        "mouth_tracks": mouth,
        "waveform": waveform,
        "track_mask": track_mask,
        "quality": quality,
        "applicable": bool(source_faces > 0 and np.any(track_mask[:source_faces] > 0)),
        "source_faces": source_faces,
    }


def iter_npz_av_windows(
    payload: bytes,
    identity: str = "<memory>",
    *,
    max_faces: int = 4,
    frames: int = 100,
    waveform_samples: int = 64_000,
) -> Iterator[Dict[str, Any]]:
    """Return every padded AV window from a compact NPZ-v2 sample.

    The returned tensors use the exact joint-AV contract: mouth tracks are
    ``[F,3,T,112,112]``, waveform is float32 in ``[-1,1]``, track masks are
    ``[F,T]``, and quality is ``[F,6]``. Empty face windows remain present with
    an ``applicable`` flag so multimodal batches retain full-dataset coverage.
    """

    try:
        import numpy as np

        with np.load(io.BytesIO(payload), allow_pickle=False) as data:
            for index in _av_window_indices(data):
                yield _decode_av_window_from_data(
                    data,
                    index,
                    identity,
                    max_faces=max_faces,
                    frames=frames,
                    waveform_samples=waveform_samples,
                )
    except CorruptNPZError:
        raise
    except Exception as exc:
        raise CorruptNPZError(f"could not decode AV windows from {identity}: {exc}") from exc


def decode_npz_av_windows(
    payload: bytes,
    identity: str = "<memory>",
    *,
    max_faces: int = 4,
    frames: int = 100,
    waveform_samples: int = 64_000,
) -> List[Dict[str, Any]]:
    return list(
        iter_npz_av_windows(
            payload,
            identity,
            max_faces=max_faces,
            frames=frames,
            waveform_samples=waveform_samples,
        )
    )


def decode_npz_best_av_context(
    payload: bytes,
    identity: str = "<memory>",
    *,
    max_faces: int = 4,
) -> Optional[Dict[str, Any]]:
    """Choose the strongest AV window while only inflating one mouth tensor."""

    try:
        import numpy as np

        with np.load(io.BytesIO(payload), allow_pickle=False) as data:
            scored: List[Tuple[Tuple[int, float, float, int], int]] = []
            for index in _av_window_indices(data):
                prefix = f"lip_{index:03d}"
                required = (
                    f"{prefix}_mouth",
                    f"{prefix}_waveform_pcm16",
                    f"{prefix}_mask",
                    f"{prefix}_quality",
                )
                missing = [name for name in required if name not in data.files]
                if missing:
                    raise CorruptNPZError(f"{identity} AV window {index} is missing {missing}")
                mask = np.asarray(data[required[2]], dtype=np.float32)
                quality = np.asarray(data[required[3]], dtype=np.float32)
                applicable = bool(mask.ndim == 2 and mask.shape[0] > 0 and np.any(mask > 0))
                scored.append(((int(applicable), float(mask.sum()), float(quality.sum()), -index), index))
            if not scored:
                return None
            chosen = max(scored)[1]
            return _decode_av_window_from_data(
                data,
                chosen,
                identity,
                max_faces=max_faces,
                frames=100,
                waveform_samples=64_000,
            )
    except CorruptNPZError:
        raise
    except Exception as exc:
        raise CorruptNPZError(f"could not decode best AV window from {identity}: {exc}") from exc


def decode_npz_bundle(
    payload: bytes,
    required_views: Sequence[str],
    identity: str = "<memory>",
    *,
    include_av: bool = False,
    max_faces: int = 4,
) -> Dict[str, Any]:
    """Decode temporal/spatial views and an optional best AV window."""

    result: Dict[str, Any] = {"views": decode_npz_views(payload, required_views, identity)}
    if include_av:
        best = decode_npz_best_av_context(payload, identity, max_faces=max_faces)
        if best is None:
            import numpy as np

            best = {
                "window_index": -1,
                "mouth_tracks": np.zeros((max_faces, 3, 100, 112, 112), dtype=np.uint8),
                "waveform": np.zeros(64_000, dtype=np.float32),
                "track_mask": np.zeros((max_faces, 100), dtype=np.float32),
                "quality": np.zeros((max_faces, 6), dtype=np.float32),
                "applicable": False,
                "source_faces": 0,
            }
        result["av_context"] = best
    return result


@dataclass
class PackValidationResult:
    root: str
    total: int
    bytes_on_disk: int
    by_split: Dict[str, int]
    by_label: Dict[str, int]
    by_split_label: Dict[str, Dict[str, int]]
    by_dataset: Dict[str, int]
    by_label_source: Dict[str, Dict[str, int]]
    metadata_by_label: Dict[str, Dict[str, Dict[str, int]]]
    video_counts_by_label: Dict[str, int]
    manifest_sha256: str
    content_hashes: Set[str]
    sample_ids: Set[str]
    archives: int
    warnings: List[str]

    def public_dict(self) -> Dict[str, Any]:
        value = dict(self.__dict__)
        value["content_hashes"] = len(self.content_hashes)
        value["sample_ids"] = len(self.sample_ids)
        return value


def _pack_size(root: Path) -> int:
    return sum(path.stat().st_size for path in root.rglob("*") if path.is_file())


def validate_pack(
    root: str | Path,
    *,
    expected_split_counts: Optional[Mapping[str, int]] = None,
    require_balanced_splits: Sequence[str] = (),
    max_bytes: Optional[int] = None,
    verify_members: bool = True,
    verify_npz: bool = False,
    required_views: Sequence[str] = (),
) -> PackValidationResult:
    pack_root = Path(root)
    for name in REQUIRED_PACK_FILES:
        if not (pack_root / name).is_file():
            raise PackError(f"pack is incomplete; missing {pack_root / name}")
    manifest_path = pack_root / "manifest.jsonl"
    with (pack_root / "pack.json").open("r", encoding="utf-8") as handle:
        metadata = json.load(handle)
    if int(metadata.get("format_version", -1)) != PACK_FORMAT_VERSION:
        raise PackError(
            f"unsupported pack format_version={metadata.get('format_version')}; expected={PACK_FORMAT_VERSION}"
        )

    totals = Counter()
    by_split = Counter()
    by_label = Counter()
    by_dataset = Counter()
    by_label_source: Dict[str, Counter] = defaultdict(Counter)
    metadata_by_label: Dict[str, Dict[str, Counter]] = defaultdict(lambda: defaultdict(Counter))
    video_ids_by_label: Dict[str, Set[str]] = defaultdict(set)
    by_split_label: Dict[str, Counter] = defaultdict(Counter)
    sample_ids: Set[str] = set()
    content_hashes: Set[str] = set()
    requested: Dict[str, Dict[str, Dict[str, Any]]] = defaultdict(dict)
    row_count = 0
    for line_no, row in iter_jsonl(manifest_path):
        row_count += 1
        sample_id = str(row["sample_id"])
        if sample_id in sample_ids:
            raise PackError(f"duplicate sample_id in {manifest_path}:{line_no}: {sample_id}")
        sample_ids.add(sample_id)
        content_hash = str(row.get("content_sha256", ""))
        if content_hash:
            if content_hash in content_hashes:
                raise PackError(f"duplicate content_sha256 in {manifest_path}:{line_no}: {content_hash}")
            content_hashes.add(content_hash)
        if "archive_path" not in row or "member_path" not in row:
            raise PackError(f"pack row is not tar-backed in {manifest_path}:{line_no}")
        archive_path = row["archive_path"]
        member_path = row["member_path"]
        if member_path in requested[archive_path]:
            raise PackError(f"duplicate archive/member pair: {archive_path}:{member_path}")
        requested[archive_path][member_path] = row
        split = row["split"]
        label = str(row["label"])
        totals["total"] += 1
        by_split[split] += 1
        by_label[label] += 1
        by_split_label[split][label] += 1
        by_dataset[row["dataset"]] += 1
        source_name = str(row.get("source_repo") or row.get("source_pack") or row.get("source") or row["dataset"])
        by_label_source[label][source_name] += 1
        for field in ("resolution", "frame_count", "compression", "quality", "face_crop_size"):
            if row.get(field) is not None:
                metadata_by_label[label][field][str(row[field])] += 1
        if row.get("video_id") is not None:
            video_ids_by_label[label].add(str(row["video_id"]))

    if row_count == 0:
        raise PackError(f"manifest is empty: {manifest_path}")
    disk_bytes = _pack_size(pack_root)
    if max_bytes is not None and disk_bytes > int(max_bytes):
        raise PackError(f"pack exceeds size limit: actual={disk_bytes} limit={int(max_bytes)}")

    if verify_members:
        for archive_rel, members in requested.items():
            archive_path = resolve_inside(pack_root, archive_rel, "archive_path")
            if not archive_path.is_file():
                raise MissingArchiveError(f"manifest references missing archive: {archive_path}")
            try:
                with tarfile.open(archive_path, "r:*") as archive:
                    actual: Dict[str, tarfile.TarInfo] = {
                        info.name: info for info in archive if info.isfile()
                    }
                    missing = sorted(set(members) - set(actual))
                    if missing:
                        preview = ", ".join(missing[:5])
                        raise MissingMemberError(
                            f"{archive_rel} is missing {len(missing)} manifest members; first: {preview}"
                        )
                    if verify_npz:
                        for member_name, row in members.items():
                            extracted = archive.extractfile(actual[member_name])
                            if extracted is None:
                                raise MissingMemberError(f"could not read {archive_rel}:{member_name}")
                            payload = extracted.read()
                            decode_npz_views(
                                payload,
                                required_views,
                                identity=f"{archive_rel}:{member_name}",
                            )
                            expected_hash = row.get("content_sha256")
                            if expected_hash and sha256_bytes(payload) != expected_hash:
                                raise PackError(
                                    f"content hash mismatch: {archive_rel}:{member_name}"
                                )
            except tarfile.TarError as exc:
                raise PackError(f"corrupt tar archive {archive_path}: {exc}") from exc

    digest = manifest_digest(manifest_path)
    expected_digest = metadata.get("manifest_sha256")
    if expected_digest and expected_digest != digest:
        raise PackError(
            f"manifest fingerprint mismatch: pack.json={expected_digest} actual={digest}"
        )
    expected_total = metadata.get("counts", {}).get("total")
    if expected_total is not None and int(expected_total) != row_count:
        raise PackError(f"pack.json total={expected_total}, manifest total={row_count}")
    expected_by_split = metadata.get("counts", {}).get("by_split", {})
    for split, expected in expected_by_split.items():
        if int(expected) != int(by_split[split]):
            raise PackError(
                f"pack.json split count mismatch for {split}: expected={expected} actual={by_split[split]}"
            )
    if expected_split_counts:
        for split, expected in expected_split_counts.items():
            if int(by_split[split]) != int(expected):
                raise PackError(
                    f"split {split!r} count mismatch: expected={expected} actual={by_split[split]}"
                )
    for split in require_balanced_splits:
        real = int(by_split_label[split]["0"])
        fake = int(by_split_label[split]["1"])
        if real != fake or real == 0:
            raise PackError(f"split {split!r} is not exact 50/50: real={real} fake={fake}")

    return PackValidationResult(
        root=str(pack_root.resolve()),
        total=row_count,
        bytes_on_disk=disk_bytes,
        by_split=dict(sorted(by_split.items())),
        by_label=dict(sorted(by_label.items())),
        by_split_label={k: dict(sorted(v.items())) for k, v in sorted(by_split_label.items())},
        by_dataset=dict(sorted(by_dataset.items())),
        by_label_source={label: dict(sorted(values.items())) for label, values in sorted(by_label_source.items())},
        metadata_by_label={
            label: {field: dict(sorted(values.items())) for field, values in sorted(fields.items())}
            for label, fields in sorted(metadata_by_label.items())
        },
        video_counts_by_label={label: len(values) for label, values in sorted(video_ids_by_label.items())},
        manifest_sha256=digest,
        content_hashes=content_hashes,
        sample_ids=sample_ids,
        archives=len(requested),
        warnings=[],
    )


def validate_training_bundle(
    correction_root: str | Path,
    balanced_root: str | Path,
    holdout_root: str | Path,
    *,
    correction_max_bytes: int = 120 * GIB,
    expected_val_records: Optional[int] = None,
    expected_test_records: Optional[int] = None,
    verify_members: bool = True,
    verify_npz: bool = False,
    required_views: Sequence[str] = ("micro", "mid", "long", "extra_long"),
) -> Dict[str, Any]:
    correction = validate_pack(
        correction_root,
        max_bytes=correction_max_bytes,
        require_balanced_splits=("train",),
        verify_members=verify_members,
        verify_npz=verify_npz,
        required_views=required_views,
    )
    balanced = validate_pack(
        balanced_root,
        require_balanced_splits=("train",),
        verify_members=verify_members,
        verify_npz=verify_npz,
        required_views=required_views,
    )
    holdout = validate_pack(
        holdout_root,
        expected_split_counts={
            **({"val": int(expected_val_records)} if expected_val_records is not None else {}),
            **({"test": int(expected_test_records)} if expected_test_records is not None else {}),
        } or None,
        require_balanced_splits=("val", "test"),
        verify_members=verify_members,
        verify_npz=verify_npz,
        required_views=required_views,
    )
    holdout_hashes = holdout.content_hashes
    holdout_ids = holdout.sample_ids
    for name, train in (("real_correction", correction), ("balanced_core", balanced)):
        duplicate_hashes = holdout_hashes.intersection(train.content_hashes)
        duplicate_ids = holdout_ids.intersection(train.sample_ids)
        if duplicate_hashes or duplicate_ids:
            raise PackError(
                f"holdout leakage into {name}: content_hashes={len(duplicate_hashes)} sample_ids={len(duplicate_ids)}"
            )
    # The correction pack intentionally draws its fake half from balanced_core;
    # this overlap is part of the requested schedule, not leakage.  Only the
    # fixed holdout must be disjoint from every training pack.
    overlap_hashes = correction.content_hashes.intersection(balanced.content_hashes)
    overlap_ids = correction.sample_ids.intersection(balanced.sample_ids)

    real_sources: Dict[str, Counter] = defaultdict(Counter)
    for _, row in iter_jsonl(Path(holdout_root) / "manifest.jsonl"):
        if row["label"] == 0:
            source_name = str(row.get("source_repo") or row.get("source_pack") or row["dataset"])
            real_sources[row["split"]][source_name] += 1
    with (Path(correction_root) / "pack.json").open("r", encoding="utf-8") as handle:
        correction_sources = set(json.load(handle).get("source_repos", []))
    with (Path(balanced_root) / "pack.json").open("r", encoding="utf-8") as handle:
        balanced_sources = set(json.load(handle).get("source_repos", []))
    celeb_sources = correction_sources - balanced_sources
    if not balanced_sources or not celeb_sources:
        raise PackError(
            "pack source metadata cannot distinguish CelebV-HQ from balanced data: "
            f"correction={sorted(correction_sources)} balanced={sorted(balanced_sources)}"
        )
    for split in ("val", "test"):
        source_names = {name for name, count in real_sources[split].items() if count > 0}
        has_balanced = bool(source_names.intersection(balanced_sources))
        has_celeb = bool(source_names.intersection(celeb_sources))
        balanced_real = sum(real_sources[split][name] for name in balanced_sources)
        celeb_real = sum(real_sources[split][name] for name in celeb_sources)
        if not has_balanced or not has_celeb or balanced_real != celeb_real:
            raise PackError(
                f"holdout {split} real examples must be equally split between CelebV-HQ and balanced data; "
                f"celeb={celeb_real} balanced={balanced_real} sources={dict(real_sources[split])}"
            )
    warnings: List[str] = []
    correction_real_sources = set(correction.by_label_source.get("0", {}))
    correction_fake_sources = set(correction.by_label_source.get("1", {}))
    if (
        len(correction_real_sources) == 1
        and len(correction_fake_sources) == 1
        and correction_real_sources.isdisjoint(correction_fake_sources)
    ):
        warnings.append(
            "HIGH RISK: correction real and fake labels come from disjoint single sources; "
            "the model can learn dataset style instead of manipulation evidence"
        )
    balanced_real_sources = correction_real_sources.intersection(balanced_sources)
    if not balanced_real_sources:
        warnings.append(
            "HIGH RISK: real_correction_pack contains no balanced-repo real samples; add matched real controls if available"
        )
    correction.warnings.extend(warnings)
    return {
        "validated_at": utc_now(),
        "real_correction_pack": correction.public_dict(),
        "balanced_core_pack": balanced.public_dict(),
        "mixed_holdout_pack": holdout.public_dict(),
        "holdout_real_sources": {k: dict(v) for k, v in real_sources.items()},
        "expected_training_overlap": {
            "content_hashes": len(overlap_hashes),
            "sample_ids": len(overlap_ids),
        },
        "warnings": warnings,
    }


class WallTimeBudget:
    def __init__(self, max_seconds: float = 0.0, reserve_seconds: float = 0.0) -> None:
        self.started = time.monotonic()
        self.max_seconds = max(0.0, float(max_seconds))
        self.reserve_seconds = max(0.0, float(reserve_seconds))

    @property
    def elapsed(self) -> float:
        return time.monotonic() - self.started

    @property
    def remaining(self) -> float:
        if self.max_seconds <= 0:
            return float("inf")
        return max(0.0, self.max_seconds - self.elapsed)

    def should_stop(self) -> bool:
        return self.max_seconds > 0 and self.remaining <= self.reserve_seconds


def bounded_epoch_range(start_epoch: int, total_epochs: int, epochs_this_run: Optional[int]) -> range:
    """Return only unfinished epochs, additionally bounded for this invocation."""
    start = max(0, int(start_epoch))
    total = max(0, int(total_epochs))
    if start >= total:
        return range(total, total)
    end = total
    if epochs_this_run is not None:
        if int(epochs_this_run) < 1:
            raise ValueError("epochs_this_run must be >= 1")
        end = min(total, start + int(epochs_this_run))
    return range(start, end)


class PhaseJournal:
    """Atomic local journal with explicit started/completed/failed task states."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.data: Dict[str, Any] = {
            "schema_version": 1,
            "created_at": utc_now(),
            "updated_at": utc_now(),
            "tasks": {},
            "sessions": [],
        }
        if self.path.exists():
            with self.path.open("r", encoding="utf-8") as handle:
                loaded = json.load(handle)
            if int(loaded.get("schema_version", -1)) != 1:
                raise PackError(f"unsupported phase journal schema: {self.path}")
            self.data = loaded

    def is_complete(self, task: str) -> bool:
        return self.data.get("tasks", {}).get(task, {}).get("status") in {"completed", "skipped"}

    def update(self, task: str, status: str, **details: Any) -> None:
        if status not in {"started", "completed", "failed", "skipped"}:
            raise ValueError(f"invalid journal status: {status}")
        current = dict(self.data.setdefault("tasks", {}).get(task, {}))
        if current.get("status") == "completed" and status != "completed":
            raise PackError(f"refusing to regress completed journal task: {task}")
        attempts = int(current.get("attempts", 0)) + (1 if status == "started" else 0)
        current.update(details)
        current.update({"status": status, "attempts": attempts, "updated_at": utc_now()})
        self.data["tasks"][task] = current
        self.data["updated_at"] = utc_now()
        atomic_write_json(self.path, self.data)

    def add_session(self, session: Mapping[str, Any]) -> None:
        self.data.setdefault("sessions", []).append(dict(session))
        self.data["updated_at"] = utc_now()
        atomic_write_json(self.path, self.data)

    def force_reset(self, task: str, reason: str = "explicit --force-phase") -> None:
        current = self.data.setdefault("tasks", {}).pop(task, None)
        if current is not None:
            self.data.setdefault("forced_history", []).append(
                {"task": task, "previous": current, "reason": reason, "reset_at": utc_now()}
            )
        self.data["updated_at"] = utc_now()
        atomic_write_json(self.path, self.data)
