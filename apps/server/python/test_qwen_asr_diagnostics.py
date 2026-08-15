from __future__ import annotations

import unittest
from unittest.mock import patch

import numpy as np

from qwen_asr_diagnostics import (
    GpuSummary,
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


class SegmentSettingsTests(unittest.TestCase):
    def test_uses_balanced_defaults(self) -> None:
        self.assertEqual(
            load_segment_settings({}),
            SegmentSettings(minimum=120, target=150, maximum=180),
        )

    def test_accepts_environment_overrides(self) -> None:
        settings = load_segment_settings(
            {
                "QWEN_ASR_MIN_SEGMENT_SECONDS": "90",
                "QWEN_ASR_TARGET_SEGMENT_SECONDS": "180",
                "QWEN_ASR_MAX_SEGMENT_SECONDS": "240",
            }
        )
        self.assertEqual(
            settings,
            SegmentSettings(minimum=90, target=180, maximum=240),
        )

    def test_rejects_invalid_ranges_and_values(self) -> None:
        invalid_environments = [
            {"QWEN_ASR_MIN_SEGMENT_SECONDS": "0"},
            {"QWEN_ASR_TARGET_SEGMENT_SECONDS": "not-a-number"},
            {
                "QWEN_ASR_MIN_SEGMENT_SECONDS": "180",
                "QWEN_ASR_TARGET_SEGMENT_SECONDS": "150",
            },
            {"QWEN_ASR_MAX_SEGMENT_SECONDS": "601"},
        ]
        for environment in invalid_environments:
            with self.subTest(environment=environment):
                with self.assertRaises(ValueError):
                    load_segment_settings(environment)

    def test_parses_profile_switch(self) -> None:
        self.assertTrue(profiling_enabled({}))
        self.assertTrue(profiling_enabled({"QWEN_ASR_PROFILE": "on"}))
        self.assertFalse(profiling_enabled({"QWEN_ASR_PROFILE": "0"}))
        with self.assertRaises(ValueError):
            profiling_enabled({"QWEN_ASR_PROFILE": "sometimes"})


class AudioSplitTests(unittest.TestCase):
    settings = SegmentSettings(minimum=120, target=150, maximum=180)
    sample_rate = 10

    def test_keeps_audio_at_the_maximum_in_one_segment(self) -> None:
        audio = np.zeros(180 * self.sample_rate, dtype=np.float32)
        self.assertEqual(
            [chunk.size for chunk in split_audio(audio, self.sample_rate, self.settings)],
            [1_800],
        )

    def test_splits_audio_just_over_the_maximum(self) -> None:
        audio = np.zeros(181 * self.sample_rate, dtype=np.float32)
        self.assertEqual(
            [chunk.size for chunk in split_audio(audio, self.sample_rate, self.settings)],
            [1_500, 310],
        )

    def test_splits_long_audio_into_multiple_segments(self) -> None:
        audio = np.zeros(400 * self.sample_rate, dtype=np.float32)
        self.assertEqual(
            [chunk.size for chunk in split_audio(audio, self.sample_rate, self.settings)],
            [1_500, 1_500, 1_000],
        )


class DiagnosticFormattingTests(unittest.TestCase):
    def test_formats_actionable_metrics_without_sensitive_content(self) -> None:
        sensitive_values = [
            r"E:\private\audio.wav",
            "秘密标题",
            "这是识别正文",
        ]
        audio_line = format_audio_diagnostic(
            181.0,
            16_000,
            [150.0, 31.0],
            SegmentSettings(minimum=120, target=150, maximum=180),
            "on",
        )
        segment_line = format_segment_diagnostic(
            SegmentMetrics(
                index=1,
                count=2,
                audio_seconds=150.0,
                preprocess_ms=120.0,
                transfer_ms=10.0,
                prompt_tokens=1_024,
                generated_tokens=600,
                generate_ms=20_000.0,
                decode_ms=15.0,
                total_ms=20_200.0,
                peak_allocated_mib=2_100.0,
                peak_reserved_mib=2_400.0,
                gpu=GpuSummary(
                    average_utilization=72.0,
                    maximum_utilization=96.0,
                    maximum_memory_used_mib=4_000.0,
                    average_power_watts=120.0,
                    maximum_power_watts=160.0,
                ),
            )
        )
        summary_line = format_summary_diagnostic(
            audio_seconds=181.0,
            elapsed_ms=30_000.0,
            preprocess_ms=200.0,
            transfer_ms=20.0,
            generate_ms=29_000.0,
            decode_ms=30.0,
            peak_allocated_mib=2_100.0,
            peak_reserved_mib=2_400.0,
        )
        combined = "\n".join([audio_line, segment_line, summary_line])
        self.assertIn("segment_durations=[150.000,31.000]s", combined)
        self.assertIn("tokens_per_second=30.00", combined)
        self.assertIn("realtime_speed=7.43x", segment_line)
        self.assertIn("gpu_util_avg=72.0%", combined)
        self.assertIn("peak_reserved=2400.0MiB", combined)
        for sensitive in sensitive_values:
            self.assertNotIn(sensitive, combined)

    def test_formats_missing_gpu_sampling_without_failure(self) -> None:
        line = format_segment_diagnostic(
            SegmentMetrics(
                index=1,
                count=1,
                audio_seconds=30.0,
                preprocess_ms=1.0,
                transfer_ms=1.0,
                prompt_tokens=100,
                generated_tokens=20,
                generate_ms=1_000.0,
                decode_ms=1.0,
                total_ms=1_100.0,
                peak_allocated_mib=1_500.0,
                peak_reserved_mib=1_600.0,
                gpu=None,
            )
        )
        self.assertIn("gpu=unavailable", line)


class GpuSamplerTests(unittest.TestCase):
    def test_does_not_launch_nvidia_smi_when_disabled(self) -> None:
        with patch("qwen_asr_diagnostics.subprocess.Popen") as popen:
            sampler = NvidiaSmiSampler(False)
            sampler.start()
            sampler.stop()
        popen.assert_not_called()
        self.assertEqual(sampler.status, "off")

    def test_treats_missing_nvidia_smi_as_optional(self) -> None:
        with patch(
            "qwen_asr_diagnostics.subprocess.Popen",
            side_effect=FileNotFoundError,
        ):
            sampler = NvidiaSmiSampler(True)
            sampler.start()
            sampler.stop()
        self.assertEqual(sampler.status, "unavailable")


if __name__ == "__main__":
    unittest.main()
