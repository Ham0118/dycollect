from __future__ import annotations

import argparse
import json
import os
import platform
import sys
import time
import traceback
from pathlib import Path
from typing import Any

import numpy as np
import soundfile as sf
import torch
from transformers import AutoModelForMultimodalLM, AutoProcessor

from qwen_asr_diagnostics import (
    NvidiaSmiSampler,
    SegmentMetrics,
    SegmentSettings,
    format_audio_diagnostic,
    format_segment_diagnostic,
    format_summary_diagnostic,
    load_segment_settings,
    profiling_enabled,
    split_audio,
)


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), flush=True)


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def diagnostic(message: str) -> None:
    log(f"Qwen3-ASR diagnostic {message}")


def load_audio(path: Path) -> tuple[np.ndarray, int]:
    audio, sample_rate = sf.read(path, dtype="float32", always_2d=False)
    if audio.ndim == 2:
        audio = audio.mean(axis=1)
    if audio.ndim != 1 or audio.size == 0:
        raise ValueError("音频文件为空或声道格式无效")
    if sample_rate != 16_000:
        raise ValueError(f"音频采样率必须为 16000 Hz，实际为 {sample_rate} Hz")
    return np.ascontiguousarray(audio), sample_rate


def normalize_segments(values: list[str]) -> str:
    paragraphs: list[str] = []
    for value in values:
        text = " ".join(part.strip() for part in value.splitlines() if part.strip()).strip()
        if text and (not paragraphs or text != paragraphs[-1]):
            paragraphs.append(text)
    return "\n\n".join(paragraphs)


def available_devices() -> list[str]:
    devices = ["cpu"]
    if torch.cuda.is_available():
        devices.insert(0, "cuda")
    mps = getattr(torch.backends, "mps", None)
    if mps is not None and mps.is_available():
        devices.insert(0, "mps")
    return devices


def resolve_device(requested: str) -> str:
    devices = available_devices()
    if requested == "auto":
        return next(item for item in ["cuda", "mps", "cpu"] if item in devices)
    if requested not in devices:
        raise RuntimeError(
            f"当前 PyTorch 运行环境不支持 {requested.upper()}，可用设备：{', '.join(devices)}"
        )
    return requested


def synchronize(device: str) -> None:
    if device == "cuda":
        torch.cuda.synchronize()
    elif device == "mps":
        torch.mps.synchronize()


def reset_peak_memory(device: str) -> None:
    if device == "cuda":
        torch.cuda.reset_peak_memory_stats()


def peak_memory(device: str) -> tuple[float, float]:
    if device != "cuda":
        return 0.0, 0.0
    return (
        torch.cuda.max_memory_allocated() / 1024 / 1024,
        torch.cuda.max_memory_reserved() / 1024 / 1024,
    )


def current_allocated_memory(device: str) -> float:
    return torch.cuda.memory_allocated() / 1024 / 1024 if device == "cuda" else 0.0


def device_name(device: str) -> str:
    if device == "cuda":
        return torch.cuda.get_device_name(0)
    if device == "mps":
        return "Apple Metal Performance Shaders"
    return platform.processor() or platform.machine() or "CPU"


