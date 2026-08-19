from __future__ import annotations

from dataclasses import dataclass, field
import math
from pathlib import Path
import subprocess
import tempfile
from typing import Any, Iterable
import wave

import cv2
import numpy as np


@dataclass(frozen=True)
class GateThresholds:
    minimum_face_coverage: float = 0.65
    minimum_speech_ratio: float = 0.15
    minimum_mouth_motion: float = 0.008
    minimum_snr_db: float = 4.0
    minimum_usable_seconds: float = 1.0


@dataclass
class AVMediaContext:
    mouth_tracks: np.ndarray
    waveform: np.ndarray
    track_mask: np.ndarray
    quality: np.ndarray
    applicable: bool
    gate_reasons: list[str] = field(default_factory=list)
    analyzed_seconds: float = 0.0
    language: str = "unknown"
    frame_rate: float = 25.0
    audio_present: bool = False

    def as_tensor_inputs(self, torch_module: Any, device: Any) -> dict[str, Any]:
        torch = torch_module
        return {
            "mouth_tracks": torch.from_numpy(self.mouth_tracks).unsqueeze(0).to(device=device, dtype=torch.float32),
            "waveform": torch.from_numpy(self.waveform).unsqueeze(0).to(device=device, dtype=torch.float32),
            "track_mask": torch.from_numpy(self.track_mask).unsqueeze(0).to(device=device, dtype=torch.float32),
            "quality": torch.from_numpy(self.quality).unsqueeze(0).to(device=device, dtype=torch.float32),
        }

    def public_quality(self) -> list[dict[str, float]]:
        return [
            {
                "faceCoverage": round(float(row[0]), 4),
                "speechRatio": round(float(row[1]), 4),
                "mouthMotion": round(float(row[2]), 5),
                "snrDb": round(float(row[3]) * 40.0 - 10.0, 2),
                "occlusionRatio": round(float(row[4]), 4),
                "usableSeconds": round(float(row[5]) * 8.0, 2),
            }
            for row in self.quality
        ]


@dataclass
class FaceObservation:
    box: np.ndarray
    lower_face: np.ndarray
    score: float


@dataclass
class FaceTrack:
    track_id: int
    last_box: np.ndarray
    missed: int = 0
    observations: dict[int, FaceObservation] = field(default_factory=dict)


def intersection_over_union(first: np.ndarray, second: np.ndarray) -> float:
    ax1, ay1, aw, ah = [float(value) for value in first[:4]]
    bx1, by1, bw, bh = [float(value) for value in second[:4]]
    ax2, ay2 = ax1 + aw, ay1 + ah
    bx2, by2 = bx1 + bw, by1 + bh
    width = max(0.0, min(ax2, bx2) - max(ax1, bx1))
    height = max(0.0, min(ay2, by2) - max(ay1, by1))
    intersection = width * height
    union = max(1.0, aw * ah + bw * bh - intersection)
    return intersection / union


