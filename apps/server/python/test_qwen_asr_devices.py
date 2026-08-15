from __future__ import annotations

import unittest
from unittest.mock import patch

import qwen_asr_worker as worker


class DeviceSelectionTests(unittest.TestCase):
    def test_cpu_is_always_selectable(self) -> None:
        self.assertEqual(worker.resolve_device("cpu"), "cpu")

    def test_auto_uses_cuda_then_mps_then_cpu(self) -> None:
        with patch.object(worker, "available_devices", return_value=["cuda", "mps", "cpu"]):
            self.assertEqual(worker.resolve_device("auto"), "cuda")
        with patch.object(worker, "available_devices", return_value=["mps", "cpu"]):
            self.assertEqual(worker.resolve_device("auto"), "mps")
        with patch.object(worker, "available_devices", return_value=["cpu"]):
            self.assertEqual(worker.resolve_device("auto"), "cpu")

    def test_explicit_unavailable_device_does_not_fall_back(self) -> None:
        with patch.object(worker, "available_devices", return_value=["cpu"]):
            with self.assertRaisesRegex(RuntimeError, "不支持 CUDA"):
                worker.resolve_device("cuda")

    def test_cpu_metrics_do_not_call_cuda(self) -> None:
        with patch.object(worker.torch.cuda, "synchronize") as synchronize:
            worker.synchronize("cpu")
            synchronize.assert_not_called()
        self.assertEqual(worker.peak_memory("cpu"), (0.0, 0.0))
        self.assertEqual(worker.current_allocated_memory("cpu"), 0.0)


if __name__ == "__main__":
    unittest.main()