class QwenAsr:
    def __init__(
        self,
        model_path: Path,
        segment_settings: SegmentSettings,
        enable_profiling: bool,
        requested_device: str,
    ) -> None:
        self.device = resolve_device(requested_device)
        self.dtype = torch.float32 if self.device == "cpu" else torch.float16
        if self.device == "cuda":
            torch.backends.cuda.matmul.allow_tf32 = True
            torch.backends.cudnn.allow_tf32 = True
        self.segment_settings = segment_settings
        self.enable_profiling = enable_profiling and self.device == "cuda"
        self.processor = AutoProcessor.from_pretrained(model_path, local_files_only=True)
        self.model = AutoModelForMultimodalLM.from_pretrained(
            model_path,
            dtype=self.dtype,
            attn_implementation="sdpa",
            local_files_only=True,
            low_cpu_mem_usage=True,
        ).to(self.device).eval()

    def transcribe(self, audio_path: Path, language: str = "zh") -> dict[str, Any]:
        started = time.perf_counter()
        audio, sample_rate = load_audio(audio_path)
        chunks = split_audio(audio, sample_rate, self.segment_settings)
        audio_seconds = audio.size / sample_rate
        chunk_seconds = [chunk.size / sample_rate for chunk in chunks]
        texts: list[str] = []
        total_preprocess_ms = 0.0
        total_transfer_ms = 0.0
        total_generate_ms = 0.0
        total_decode_ms = 0.0
        overall_peak_allocated_mib = 0.0
        overall_peak_reserved_mib = 0.0
        sampler = NvidiaSmiSampler(self.enable_profiling)
        sampler.start()
        diagnostic(
            format_audio_diagnostic(
                audio_seconds,
                sample_rate,
                chunk_seconds,
                self.segment_settings,
                sampler.status,
            )
        )

        try:
            for index, chunk in enumerate(chunks, start=1):
                segment_started = time.perf_counter()
                reset_peak_memory(self.device)

                preprocess_started = time.perf_counter()
                cpu_inputs = self.processor.apply_transcription_request(
                    audio=chunk,
                    language=language,
                    processor_kwargs={"sampling_rate": sample_rate},
                )
                preprocess_ms = (time.perf_counter() - preprocess_started) * 1_000

                synchronize(self.device)
                transfer_started = time.perf_counter()
                inputs = cpu_inputs.to(self.device, self.dtype)
                synchronize(self.device)
                transfer_ms = (time.perf_counter() - transfer_started) * 1_000
                prompt_length = int(inputs["input_ids"].shape[1])

                synchronize(self.device)
                generate_started = time.perf_counter()
                with torch.inference_mode():
                    output_ids = self.model.generate(
                        **inputs,
                        max_new_tokens=2_048,
                        do_sample=False,
                        use_cache=True,
                    )
                synchronize(self.device)
                generate_ms = (time.perf_counter() - generate_started) * 1_000

                generated_ids = output_ids[:, prompt_length:]
                generated_tokens = int(generated_ids.shape[1])
                decode_started = time.perf_counter()
                text = self.processor.decode(
                    generated_ids,
                    return_format="transcription_only",
                )[0]
                decode_ms = (time.perf_counter() - decode_started) * 1_000
                texts.append(str(text))

                segment_finished = time.perf_counter()
                peak_allocated_mib, peak_reserved_mib = peak_memory(self.device)
                total_preprocess_ms += preprocess_ms
                total_transfer_ms += transfer_ms
                total_generate_ms += generate_ms
                total_decode_ms += decode_ms
                overall_peak_allocated_mib = max(
                    overall_peak_allocated_mib,
                    peak_allocated_mib,
                )
                overall_peak_reserved_mib = max(
                    overall_peak_reserved_mib,
                    peak_reserved_mib,
                )
                diagnostic(
                    format_segment_diagnostic(
                        SegmentMetrics(
                            index=index,
                            count=len(chunks),
                            audio_seconds=chunk.size / sample_rate,
                            preprocess_ms=preprocess_ms,
                            transfer_ms=transfer_ms,
                            prompt_tokens=prompt_length,
                            generated_tokens=generated_tokens,
                            generate_ms=generate_ms,
                            decode_ms=decode_ms,
                            total_ms=(segment_finished - segment_started) * 1_000,
                            peak_allocated_mib=peak_allocated_mib,
                            peak_reserved_mib=peak_reserved_mib,
                            gpu=sampler.summarize(
                                segment_started,
                                segment_finished,
                            ),
                        )
                    )
                )
                del cpu_inputs, inputs, output_ids, generated_ids
        finally:
            sampler.stop()

        elapsed_ms = (time.perf_counter() - started) * 1_000
        diagnostic(
            format_summary_diagnostic(
                audio_seconds=audio_seconds,
                elapsed_ms=elapsed_ms,
                preprocess_ms=total_preprocess_ms,
                transfer_ms=total_transfer_ms,
                generate_ms=total_generate_ms,
                decode_ms=total_decode_ms,
                peak_allocated_mib=overall_peak_allocated_mib,
                peak_reserved_mib=overall_peak_reserved_mib,
            )
        )

        text = normalize_segments(texts)
        if not text:
            raise RuntimeError("Qwen3-ASR 没有生成可用正文")
        return {
            "text": text,
            "language": language,
            "segmentCount": len(chunks),
            "audioDurationSeconds": round(audio_seconds, 3),
            "elapsedMs": round(elapsed_ms),
            "peakAllocatedMiB": round(overall_peak_allocated_mib, 1),
            "peakReservedMiB": round(overall_peak_reserved_mib, 1),
        }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--device", choices=["auto", "cpu", "cuda", "mps"], default="auto")
    args = parser.parse_args()

    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")

    segment_settings = load_segment_settings()
    enable_profiling = profiling_enabled()
    started = time.perf_counter()
    asr = QwenAsr(args.model, segment_settings, enable_profiling, args.device)
    emit(
        {
            "event": "ready",
            "device": asr.device,
            "deviceName": device_name(asr.device),
            "modelLoadMs": round((time.perf_counter() - started) * 1_000),
            "allocatedMiB": round(current_allocated_memory(asr.device), 1),
            "segmentMinimumSeconds": segment_settings.minimum,
            "segmentTargetSeconds": segment_settings.target,
            "segmentMaximumSeconds": segment_settings.maximum,
            "profilingEnabled": enable_profiling,
        }
    )

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        request_id: str | None = None
        try:
            request = json.loads(line)
            request_id = str(request["id"])
            audio_path = Path(str(request["audioPath"]))
            language = str(request.get("language") or "zh")
            result = asr.transcribe(audio_path, language)
            emit({"event": "result", "id": request_id, "ok": True, **result})
        except Exception as error:
            log(traceback.format_exc(limit=6))
            emit(
                {
                    "event": "result",
                    "id": request_id,
                    "ok": False,
                    "error": str(error)[:500],
                }
            )


if __name__ == "__main__":
    main()
