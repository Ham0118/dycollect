from __future__ import annotations

import argparse
import json
import platform

import soundfile
import torch
import transformers


def available_devices() -> list[str]:
    devices = ["cpu"]
    if torch.cuda.is_available():
        devices.insert(0, "cuda")
    mps = getattr(torch.backends, "mps", None)
    if mps is not None and mps.is_available():
        devices.insert(0, "mps")
    return devices


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", choices=["auto", "cpu", "cuda", "mps"], default="auto")
    parser.add_argument("--strict", action="store_true")
    args = parser.parse_args()
    devices = available_devices()
    resolved = next((item for item in ["cuda", "mps", "cpu"] if item in devices), None) \
        if args.device == "auto" else (args.device if args.device in devices else None)
    diagnostic = None if resolved else f"当前 PyTorch 运行环境不支持 {args.device.upper()}"
    payload = {
        "requestedDevice": args.device,
        "resolvedDevice": resolved,
        "availableDevices": devices,
        "diagnostic": diagnostic,
        "python": platform.python_version(),
        "torch": torch.__version__,
        "transformers": transformers.__version__,
        "soundfile": soundfile.__version__,
        "cuda": torch.version.cuda,
        "deviceName": (
            torch.cuda.get_device_name(0)
            if resolved == "cuda"
            else "Apple Metal Performance Shaders"
            if resolved == "mps"
            else platform.processor() or platform.machine()
        ),
    }
    print(json.dumps(payload, ensure_ascii=False))
    if args.strict and resolved is None:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
