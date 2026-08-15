import { spawn } from "node:child_process";
import { access, rename, rm, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  QWEN_ASR_MODEL_DIR,
  QWEN_ASR_PYTHON,
  QWEN_ASR_WORKER,
} from "./config.js";
import { AppError } from "./errors.js";
import { transcribeWithQwen } from "./qwen-asr.js";
import { ensureParent, formatShanghaiDate, formatShanghaiFilename, sanitizeTitle } from "./utils.js";

export type TranscriptionStage = "extracting_audio" | "transcribing";
export type TranscriptionStageEvent =
  | { stage: TranscriptionStage; status: "started" }
  | { stage: TranscriptionStage; status: "finished"; durationMs: number };

export interface TranscriptionInput {
  mediaFile: string;
  dataRoot: string;
  secUid: string;
  awemeId: string;
  title: string;
  author: string;
  publishedAt: string | null;
  sourceUrl: string;
  signal?: AbortSignal;
  onStage?: (event: TranscriptionStageEvent) => void;
}

export interface TranscriptionResult {
  markdownPath: string;
  text: string;
}

export async function transcribeToMarkdown(input: TranscriptionInput): Promise<TranscriptionResult> {
  await verifyAsrRuntime();
  const articleDir = resolve(input.dataRoot, input.secUid, "articles");
  const safeTitle = sanitizeTitle(input.title, `无标题_${input.awemeId}`);
  const timePart = formatShanghaiFilename(input.publishedAt);
  let markdownFile = resolve(articleDir, `${safeTitle}__${timePart}.md`);
  if (await fileExists(markdownFile)) {
    markdownFile = resolve(articleDir, `${safeTitle}__${timePart}__${input.awemeId}.md`);
  }
  const audioFile = `${input.mediaFile}.qwen-asr-${process.pid}-${Date.now()}.wav`;
  const tempMarkdown = `${markdownFile}.tmp-${process.pid}-${Date.now()}`;
  await ensureParent(markdownFile);
  try {
    const result = await runTranscriptionStages(
      input.onStage,
      () => extractAudio(input.mediaFile, audioFile, input.signal),
      () => transcribeWithQwen(audioFile, input.signal),
    );
    const text = normalizeTranscriptionText(result.text);
    if (!text) throw new AppError("transcription_error", "Qwen3-ASR 没有生成可用正文");
    const markdown = buildMarkdown({ ...input, title: safeTitle, text });
    await writeFile(tempMarkdown, markdown, "utf8");
    await rename(tempMarkdown, markdownFile);
    return { markdownPath: relative(input.dataRoot, markdownFile), text };
  } finally {
    await Promise.all([
      rm(audioFile, { force: true }).catch(() => undefined),
      rm(tempMarkdown, { force: true }).catch(() => undefined),
    ]);
  }
}

export async function runTranscriptionStages<T>(
  onStage: ((event: TranscriptionStageEvent) => void) | undefined,
  extract: () => Promise<void>,
  transcribe: () => Promise<T>,
  now: () => number = () => performance.now(),
): Promise<T> {
  const extractionStartedAt = now();
  onStage?.({ stage: "extracting_audio", status: "started" });
  try {
    await extract();
  } finally {
    onStage?.({
      stage: "extracting_audio",
      status: "finished",
      durationMs: Math.max(0, now() - extractionStartedAt),
    });
  }

  const transcriptionStartedAt = now();
  onStage?.({ stage: "transcribing", status: "started" });
  try {
    return await transcribe();
  } finally {
    onStage?.({
      stage: "transcribing",
      status: "finished",
      durationMs: Math.max(0, now() - transcriptionStartedAt),
    });
  }
}

async function verifyAsrRuntime(): Promise<void> {
  const checks = await Promise.all([
    fileExists(QWEN_ASR_PYTHON),
    fileExists(QWEN_ASR_WORKER),
    fileExists(resolve(QWEN_ASR_MODEL_DIR, "model.safetensors")),
  ]);
  if (checks.every(Boolean)) return;
  throw new AppError(
    "model_missing",
    "缺少 Qwen3-ASR 运行环境或模型，请先运行 npm run setup:model",
  );
}

function extractAudio(mediaFile: string, destination: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("ffmpeg", buildAudioExtractionArgs(mediaFile, destination), {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => {
      child.kill();
      finish(() => rejectRun(new AppError("cancelled", "任务已取消")));
    };
    child.stderr.resume();
    child.once("error", () => finish(() => rejectRun(new AppError("transcription_error", "无法启动 FFmpeg 提取音频"))));
    child.once("close", (code) => finish(() => {
      if (code === 0) resolveRun();
      else rejectRun(new AppError("transcription_error", "无法从视频中提取音频"));
    }));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export function buildAudioExtractionArgs(mediaFile: string, destination: string): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    mediaFile,
    "-map",
    "0:a:0",
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    destination,
  ];
}

export function normalizeTranscriptionText(value: string): string {
  const paragraphs = value
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => paragraph.replace(/[\r\n]+/g, " ").trim())
    .filter(Boolean);
  return paragraphs.filter((paragraph, index) => index === 0 || paragraph !== paragraphs[index - 1]).join("\n\n");
}

export function buildMarkdown(input: TranscriptionInput & { text: string }): string {
  const singleLine = (value: string) => value.replace(/[\r\n]+/g, " ").trim();
  return [
    `# ${singleLine(input.title)}`,
    "",
    `- 作者：${singleLine(input.author) || "未知"}`,
    `- 发布时间：${formatShanghaiDate(input.publishedAt)}`,
    `- 原视频：[打开抖音作品](${input.sourceUrl})`,
    "",
    "## 转录正文",
    "",
    input.text.trim(),
    "",
  ].join("\n");
}

async function fileExists(file: string): Promise<boolean> {
  return access(file).then(() => true, () => false);
}