class YuNetFaceTracker:
    """YuNet detection plus bounded greedy tracking for at most four faces."""

    def __init__(
        self,
        model_path: str | Path,
        *,
        mouth_size: int = 112,
        max_faces: int = 4,
        score_threshold: float = 0.82,
        nms_threshold: float = 0.3,
        top_k: int = 500,
    ) -> None:
        path = Path(model_path).expanduser().resolve()
        if not path.is_file():
            raise FileNotFoundError(
                f"YuNet model is required and was not found at {path}. "
                "Set ORISLOP_YUNET_MODEL_PATH to a commercially approved YuNet ONNX artifact."
            )
        self.mouth_size = int(mouth_size)
        self.max_faces = max(1, min(4, int(max_faces)))
        creator = getattr(cv2, "FaceDetectorYN_create", None)
        if creator is None and hasattr(cv2, "FaceDetectorYN"):
            creator = cv2.FaceDetectorYN.create
        if creator is None:
            raise RuntimeError("This OpenCV build does not provide FaceDetectorYN")
        self.detector = creator(str(path), "", (320, 320), score_threshold, nms_threshold, top_k)

    def detect(self, frame: np.ndarray) -> list[FaceObservation]:
        height, width = frame.shape[:2]
        self.detector.setInputSize((width, height))
        _, detections = self.detector.detect(frame)
        if detections is None:
            return []
        observations: list[FaceObservation] = []
        for detection in detections:
            box = np.asarray(detection[:4], dtype=np.float32)
            score = float(detection[-1])
            crop = lower_face_crop(frame, box, self.mouth_size)
            if crop is None:
                continue
            observations.append(FaceObservation(box=box, lower_face=crop, score=score))
        observations.sort(key=lambda item: float(item.box[2] * item.box[3]) * item.score, reverse=True)
        return observations[: self.max_faces]

    def track(self, frames: Iterable[np.ndarray]) -> list[FaceTrack]:
        tracks: list[FaceTrack] = []
        next_id = 0
        for frame_index, frame in enumerate(frames):
            detections = self.detect(frame)
            unmatched_tracks = set(range(len(tracks)))
            unmatched_detections = set(range(len(detections)))
            matches: list[tuple[int, int]] = []
            candidates = sorted(
                (
                    (intersection_over_union(track.last_box, detection.box), track_index, detection_index)
                    for track_index, track in enumerate(tracks)
                    for detection_index, detection in enumerate(detections)
                ),
                reverse=True,
            )
            for overlap, track_index, detection_index in candidates:
                if overlap < 0.25 or track_index not in unmatched_tracks or detection_index not in unmatched_detections:
                    continue
                matches.append((track_index, detection_index))
                unmatched_tracks.remove(track_index)
                unmatched_detections.remove(detection_index)
            for track_index, detection_index in matches:
                observation = detections[detection_index]
                track = tracks[track_index]
                track.last_box = observation.box
                track.missed = 0
                track.observations[frame_index] = observation
            for track_index in unmatched_tracks:
                tracks[track_index].missed += 1
            for detection_index in unmatched_detections:
                observation = detections[detection_index]
                tracks.append(FaceTrack(next_id, observation.box, observations={frame_index: observation}))
                next_id += 1
            tracks = [track for track in tracks if track.missed <= 8]
            if len(tracks) > self.max_faces * 2:
                tracks.sort(key=lambda track: len(track.observations), reverse=True)
                tracks = tracks[: self.max_faces * 2]
        tracks.sort(key=lambda track: len(track.observations), reverse=True)
        return tracks[: self.max_faces]


def lower_face_crop(frame: np.ndarray, box: np.ndarray, output_size: int) -> np.ndarray | None:
    height, width = frame.shape[:2]
    x, y, box_width, box_height = [float(value) for value in box]
    if box_width < 12 or box_height < 12:
        return None
    center_x = x + box_width * 0.5
    center_y = y + box_height * 0.68
    side = max(box_width * 0.84, box_height * 0.58)
    x1 = max(0, int(round(center_x - side * 0.5)))
    x2 = min(width, int(round(center_x + side * 0.5)))
    y1 = max(0, int(round(center_y - side * 0.5)))
    y2 = min(height, int(round(center_y + side * 0.5)))
    if x2 - x1 < 8 or y2 - y1 < 8:
        return None
    crop = frame[y1:y2, x1:x2]
    crop = cv2.resize(crop, (output_size, output_size), interpolation=cv2.INTER_AREA)
    return cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)


