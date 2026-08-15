import { spawn } from "node:child_process";
import { AppError } from "./errors.js";

export interface ProbeResult {
  hasAudio: boolean;
  creationTime: string | null;
}

export function probeMedia(file: string, timeoutMs: number, signal?: AbortSignal): Promise<ProbeResult> {
  return new Promise((resolveProbe, rejectProbe) => {
    const child = spawn("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => {
      child.kill();
      finish(() => rejectProbe(new AppError("cancelled", "任务已取消")));
    };
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 2_000_000) stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 10_000) stderr += String(chunk);
    });
    child.once("error", () => finish(() => rejectProbe(new AppError("interface_error", "无法启动 ffprobe"))));
    child.once("close", (code) => finish(() => {
      if (code !== 0) return resolveProbe({ hasAudio: false, creationTime: null });
      try {
        const data = JSON.parse(stdout) as {
          streams?: Array<{ codec_type?: string; tags?: Record<string, string> }>;
          format?: { tags?: Record<string, string> };
        };
        const hasAudio = Array.isArray(data.streams) && data.streams.some((stream) => stream.codec_type === "audio");
        const rawTime = data.format?.tags?.creation_time
          ?? data.streams?.find((stream) => stream.tags?.creation_time)?.tags?.creation_time
          ?? null;
        const date = rawTime ? new Date(rawTime) : null;
        resolveProbe({ hasAudio, creationTime: date && Number.isFinite(date.getTime()) ? date.toISOString() : null });
      } catch {
        resolveProbe({ hasAudio: false, creationTime: null });
      }
    }));
    const timer = setTimeout(() => {
      child.kill();
      finish(() => rejectProbe(new AppError("interface_error", "ffprobe 执行超时")));
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    void stderr;
  });
}

