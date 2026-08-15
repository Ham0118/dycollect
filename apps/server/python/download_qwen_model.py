from __future__ import annotations

import argparse
import hashlib
from pathlib import Path

from huggingface_hub import snapshot_download


REPOSITORY = "Qwen/Qwen3-ASR-0.6B-hf"
REVISION = "6aa69c382e2b426eee1f5870d4c95859a74b6445"
MODEL_SHA256 = "d3f212dd20abecd315d830bc54ae3865e56ebfc3276484e57b771288ba27fd35"
ALLOW_PATTERNS = [
    ".gitattributes",
    "README.md",
    "chat_template.jinja",
    "config.json",
    "generation_config.json",
    "model.safetensors",
    "processor_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
]
REQUIRED_FILES = [
    "chat_template.jinja",
    "config.json",
    "generation_config.json",
    "model.safetensors",
    "processor_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(8 * 1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    args = parser.parse_args()

    model_file = args.destination / "model.safetensors"
    model_valid = model_file.is_file() and sha256(model_file) == MODEL_SHA256
    required_files_present = all((args.destination / name).is_file() for name in REQUIRED_FILES)
    if model_valid and required_files_present:
        print(f"Qwen3-ASR 模型已存在并通过 SHA-256 校验：{args.destination}")
        return

    if model_file.exists() and not model_valid:
        raise RuntimeError("现有 Qwen3-ASR 模型校验失败，请移走模型目录后重试")

    snapshot_download(
        repo_id=REPOSITORY,
        revision=REVISION,
        local_dir=args.destination,
        cache_dir=args.cache,
        allow_patterns=ALLOW_PATTERNS,
    )
    actual = sha256(model_file)
    if actual != MODEL_SHA256:
        raise RuntimeError(f"Qwen3-ASR 模型校验失败：{actual}")
    missing = [name for name in REQUIRED_FILES if not (args.destination / name).is_file()]
    if missing:
        raise RuntimeError(f"Qwen3-ASR 模型文件不完整：{', '.join(missing)}")
    print(f"Qwen3-ASR 模型准备完成：{args.destination}")


if __name__ == "__main__":
    main()
