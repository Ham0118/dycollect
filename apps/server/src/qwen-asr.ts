import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface, type Interface } from "node:readline";
import type { AsrDevice } from "@dycollect/shared";
import {
  HF_CACHE_DIR,
  QWEN_ASR_MODEL_DIR,
  QWEN_ASR_PYTHON,
  QWEN_ASR_WORKER,
} from "./config.js";
import { AppError } from "./errors.js";

interface ReadyMessage {
  event: "ready";
  device: Exclude<AsrDevice, "auto">;
  deviceName: string;
  modelLoadMs: number;
  allocatedMiB: number;
  segmentMinimumSeconds: number;
  segmentTargetSeconds: number;
  segmentMaximumSeconds: number;
  profilingEnabled: boolean;
}

interface ResultMessage {
  event: "result";
  id: string | null;
  ok: boolean;
  text?: string;
  language?: string;
  segmentCount?: number;
  audioDurationSeconds?: number;
  elapsedMs?: number;
  peakAllocatedMiB?: number;
  peakReservedMiB?: number;
}

interface PendingRequest {
  id: string;
  resolve: (value: QwenTranscriptionResult) => void;
  reject: (error: Error) => void;
  removeAbortListener: () => void;
}

export interface QwenTranscriptionResult {
  text: string;
  language: string;
  segmentCount: number;
  audioDurationSeconds: number;
  elapsedMs: number;
  peakAllocatedMiB: number;
  peakReservedMiB: number;
}

class QwenAsrProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: Interface | null = null;
  private errorLines: Interface | null = null;
  private starting: Promise<void> | null = null;
  private pending: PendingRequest | null = null;
  private stderrTail = "";
  private deviceProvider: () => AsrDevice = () => "auto";

  configureDevice(provider: () => AsrDevice): void {
    this.deviceProvider = provider;
  }

  async transcribe(audioPath: string, signal?: AbortSignal): Promise<QwenTranscriptionResult> {
    if (signal?.aborted) throw new AppError("cancelled", "任务已取消");
    await this.ensureStarted();
    if (signal?.aborted) {
      this.stopProcess();
      throw new AppError("cancelled", "任务已取消");
    }
    if (!this.child?.stdin.writable) {
      throw new AppError("transcription_error", "Qwen3-ASR 进程不可用");
    }
    if (this.pending) {
      throw new AppError("transcription_error", "Qwen3-ASR 当前正忙");
    }

    const id = randomUUID();
    return new Promise<QwenTranscriptionResult>((resolve, reject) => {
      const onAbort = () => {
        if (this.pending?.id !== id) return;
        this.pending = null;
        this.stopProcess();
        reject(new AppError("cancelled", "任务已取消"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending = {
        id,
        resolve,
        reject,
        removeAbortListener: () => signal?.removeEventListener("abort", onAbort),
      };
      this.child!.stdin.write(`${JSON.stringify({ id, audioPath, language: "zh" })}\n`, "utf8", (error) => {
        if (!error || this.pending?.id !== id) return;
        const pending = this.pending;
        this.pending = null;
        pending.removeAbortListener();
        pending.reject(new AppError("transcription_error", "无法向 Qwen3-ASR 提交音频"));
        this.stopProcess();
      });
      if (signal?.aborted) onAbort();
    });
  }

  shutdown(): void {
    if (this.pending) {
      const pending = this.pending;
      this.pending = null;
      pending.removeAbortListener();
      pending.reject(new AppError("cancelled", "服务正在关闭"));
    }
    this.stopProcess();
  }

  private ensureStarted(): Promise<void> {
    if (this.child && !this.child.killed) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = this.startProcess().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private startProcess(): Promise<void> {
    this.stderrTail = "";
    const requestedDevice = this.deviceProvider();
    const child = spawn(QWEN_ASR_PYTHON, [
      "-u",
      QWEN_ASR_WORKER,
      "--model",
      QWEN_ASR_MODEL_DIR,
      "--device",
      requestedDevice,
    ], {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        HF_HOME: HF_CACHE_DIR,
        HF_HUB_OFFLINE: "1",
        HF_HUB_DISABLE_PROGRESS_BARS: "1",
        TRANSFORMERS_OFFLINE: "1",
        TRANSFORMERS_VERBOSITY: "error",
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
      },
    });
    this.child = child;
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.errorLines = createInterface({ input: child.stderr, crlfDelay: Infinity });

    return new Promise<void>((resolve, reject) => {
      let ready = false;
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.stopProcess();
        reject(new AppError("transcription_error", "Qwen3-ASR 模型启动超时"));
      }, 120_000);
      const finishStart = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        callback();
      };

      this.lines!.on("line", (line) => {
        let message: ReadyMessage | ResultMessage;
        try {
          message = JSON.parse(line) as ReadyMessage | ResultMessage;
        } catch {
          return;
        }
        if (message.event === "ready") {
          ready = true;
          const memory = message.device === "cuda"
            ? `，显存 ${message.allocatedMiB.toFixed(1)} MiB`
            : "";
          console.log(
            `[Qwen3-ASR] ${message.device.toUpperCase()} 已就绪：${message.deviceName}，模型加载 ${(message.modelLoadMs / 1_000).toFixed(3)} 秒${memory}，切段 ${message.segmentMinimumSeconds}/${message.segmentTargetSeconds}/${message.segmentMaximumSeconds} 秒（最短/目标/最长），GPU 性能采样${message.profilingEnabled ? "开启" : "关闭"}`,
          );
          finishStart(resolve);
          return;
        }
        this.handleResult(message);
      });
      this.errorLines!.on("line", (line) => {
        const diagnostic = parseQwenAsrDiagnosticLine(line);
        if (diagnostic) {
          console.log(`[Qwen3-ASR] ${diagnostic}`);
          return;
        }
        this.stderrTail = `${this.stderrTail}\n${line}`.slice(-20_000);
      });
      child.once("error", () => {
        finishStart(() => reject(new AppError("transcription_error", "无法启动 Qwen3-ASR Python 进程")));
      });
      child.once("close", (code) => {
        const wasCurrent = this.child === child;
        if (wasCurrent) {
          this.child = null;
          this.lines?.close();
          this.lines = null;
          this.errorLines?.close();
          this.errorLines = null;
        }
        if (this.stderrTail.trim()) {
          console.error(`[Qwen3-ASR] 进程日志：${sanitizeLog(this.stderrTail)}`);
        }
        if (!ready) {
          finishStart(() => reject(new AppError("transcription_error", `Qwen3-ASR 启动失败（退出码 ${code ?? "未知"}）`)));
        }
        if (this.pending) {
          const pending = this.pending;
          this.pending = null;
          pending.removeAbortListener();
          pending.reject(new AppError("transcription_error", "Qwen3-ASR 进程异常退出"));
        }
      });
    });
  }

  private handleResult(message: ResultMessage): void {
    if (!this.pending || message.id !== this.pending.id) return;
    const pending = this.pending;
    this.pending = null;
    pending.removeAbortListener();
    if (!message.ok || !message.text?.trim()) {
      pending.reject(new AppError("transcription_error", "Qwen3-ASR 没有生成可用正文"));
      return;
    }
    const result: QwenTranscriptionResult = {
      text: message.text.trim(),
      language: message.language ?? "zh",
      segmentCount: message.segmentCount ?? 1,
      audioDurationSeconds: message.audioDurationSeconds ?? 0,
      elapsedMs: message.elapsedMs ?? 0,
      peakAllocatedMiB: message.peakAllocatedMiB ?? 0,
      peakReservedMiB: message.peakReservedMiB ?? 0,
    };
    const realtimeSpeed = result.elapsedMs > 0
      ? result.audioDurationSeconds / (result.elapsedMs / 1_000)
      : 0;
    console.log(
      `[Qwen3-ASR] 转录完成：${result.segmentCount} 段，音频 ${result.audioDurationSeconds.toFixed(3)} 秒，耗时 ${(result.elapsedMs / 1_000).toFixed(3)} 秒，实时速度 ${realtimeSpeed.toFixed(2)}x，峰值已分配/保留显存 ${result.peakAllocatedMiB.toFixed(1)}/${result.peakReservedMiB.toFixed(1)} MiB`,
    );
    pending.resolve(result);
  }

  private stopProcess(): void {
    const child = this.child;
    this.child = null;
    this.lines?.close();
    this.lines = null;
    this.errorLines?.close();
    this.errorLines = null;
    if (child && !child.killed) terminateProcessTree(child);
  }
}

function sanitizeLog(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim().slice(-2_000);
}

export function parseQwenAsrDiagnosticLine(line: string): string | null {
  const prefix = "Qwen3-ASR diagnostic ";
  if (line.startsWith(prefix)) return line.slice(prefix.length).trim() || null;
  const legacyPrefix = "Qwen3-ASR segment ";
  if (line.startsWith(legacyPrefix)) return line.slice("Qwen3-ASR ".length).trim() || null;
  return null;
}

function terminateProcessTree(child: ChildProcessWithoutNullStreams): void {
  if (process.platform === "win32" && child.pid) {
    try {
      execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      return;
    } catch {
      // Fall through to Node's direct child termination if taskkill is unavailable.
    }
  }
  child.kill();
}

const qwenAsr = new QwenAsrProcess();

export function configureQwenAsrDevice(provider: () => AsrDevice): void {
  qwenAsr.configureDevice(provider);
}

export function transcribeWithQwen(audioPath: string, signal?: AbortSignal): Promise<QwenTranscriptionResult> {
  return qwenAsr.transcribe(audioPath, signal);
}

export function shutdownQwenAsr(): void {
  qwenAsr.shutdown();
}
