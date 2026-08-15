import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const PROJECT_ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
export const DATA_DIR = resolve(PROJECT_ROOT, process.env.DYCOLLECT_DATA_DIR ?? "data");
export const DATABASE_PATH = resolve(DATA_DIR, "archive.sqlite3");
export const BROWSER_PROFILE_DIR = resolve(PROJECT_ROOT, ".browser", "douyin");
export const QWEN_ASR_MODEL_DIR = resolve(
  PROJECT_ROOT,
  process.env.DYCOLLECT_QWEN_ASR_MODEL ?? "models/qwen3-asr-0.6b-hf",
);
export const QWEN_ASR_PYTHON = resolve(
  PROJECT_ROOT,
  process.env.DYCOLLECT_QWEN_ASR_PYTHON
    ?? (process.platform === "win32" ? ".venv-qwen-asr/Scripts/python.exe" : ".venv-qwen-asr/bin/python"),
);
export const QWEN_ASR_WORKER = resolve(PROJECT_ROOT, "apps", "server", "python", "qwen_asr_worker.py");
export const QWEN_ASR_VERIFY_SCRIPT = resolve(PROJECT_ROOT, "apps", "server", "python", "verify_qwen_runtime.py");
export const HF_CACHE_DIR = resolve(PROJECT_ROOT, ".hf-cache");
export const WEB_DIST_DIR = resolve(PROJECT_ROOT, "apps", "web", "dist");
export const PORT = Number.parseInt(process.env.PORT ?? "3210", 10);
export const HOST = process.env.HOST ?? "0.0.0.0";
export const DEFAULT_TIMEOUT_MS = 25_000;
