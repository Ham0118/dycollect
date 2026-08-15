import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ModelAvailability } from "@dycollect/shared";
import { QWEN_ASR_MODEL_DIR } from "./config.js";
import { AppError } from "./errors.js";

export const QWEN_ASR_MODEL_ID = "Qwen/Qwen3-ASR-0.6B-hf";
export const MODEL_SETUP_COMMAND = "npm run setup:model";
export const QWEN_ASR_MODEL_BYTES = 1_564_928_088;
export const QWEN_ASR_REQUIRED_FILES = [
  "chat_template.jinja",
  "config.json",
  "generation_config.json",
  "model.safetensors",
  "processor_config.json",
  "tokenizer.json",
  "tokenizer_config.json",
] as const;

export class ModelStatusService {
  private cached: { expiresAt: number; value: ModelAvailability } | null = null;

  constructor(
    private readonly modelDirectory = QWEN_ASR_MODEL_DIR,
    private readonly cacheMs = 2_000,
  ) {}

  async getStatus(force = false): Promise<ModelAvailability> {
    if (!force && this.cached && this.cached.expiresAt > Date.now()) return this.cached.value;

    const checks = await Promise.all(QWEN_ASR_REQUIRED_FILES.map(async (file) => {
      try {
        const info = await stat(resolve(this.modelDirectory, file));
        const valid = info.isFile()
          && (file !== "model.safetensors" || info.size === QWEN_ASR_MODEL_BYTES);
        return { file, exists: info.isFile(), valid };
      } catch {
        return { file, exists: false, valid: false };
      }
    }));
    const missingFiles = checks.filter((item) => !item.valid).map((item) => item.file);
    const mainModel = checks.find((item) => item.file === "model.safetensors")!;
    const state = missingFiles.length === 0
      ? "ready"
      : mainModel.exists
        ? "incomplete"
        : "missing";
    const value: ModelAvailability = {
      state,
      modelId: QWEN_ASR_MODEL_ID,
      missingFiles,
      setupCommand: MODEL_SETUP_COMMAND,
    };
    this.cached = { expiresAt: Date.now() + this.cacheMs, value };
    return value;
  }

  async isReady(): Promise<boolean> {
    return (await this.getStatus()).state === "ready";
  }

  async assertReady(): Promise<void> {
    const status = await this.getStatus(true);
    if (status.state === "ready") return;
    throw new AppError(
      "model_missing",
      status.state === "incomplete"
        ? `Qwen3-ASR 模型文件不完整，请运行 ${MODEL_SETUP_COMMAND}`
        : `未检测到 Qwen3-ASR 模型，请运行 ${MODEL_SETUP_COMMAND}`,
    );
  }
}
