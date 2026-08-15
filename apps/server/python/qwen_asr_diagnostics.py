from __future__ import annotations

import os
import subprocess
import threading
import time
from dataclasses import dataclass
from typing import Mapping

import numpy as np


DEFAULT_TARGET_SEGMENT_SECONDS = 150
DEFAULT_MIN_SEGMENT_SECONDS = 120
DEFAULT_MAX_SEGMENT_SECONDS = 180
MAX_ALLOWED_SEGMENT_SECONDS = 600
SILENCE_WINDOW_SECONDS = 0.05
SILENCE_HOP_SECONDS = 0.10


@dataclass(frozen=True)
class SegmentSettings:
    minimum: int
    target: int
    maximum: int

    @property
    def label(self) -> str:
        return f"min={self.minimum}s,target={self.target}s,max={self.maximum}s"


@dataclass(frozen=True)
class GpuSample:
    timestamp: float
    utilization: float
    memory_used_mib: float
    power_watts: float


@dataclass(frozen=True)
class GpuSummary:
    average_utilization: float
    maximum_utilization: float
    maximum_memory_used_mib: float
    average_power_watts: float
    maximum_power_watts: float


@dataclass(frozen=True)
class SegmentMetrics:
    index: int
    count: int
    audio_seconds: float
    preprocess_ms: float
    transfer_ms: float
    prompt_tokens: int
    generated_tokens: int
    generate_ms: float
    decode_ms: float
    total_ms: float
    peak_allocated_mib: float
    peak_reserved_mib: float
    gpu: GpuSummary | None


def load_segment_settings(environment: Mapping[str, str] | None = None) -> SegmentSettings:
    values = os.environ if environment is None else environment
    settings = SegmentSettings(
        minimum=_read_positive_integer(
            values,
            "QWEN_ASR_MIN_SEGMENT_SECONDS",
            DEFAULT_MIN_SEGMENT_SECONDS,
        ),
        target=_read_positive_integer(
            values,
            "QWEN_ASR_TARGET_SEGMENT_SECONDS",
            DEFAULT_TARGET_SEGMENT_SECONDS,
        ),
        maximum=_read_positive_integer(
            values,
            "QWEN_ASR_MAX_SEGMENT_SECONDS",
            DEFAULT_MAX_SEGMENT_SECONDS,
        ),
    )
    if not 0 < settings.minimum <= settings.target <= settings.maximum <= MAX_ALLOWED_SEGMENT_SECONDS:
        raise ValueError(
            "Qwen3-ASR 切段配置无效，必须满足 "
            "0 < min <= target <= max <= 600"
        )
    return settings


def profiling_enabled(environment: Mapping[str, str] | None = None) -> bool:
    values = os.environ if environment is None else environment
    raw = values.get("QWEN_ASR_PROFILE", "1").strip().lower()
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    raise ValueError("QWEN_ASR_PROFILE 只能使用 1/0、true/false、yes/no 或 on/off")


def split_audio(
    audio: np.ndarray,
    sample_rate: int,
    settings: SegmentSettings,
) -> list[np.ndarray]:
    maximum = settings.maximum * sample_rate
    chunks: list[np.ndarray] = []
    start = 0
    while audio.size - start > maximum:
        cut = _find_quiet_cut(audio, sample_rate, start, settings)
        chunks.append(np.ascontiguousarray(audio[start:cut]))
        start = cut
    if start < audio.size:
        chunks.append(np.ascontiguousarray(audio[start:]))
    return chunks


def format_audio_diagnostic(
    audio_seconds: float,
    sample_rate: int,
    chunk_seconds: list[float],
    settings: SegmentSettings,
    gpu_sampling: str,
) -> str:
    durations = ",".join(f"{duration:.3f}" for duration in chunk_seconds)
    return (
        "audio"
        f" | duration={audio_seconds:.3f}s"
        f" | sample_rate={sample_rate}Hz"
        f" | segments={len(chunk_seconds)}"
        f" | segment_durations=[{durations}]s"
        f" | {settings.label}"
        f" | gpu_sampling={gpu_sampling}"
    )


def format_segment_diagnostic(metrics: SegmentMetrics) -> str:
    generate_seconds = metrics.generate_ms / 1_000
    total_seconds = metrics.total_ms / 1_000
    tokens_per_second = (
        metrics.generated_tokens / generate_seconds
        if generate_seconds > 0
        else 0.0
    )
    realtime_speed = (
        metrics.audio_seconds / total_seconds
        if total_seconds > 0
        else 0.0
    )
    gpu = (
        "gpu=unavailable"
        if metrics.gpu is None
        else (
            f"gpu_util_avg={metrics.gpu.average_utilization:.1f}%"
            f",gpu_util_max={metrics.gpu.maximum_utilization:.1f}%"
            f",gpu_mem_max={metrics.gpu.maximum_memory_used_mib:.1f}MiB"
            f",power_avg={metrics.gpu.average_power_watts:.1f}W"
            f",power_max={metrics.gpu.maximum_power_watts:.1f}W"
        )
    )
    return (
        f"segment={metrics.index}/{metrics.count}"
        f" | audio={metrics.audio_seconds:.3f}s"
        f" | preprocess={metrics.preprocess_ms:.3f}ms"
        f" | transfer={metrics.transfer_ms:.3f}ms"
        f" | prompt_tokens={metrics.prompt_tokens}"
        f" | generated_tokens={metrics.generated_tokens}"
        f" | generate={metrics.generate_ms:.3f}ms"
        f" | decode={metrics.decode_ms:.3f}ms"
        f" | total={metrics.total_ms:.3f}ms"
        f" | tokens_per_second={tokens_per_second:.2f}"
        f" | realtime_speed={realtime_speed:.2f}x"
        f" | peak_allocated={metrics.peak_allocated_mib:.1f}MiB"
        f" | peak_reserved={metrics.peak_reserved_mib:.1f}MiB"
        f" | {gpu}"
    )


