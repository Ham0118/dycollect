import { describe, expect, it } from "vitest";
import { parseQwenAsrDiagnosticLine } from "./qwen-asr.js";

describe("Qwen3-ASR diagnostic forwarding", () => {
  it("forwards only the fixed diagnostic prefix", () => {
    expect(parseQwenAsrDiagnosticLine(
      "Qwen3-ASR diagnostic segment=1/2 | audio=150.000s | realtime_speed=6.00x",
    )).toBe("segment=1/2 | audio=150.000s | realtime_speed=6.00x");
    expect(parseQwenAsrDiagnosticLine(
      "Qwen3-ASR segment 1/2 finished in 22.398s",
    )).toBe("segment 1/2 finished in 22.398s");
  });

  it("does not forward paths, tracebacks, or arbitrary stderr", () => {
    expect(parseQwenAsrDiagnosticLine("E:\\private\\audio.wav")).toBeNull();
    expect(parseQwenAsrDiagnosticLine("Traceback (most recent call last):")).toBeNull();
    expect(parseQwenAsrDiagnosticLine("")).toBeNull();
  });
});
