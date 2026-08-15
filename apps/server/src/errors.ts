export type ErrorCategory =
  | "parse_error"
  | "no_matching_video"
  | "no_audio_stream"
  | "download_403"
  | "risk_verify"
  | "interface_error"
  | "network_error"
  | "transcription_error"
  | "model_missing"
  | "asr_device_unavailable"
  | "database_error"
  | "feishu_not_configured"
  | "feishu_error"
  | "cancelled";

export class AppError extends Error {
  constructor(
    public readonly category: ErrorCategory,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  return new AppError("interface_error", error instanceof Error ? error.message : "未知错误");
}

export const PERMANENT_FAILURES = new Set<ErrorCategory>([
  "parse_error",
  "no_matching_video",
  "no_audio_stream",
]);
