import { describe, expect, it, vi } from "vitest";
import type { VideoRecord } from "@dycollect/shared";
import { DebugBrowserController } from "./debug-browser.js";
import type { DyCollectDatabase } from "./db.js";
import {
  classifyExistingVideo,
  CrawlWorker,
  elapsedBetween,
  formatByteSize,
  formatWorkLabel,
  hasReachedTarget,
  InterVideoGate,
  sanitizeLogMessage,
} from "./worker.js";

function video(status: VideoRecord["status"], failureCategory: string | null = null): VideoRecord {
  return { status, failureCategory } as VideoRecord;
}

describe("target counting", () => {
  it("reaches the target with one success and one failure", () => {
    expect(hasReachedTarget({ processedCount: 2, targetCount: 2 })).toBe(true);
    expect(hasReachedTarget({ processedCount: 1, targetCount: 2 })).toBe(false);
  });

  it("separates duplicate, historical failure, and actual attempts", () => {
    expect(classifyExistingVideo(video("completed"), false)).toBe("duplicate");
    expect(classifyExistingVideo(video("failed", "no_audio_stream"), false)).toBe("historical_failure");
    expect(classifyExistingVideo(video("failed", "no_audio_stream"), true)).toBe("attempt");
    expect(classifyExistingVideo(null, false)).toBe("attempt");
  });
});

describe("InterVideoGate", () => {
  it("starts the first attempt immediately and waits before the second", async () => {
    const wait = vi.fn(async () => undefined);
    const onWaiting = vi.fn();
    const gate = new InterVideoGate(() => 0.5, wait, () => undefined);
    const signal = new AbortController().signal;

    await expect(gate.beforeAttempt(1, "11111111", signal, onWaiting)).resolves.toBe(0);
    await expect(gate.beforeAttempt(1, "22222222", signal, onWaiting)).resolves.toBe(25_000);
    expect(wait).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledWith(25_000, signal);
    expect(onWaiting).toHaveBeenCalledWith(25_000);
  });
});

describe("safe task logs", () => {
  it("keeps video identity while truncating long titles", () => {
    const label = formatWorkLabel({
      awemeId: "7601484851720380913",
      title: `  ${"很长的标题".repeat(30)}  `,
    });
    expect(label).toContain("7601484851720380913");
    expect(label.length).toBeLessThan(130);
  });

  it("removes URLs and absolute Windows paths from persistent messages", () => {
    const message = sanitizeLogMessage(
      "下载失败 https://signed.example/video?a=secret，文件 C:\\private\\aweme.mp4",
    );
    expect(message).toContain("[链接已隐藏]");
    expect(message).toContain("[路径已隐藏]");
    expect(message).not.toContain("secret");
    expect(message).not.toContain("C:\\private");
  });

  it("formats completed download sizes for persistent logs", () => {
    expect(formatByteSize(512)).toBe("512 B");
    expect(formatByteSize(1_572_864)).toBe("1.50 MB");
    expect(formatByteSize(2_147_483_648)).toBe("2.00 GB");
  });

  it("uses persisted task timestamps across restarts and clamps invalid elapsed time", () => {
    expect(elapsedBetween(
      "2026-07-22T00:00:00.000Z",
      "2026-07-22T01:01:01.000Z",
    )).toBe(3_661_000);
    expect(elapsedBetween(
      "2026-07-22T01:00:00.000Z",
      "2026-07-22T00:00:00.000Z",
    )).toBe(0);
    expect(elapsedBetween(null, "2026-07-22T00:00:00.000Z")).toBe(0);
  });
});

describe("favorite Feishu auto sync", () => {
  it("logs a warning without throwing when Feishu sync fails", async () => {
    const addJobLog = vi.fn((input) => ({
      id: addJobLog.mock.calls.length,
      createdAt: "2026-07-24T00:00:00.000Z",
      ...input,
    }));
    const database = {
      getFavoriteFeishuAutoSyncSettings: vi.fn(() => ({
        enabled: true,
        spaceId: "space-one",
      })),
      addJobLog,
    } as unknown as DyCollectDatabase;
    const syncArticles = vi.fn(async () => ({
      spaceId: "space-one",
      total: 1,
      synced: 0,
      skipped: 0,
      failed: 1,
      items: [{
        awemeId: "7601484851720380913",
        title: "收藏文章",
        status: "failed" as const,
        message: "飞书权限不足",
      }],
    }));
    const worker = new CrawlWorker(
      database,
      new DebugBrowserController(),
      {} as never,
      { syncArticles },
    );
    const autoSync = worker as unknown as {
      autoSyncFavorite(
        jobId: number,
        awemeId: string,
        work: { awemeId: string; title: string },
      ): Promise<void>;
    };

    await expect(autoSync.autoSyncFavorite(
      7,
      "7601484851720380913",
      { awemeId: "7601484851720380913", title: "收藏文章" },
    )).resolves.toBeUndefined();
    expect(syncArticles).toHaveBeenCalledWith(
      "favorite",
      "space-one",
      ["7601484851720380913"],
    );
    expect(addJobLog).toHaveBeenCalledWith(expect.objectContaining({
      jobId: 7,
      level: "warning",
      stage: "completed",
      message: expect.stringContaining("飞书权限不足"),
    }));
  });

  it("does not call Feishu while automatic sync is disabled", async () => {
    const database = {
      getFavoriteFeishuAutoSyncSettings: vi.fn(() => ({
        enabled: false,
        spaceId: null,
      })),
      addJobLog: vi.fn(),
    } as unknown as DyCollectDatabase;
    const syncArticles = vi.fn();
    const worker = new CrawlWorker(
      database,
      new DebugBrowserController(),
      {} as never,
      { syncArticles },
    );
    const autoSync = worker as unknown as {
      autoSyncFavorite(
        jobId: number,
        awemeId: string,
        work: { awemeId: string; title: string },
      ): Promise<void>;
    };

    await autoSync.autoSyncFavorite(
      8,
      "7601484851720380914",
      { awemeId: "7601484851720380914", title: "关闭自动同步" },
    );
    expect(syncArticles).not.toHaveBeenCalled();
    expect(database.addJobLog).not.toHaveBeenCalled();
  });
});