class AVPreprocessor:
    def __init__(
        self,
        tracker: YuNetFaceTracker,
        *,
        sample_rate: int = 16_000,
        target_fps: int = 25,
        maximum_seconds: int = 8,
        thresholds: GateThresholds | None = None,
    ) -> None:
        self.tracker = tracker
        self.sample_rate = int(sample_rate)
        self.target_fps = int(target_fps)
        self.maximum_seconds = int(maximum_seconds)
        self.thresholds = thresholds or GateThresholds()

    def process(
        self,
        video_path: str | Path,
        *,
        seconds: int = 2,
        language: str = "unknown",
    ) -> AVMediaContext:
        duration = max(1, min(self.maximum_seconds, int(seconds)))
        frames, measured_fps = read_sampled_frames(video_path, self.target_fps, duration)
        frame_count = len(frames)
        if frame_count == 0:
            return empty_context(
                self.tracker.max_faces,
                duration,
                self.target_fps,
                "video_decode_failed",
                language,
                mouth_size=self.tracker.mouth_size,
                sample_rate=self.sample_rate,
            )
        waveform, audio_present = extract_waveform(video_path, self.sample_rate, duration)
        expected_samples = duration * self.sample_rate
        waveform = pad_or_trim(waveform, expected_samples)
        tracks = self.tracker.track(frames)
        mouth_tracks = np.zeros(
            (self.tracker.max_faces, 3, frame_count, self.tracker.mouth_size, self.tracker.mouth_size),
            dtype=np.float32,
        )
        track_mask = np.zeros((self.tracker.max_faces, frame_count), dtype=np.float32)
        speech_ratio, snr_db = audio_quality(waveform, self.sample_rate, self.target_fps)
        quality = np.zeros((self.tracker.max_faces, 6), dtype=np.float32)
        for track_index, track in enumerate(tracks):
            for frame_index, observation in track.observations.items():
                if frame_index >= frame_count:
                    continue
                mouth_tracks[track_index, :, frame_index] = observation.lower_face.transpose(2, 0, 1) / 255.0
                track_mask[track_index, frame_index] = 1.0
            face_coverage = float(track_mask[track_index].mean())
            motion = mouth_motion_score(mouth_tracks[track_index], track_mask[track_index])
            usable_seconds = float(track_mask[track_index].sum() / max(1.0, measured_fps))
            quality[track_index] = np.asarray(
                [
                    face_coverage,
                    speech_ratio,
                    motion,
                    np.clip((snr_db + 10.0) / 40.0, 0.0, 1.0),
                    1.0 - face_coverage,
                    np.clip(usable_seconds / self.maximum_seconds, 0.0, 1.0),
                ],
                dtype=np.float32,
            )
        reasons = applicability_reasons(quality, audio_present, self.thresholds)
        return AVMediaContext(
            mouth_tracks=mouth_tracks,
            waveform=waveform.astype(np.float32),
            track_mask=track_mask,
            quality=quality,
            applicable=not reasons,
            gate_reasons=reasons,
            analyzed_seconds=min(duration, frame_count / max(1.0, measured_fps)),
            language=language.strip().lower() or "unknown",
            frame_rate=float(measured_fps),
            audio_present=audio_present,
        )


def read_sampled_frames(video_path: str | Path, target_fps: int, maximum_seconds: int) -> tuple[list[np.ndarray], float]:
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        return [], float(target_fps)
    source_fps = float(capture.get(cv2.CAP_PROP_FPS) or target_fps)
    if not math.isfinite(source_fps) or source_fps <= 0:
        source_fps = float(target_fps)
    stride = max(1, int(round(source_fps / max(1, target_fps))))
    maximum_source_frames = int(math.ceil(source_fps * maximum_seconds))
    frames: list[np.ndarray] = []
    source_index = 0
    try:
        while source_index < maximum_source_frames:
            ok, frame = capture.read()
            if not ok:
                break
            if source_index % stride == 0:
                frames.append(frame)
            source_index += 1
    finally:
        capture.release()
    measured_fps = source_fps / stride
    return frames[: target_fps * maximum_seconds], measured_fps


