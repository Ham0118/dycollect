import { describe, expect, it, vi } from "vitest";
import {
  buildAudioExtractionArgs,
  buildMarkdown,
  normalizeTranscriptionText,
  runTranscriptionStages,
} from "./transcriber.js";

describe("Qwen3-ASR transcription", () => {
  it("extracts the first audio stream as 16 kHz mono PCM", () => {
    const args = buildAudioExtractionArgs("input.mp4", "output.wav");
    expect(args).toContain("0:a:0");
    expect(args).toContain("16000");
    expect(args).toContain("pcm_s16le");
    expect(args.at(-1)).toBe("output.wav");
  });

  it("keeps model text unchanged instead of applying a regional converter", () => {
    expect(normalizeTranscriptionText("这是一个软件 Claude Code")).toBe("这是一个软件 Claude Code");
  });

  it("normalizes segment output into paragraphs and removes adjacent duplicates", () => {
    expect(normalizeTranscriptionText("第一段\n\n第一段\n\n第二段\n继续")).toBe("第一段\n\n第二段 继续");
  });

  it("writes Chinese metadata and the original Qwen text to Markdown", () => {
    const markdown = buildMarkdown({
      mediaFile: "input.mp4",
      dataRoot: "data",
      secUid: "creator",
      awemeId: "7601484851720380913",
      title: "测试标题",
      author: "测试作者",
      publishedAt: "2026-01-31T11:23:30.000Z",
      sourceUrl: "https://www.douyin.com/video/7601484851720380913",
      text: "这是简体中文软件。",
    });
    expect(markdown).toContain("- 作者：测试作者");
    expect(markdown).toContain("## 转录正文");
    expect(markdown).toContain("这是简体中文软件。");
  });

  it("reports audio extraction before speech transcription", async () => {
    const events: string[] = [];
    const extract = vi.fn(async () => { events.push("extract"); });
    const transcribe = vi.fn(async () => {
      events.push("transcribe");
      return "正文";
    });

    const timestamps = [100, 500, 500, 54_500];
    await expect(runTranscriptionStages(
      (event) => events.push(
        event.status === "started"
          ? `${event.stage}:started`
          : `${event.stage}:finished:${event.durationMs}`,
      ),
      extract,
      transcribe,
      () => timestamps.shift()!,
    )).resolves.toBe("正文");
    expect(events).toEqual([
      "extracting_audio:started",
      "extract",
      "extracting_audio:finished:400",
      "transcribing:started",
      "transcribe",
      "transcribing:finished:54000",
    ]);
  });

  it("finishes the active stage timer when extraction fails or is cancelled", async () => {
    const events: Array<{ status: string; durationMs?: number }> = [];
    const timestamps = [0, 1_250];
    await expect(runTranscriptionStages(
      (event) => events.push(event),
      async () => { throw new Error("cancelled"); },
      async () => "unused",
      () => timestamps.shift()!,
    )).rejects.toThrow("cancelled");
    expect(events).toEqual([
      { stage: "extracting_audio", status: "started" },
      { stage: "extracting_audio", status: "finished", durationMs: 1_250 },
    ]);
  });

  it("finishes the transcription timer when speech recognition fails", async () => {
    const events: Array<{ status: string; durationMs?: number }> = [];
    const timestamps = [0, 100, 100, 2_100];
    await expect(runTranscriptionStages(
      (event) => events.push(event),
      async () => undefined,
      async () => { throw new Error("asr failed"); },
      () => timestamps.shift()!,
    )).rejects.toThrow("asr failed");
    expect(events.at(-1)).toEqual({
      stage: "transcribing",
      status: "finished",
      durationMs: 2_000,
    });
  });
});