def format_summary_diagnostic(
    *,
    audio_seconds: float,
    elapsed_ms: float,
    preprocess_ms: float,
    transfer_ms: float,
    generate_ms: float,
    decode_ms: float,
    peak_allocated_mib: float,
    peak_reserved_mib: float,
) -> str:
    realtime_speed = audio_seconds / (elapsed_ms / 1_000) if elapsed_ms > 0 else 0.0
    return (
        "summary"
        f" | audio={audio_seconds:.3f}s"
        f" | elapsed={elapsed_ms:.3f}ms"
        f" | realtime_speed={realtime_speed:.2f}x"
        f" | preprocess_total={preprocess_ms:.3f}ms"
        f" | transfer_total={transfer_ms:.3f}ms"
        f" | generate_total={generate_ms:.3f}ms"
        f" | decode_total={decode_ms:.3f}ms"
        f" | peak_allocated={peak_allocated_mib:.1f}MiB"
        f" | peak_reserved={peak_reserved_mib:.1f}MiB"
    )


class NvidiaSmiSampler:
    def __init__(self, enabled: bool, interval_ms: int = 1_000) -> None:
        self.requested = enabled
        self.interval_ms = interval_ms
        self._process: subprocess.Popen[str] | None = None
        self._thread: threading.Thread | None = None
        self._samples: list[GpuSample] = []
        self._lock = threading.Lock()

    @property
    def status(self) -> str:
        if not self.requested:
            return "off"
        return "on" if self._process is not None else "unavailable"

    def start(self) -> None:
        if not self.requested or self._process is not None:
            return
        command = [
            "nvidia-smi",
            "--id=0",
            "--query-gpu=utilization.gpu,memory.used,power.draw",
            "--format=csv,noheader,nounits",
            "-lms",
            str(self.interval_ms),
        ]
        creation_flags = (
            subprocess.CREATE_NO_WINDOW
            if os.name == "nt" and hasattr(subprocess, "CREATE_NO_WINDOW")
            else 0
        )
        try:
            self._process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                encoding="utf-8",
                errors="replace",
                creationflags=creation_flags,
            )
        except (FileNotFoundError, OSError):
            self._process = None
            return
        self._thread = threading.Thread(target=self._read_samples, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        process = self._process
        self._process = None
        if process is not None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)
        thread = self._thread
        self._thread = None
        if thread is not None:
            thread.join(timeout=2)

    def summarize(self, started_at: float, finished_at: float) -> GpuSummary | None:
        with self._lock:
            samples = [
                sample
                for sample in self._samples
                if started_at <= sample.timestamp <= finished_at
            ]
        if not samples:
            return None
        return GpuSummary(
            average_utilization=sum(item.utilization for item in samples) / len(samples),
            maximum_utilization=max(item.utilization for item in samples),
            maximum_memory_used_mib=max(item.memory_used_mib for item in samples),
            average_power_watts=sum(item.power_watts for item in samples) / len(samples),
            maximum_power_watts=max(item.power_watts for item in samples),
        )

    def _read_samples(self) -> None:
        process = self._process
        if process is None or process.stdout is None:
            return
        for line in process.stdout:
            sample = _parse_gpu_sample(line, time.perf_counter())
            if sample is None:
                continue
            with self._lock:
                self._samples.append(sample)


def _find_quiet_cut(
    audio: np.ndarray,
    sample_rate: int,
    start: int,
    settings: SegmentSettings,
) -> int:
    target = start + settings.target * sample_rate
    search_start = start + settings.minimum * sample_rate
    search_end = min(start + settings.maximum * sample_rate, audio.size)
    window = max(1, int(SILENCE_WINDOW_SECONDS * sample_rate))
    hop = max(1, int(SILENCE_HOP_SECONDS * sample_rate))
    best_position = min(target, search_end)
    best_score = float("inf")

    for position in range(search_start, max(search_start + 1, search_end - window), hop):
        frame = audio[position : position + window]
        if frame.size == 0:
            continue
        score = float(np.mean(np.square(frame, dtype=np.float64)))
        distance_penalty = abs(position - target) / (sample_rate * 1_000_000)
        score += distance_penalty
        if score < best_score:
            best_score = score
            best_position = position + window // 2
    return max(start + 1, min(best_position, audio.size))


def _read_positive_integer(
    environment: Mapping[str, str],
    name: str,
    default: int,
) -> int:
    raw = environment.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = int(raw)
    except ValueError as error:
        raise ValueError(f"{name} 必须是正整数") from error
    if value <= 0:
        raise ValueError(f"{name} 必须是正整数")
    return value


def _parse_gpu_sample(line: str, timestamp: float) -> GpuSample | None:
    fields = [part.strip() for part in line.strip().split(",")]
    if len(fields) != 3:
        return None
    try:
        utilization, memory_used_mib, power_watts = (
            float(field) for field in fields
        )
    except ValueError:
        return None
    return GpuSample(
        timestamp=timestamp,
        utilization=utilization,
        memory_used_mib=memory_used_mib,
        power_watts=power_watts,
    )