def extract_waveform(video_path: str | Path, sample_rate: int, maximum_seconds: int) -> tuple[np.ndarray, bool]:
    with tempfile.TemporaryDirectory(prefix="orislop-av-audio-") as temporary:
        output_path = Path(temporary) / "audio.wav"
        command = [
            "ffmpeg", "-nostdin", "-loglevel", "error", "-y", "-i", str(video_path),
            "-t", str(maximum_seconds), "-vn", "-ac", "1", "-ar", str(sample_rate),
            "-c:a", "pcm_s16le", str(output_path),
        ]
        try:
            subprocess.run(command, check=True, capture_output=True, timeout=max(15, maximum_seconds * 4))
            with wave.open(str(output_path), "rb") as handle:
                audio = np.frombuffer(handle.readframes(handle.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
            return audio, bool(audio.size and float(np.max(np.abs(audio))) > 1e-4)
        except (FileNotFoundError, subprocess.SubprocessError, wave.Error, OSError):
            return np.zeros(maximum_seconds * sample_rate, dtype=np.float32), False


def pad_or_trim(array: np.ndarray, length: int) -> np.ndarray:
    if array.size >= length:
        return array[:length]
    return np.pad(array, (0, length - array.size))


def audio_quality(waveform: np.ndarray, sample_rate: int, target_fps: int) -> tuple[float, float]:
    frame_samples = max(1, sample_rate // max(1, target_fps))
    usable = waveform[: waveform.size - waveform.size % frame_samples]
    if usable.size == 0:
        return 0.0, -10.0
    rms = np.sqrt(np.mean(usable.reshape(-1, frame_samples) ** 2, axis=1) + 1e-10)
    noise = float(np.percentile(rms, 20)) + 1e-6
    signal = float(np.percentile(rms, 80)) + 1e-6
    threshold = max(noise * 2.5, 0.012)
    speech_ratio = float(np.mean(rms >= threshold))
    snr_db = float(np.clip(20.0 * math.log10(signal / noise), -10.0, 30.0))
    return speech_ratio, snr_db


def mouth_motion_score(track: np.ndarray, mask: np.ndarray) -> float:
    valid_pairs = (mask[1:] > 0) & (mask[:-1] > 0)
    if not np.any(valid_pairs):
        return 0.0
    gray = track.mean(axis=0)
    differences = np.mean(np.abs(gray[1:] - gray[:-1]), axis=(1, 2))
    return float(np.clip(np.mean(differences[valid_pairs]), 0.0, 1.0))


def applicability_reasons(quality: np.ndarray, audio_present: bool, thresholds: GateThresholds) -> list[str]:
    if not audio_present:
        return ["audio_missing"]
    if quality.size == 0:
        return ["no_visible_face"]
    best = quality[int(np.argmax(quality[:, 0] * np.maximum(quality[:, 2], 1e-6)))]
    reasons: list[str] = []
    if float(best[0]) < thresholds.minimum_face_coverage:
        reasons.append("insufficient_face_coverage")
    if float(best[1]) < thresholds.minimum_speech_ratio:
        reasons.append("insufficient_visible_speech")
    if float(best[2]) < thresholds.minimum_mouth_motion:
        reasons.append("insufficient_mouth_motion")
    if float(best[3]) * 40.0 - 10.0 < thresholds.minimum_snr_db:
        reasons.append("audio_quality_too_low")
    if float(best[5]) * 8.0 < thresholds.minimum_usable_seconds:
        reasons.append("insufficient_usable_duration")
    return reasons


def empty_context(
    max_faces: int,
    seconds: int,
    fps: int,
    reason: str,
    language: str,
    *,
    mouth_size: int = 112,
    sample_rate: int = 16_000,
) -> AVMediaContext:
    frame_count = seconds * fps
    return AVMediaContext(
        mouth_tracks=np.zeros((max_faces, 3, frame_count, mouth_size, mouth_size), dtype=np.float32),
        waveform=np.zeros(seconds * sample_rate, dtype=np.float32),
        track_mask=np.zeros((max_faces, frame_count), dtype=np.float32),
        quality=np.zeros((max_faces, 6), dtype=np.float32),
        applicable=False,
        gate_reasons=[reason],
        analyzed_seconds=0.0,
        language=language,
        frame_rate=float(fps),
        audio_present=False,
    )
