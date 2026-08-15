import { EventEmitter, once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import type { CrawlJob } from "@dycollect/shared";
import type { BrowserContext, Page } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi, createDashboardSnapshot, createEventsHandler } from "./api.js";
import type { AsrSettingsService } from "./asr-settings.js";
import type { DyCollectDatabase } from "./db.js";
import type { DeletionService } from "./deletion.js";
import { DebugBrowserController } from "./debug-browser.js";
import type { FeishuService } from "./feishu.js";
import type { FavoriteMonitor } from "./favorite-monitor.js";
import type { ModelStatusService } from "./model-status.js";
import { AppError } from "./errors.js";
import type { CrawlWorker } from "./worker.js";

function fakeContext(): BrowserContext {
  const page = { goto: vi.fn(async () => null) } as unknown as Page;
  const listeners: Array<() => void> = [];
  return {
    pages: () => [page],
    newPage: vi.fn(async () => page),
    once: vi.fn((_event: string, listener: () => void) => { listeners.push(listener); }),
    close: vi.fn(async () => { listeners.forEach((listener) => listener()); }),
  } as unknown as BrowserContext;
}

function fakeDatabase(queuedJobs: CrawlJob[] = []) {
  const listener = {
    enabled: false,
    status: "stopped" as const,
    baselineAwemeId: null,
    cursorAwemeId: null,
    lastCheckedAt: null,
    errorCategory: null,
    errorMessage: null,
    updatedAt: "2026-07-24T00:00:00.000Z",
  };
  return {
    getDashboard: vi.fn(() => ({
      activeJob: null,
      queuedJobs,
      recentJobs: [],
      logJobId: null,
      jobLogs: [],
      favoriteListener: listener,
    })),
    getFavoriteListenerState: vi.fn(() => listener),
    hasPendingJobs: vi.fn(() => false),
    createJob: vi.fn(),
  } as unknown as DyCollectDatabase;
}

async function startApi(
  database: DyCollectDatabase,
  debugBrowser: DebugBrowserController,
  deletionService?: DeletionService,
  feishuService?: FeishuService,
  favoriteMonitor?: FavoriteMonitor,
  modelStatus: ModelStatusService = {
    getStatus: vi.fn(async () => ({
      state: "ready" as const,
      modelId: "Qwen/Qwen3-ASR-0.6B-hf",
      missingFiles: [],
      setupCommand: "npm run setup:model",
    })),
    assertReady: vi.fn(async () => undefined),
    isReady: vi.fn(async () => true),
  } as unknown as ModelStatusService,
  asrSettings?: AsrSettingsService,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use("/api", createApi(
    database,
    { cancelActive: vi.fn(), getDownloadProgress: vi.fn(() => null) } as unknown as CrawlWorker,
    debugBrowser,
    deletionService,
    feishuService,
    favoriteMonitor,
    modelStatus,
    asrSettings,
  ));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof AppError) {
      const status = error.category === "model_missing" || error.category === "asr_device_unavailable" ? 409 : 500;
      response.status(status).json({ error: error.category, message: error.message });
      return;
    }
    response.status(500).json({ error: "interface_error", message: "请求失败" });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/api`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("ASR settings API", () => {
  it("reads and saves a supported device", async () => {
    const view = {
      selectedDevice: "auto" as const,
      resolvedDevice: "cuda" as const,
      availableDevices: ["cuda" as const, "cpu" as const],
      diagnostic: null,
    };
    const asrSettings = {
      getView: vi.fn(async () => view),
      saveDevice: vi.fn(async () => ({ ...view, selectedDevice: "cpu" as const, resolvedDevice: "cpu" as const })),
    } as unknown as AsrSettingsService;
    const api = await startApi(
      fakeDatabase(),
      new DebugBrowserController(),
      undefined,
      undefined,
      undefined,
      undefined,
      asrSettings,
    );
    cleanups.push(api.close);

    const getResponse = await fetch(`${api.baseUrl}/settings/asr`);
    expect(getResponse.status).toBe(200);
    expect(await getResponse.json()).toMatchObject({ selectedDevice: "auto", resolvedDevice: "cuda" });

    const putResponse = await fetch(`${api.baseUrl}/settings/asr`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device: "cpu" }),
    });
    expect(putResponse.status).toBe(200);
    expect(asrSettings.saveDevice).toHaveBeenCalledWith("cpu");
  });

  it("rejects device changes while work is queued", async () => {
    const asrSettings = { getView: vi.fn(), saveDevice: vi.fn() } as unknown as AsrSettingsService;
    const api = await startApi(
      fakeDatabase([{} as CrawlJob]),
      new DebugBrowserController(),
      undefined,
      undefined,
      undefined,
      undefined,
      asrSettings,
    );
    cleanups.push(api.close);
    const response = await fetch(`${api.baseUrl}/settings/asr`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device: "cpu" }),
    });
    expect(response.status).toBe(409);
    expect(asrSettings.saveDevice).not.toHaveBeenCalled();
  });
});

describe("debug browser API conflicts", () => {
  it("reports model availability without exposing a host path", async () => {
    const debugBrowser = new DebugBrowserController();
    const modelStatus = {
      getStatus: vi.fn(async () => ({
        state: "missing" as const,
        modelId: "Qwen/Qwen3-ASR-0.6B-hf",
        missingFiles: ["model.safetensors"],
        setupCommand: "npm run setup:model",
      })),
      assertReady: vi.fn(async () => undefined),
    } as unknown as ModelStatusService;
    const api = await startApi(fakeDatabase(), debugBrowser, undefined, undefined, undefined, modelStatus);
    cleanups.push(api.close);

    const response = await fetch(`${api.baseUrl}/system/model`);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual(expect.objectContaining({ state: "missing", setupCommand: "npm run setup:model" }));
    expect(JSON.stringify(body)).not.toContain("E:\\");
  });

  it("rejects task creation when the model is unavailable", async () => {
    const debugBrowser = new DebugBrowserController();
    const database = fakeDatabase();
    const modelStatus = {
      getStatus: vi.fn(),
      assertReady: vi.fn(async () => { throw new AppError("model_missing", "请运行 npm run setup:model"); }),
    } as unknown as ModelStatusService;
    const api = await startApi(database, debugBrowser, undefined, undefined, undefined, modelStatus);
    cleanups.push(api.close);

    const response = await fetch(`${api.baseUrl}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileUrl: "https://www.douyin.com/user/example", targetCount: 1 }),
    });
    expect(response.status).toBe(409);
    expect((database as unknown as { createJob: ReturnType<typeof vi.fn> }).createJob).not.toHaveBeenCalled();
  });

  it("accepts a same-origin write forwarded by the Vite development proxy", async () => {
    const launcher = vi.fn(async () => fakeContext());
    const debugBrowser = new DebugBrowserController("E:\\profile", launcher);
    cleanups.push(() => debugBrowser.close());
    const api = await startApi(fakeDatabase(), debugBrowser);
    cleanups.push(api.close);

    const response = await fetch(`${api.baseUrl}/browser/debug/open`, {
      method: "POST",
      headers: {
        Origin: "http://localhost:5173",
        "X-Forwarded-Host": "localhost:5173",
      },
    });

    expect(response.status).toBe(200);
    expect(launcher).toHaveBeenCalledTimes(1);
  });

  it("rejects opening while a job is queued", async () => {
    const launcher = vi.fn(async () => fakeContext());
    const debugBrowser = new DebugBrowserController("E:\\profile", launcher);
    const queued = [{} as CrawlJob];
    const api = await startApi(fakeDatabase(queued), debugBrowser);
    cleanups.push(api.close);

    const response = await fetch(`${api.baseUrl}/browser/debug/open`, { method: "POST" });
    expect(response.status).toBe(409);
    expect(launcher).not.toHaveBeenCalled();
  });

  it("rejects task creation while the debug browser is open", async () => {
    const debugBrowser = new DebugBrowserController("E:\\profile", async () => fakeContext());
    await debugBrowser.open();
    cleanups.push(() => debugBrowser.close());
    const database = fakeDatabase();
    const api = await startApi(database, debugBrowser);
    cleanups.push(api.close);

    const response = await fetch(`${api.baseUrl}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profileUrl: "https://www.douyin.com/user/example", targetCount: 1 }),
    });
    expect(response.status).toBe(409);
    expect((database as unknown as { createJob: ReturnType<typeof vi.fn> }).createJob).not.toHaveBeenCalled();
  });
});

describe("jobs API", () => {
  it("returns a fixed five-item page", async () => {
    const page = { items: [], page: 2, pageSize: 5, total: 7, totalPages: 2 };
    const database = {
      listJobs: vi.fn(() => page),
    } as unknown as DyCollectDatabase;
    const api = await startApi(database, new DebugBrowserController());
    cleanups.push(api.close);

    const response = await fetch(`${api.baseUrl}/jobs?page=2`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(page);
    expect(database.listJobs).toHaveBeenCalledWith(2, 5);
  });

  it("deletes a terminal task", async () => {
    const job = { id: 7, status: "completed" } as CrawlJob;
    const database = {
      getJob: vi.fn(() => job),
      deleteJob: vi.fn(() => true),
    } as unknown as DyCollectDatabase;
    const api = await startApi(database, new DebugBrowserController());
    cleanups.push(api.close);

    const response = await fetch(`${api.baseUrl}/jobs/7`, { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true, jobId: 7 });
    expect(database.deleteJob).toHaveBeenCalledWith(7);
  });

  it("rejects deleting an active task", async () => {
    const database = {
      getJob: vi.fn(() => ({ id: 8, status: "running" } as CrawlJob)),
      deleteJob: vi.fn(),
    } as unknown as DyCollectDatabase;
    const api = await startApi(database, new DebugBrowserController());
    cleanups.push(api.close);

    const response = await fetch(`${api.baseUrl}/jobs/8`, { method: "DELETE" });
    expect(response.status).toBe(409);
    expect(database.deleteJob).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing task and protects deletion from cross-origin writes", async () => {
    const database = { getJob: vi.fn(() => null), deleteJob: vi.fn() } as unknown as DyCollectDatabase;
    const api = await startApi(database, new DebugBrowserController());
    cleanups.push(api.close);

    expect((await fetch(`${api.baseUrl}/jobs/404`, { method: "DELETE" })).status).toBe(404);
    const crossOrigin = await fetch(`${api.baseUrl}/jobs/7`, {
      method: "DELETE",
      headers: { Origin: "https://example.com" },
    });
    expect(crossOrigin.status).toBe(403);
    expect(database.deleteJob).not.toHaveBeenCalled();
  });
});

describe("favorite listener API", () => {
  const stoppedState = {
    enabled: false,
    status: "stopped" as const,
    baselineAwemeId: null,
    cursorAwemeId: null,
    lastCheckedAt: null,
    errorCategory: null,
    errorMessage: null,
    updatedAt: "2026-07-24T00:00:00.000Z",
  };

  it("starts and stops through the shared monitor", async () => {
    const initializing = { ...stoppedState, enabled: true, status: "initializing" as const };
    const database = {
      getFavoriteListenerState: vi.fn(() => stoppedState),
      hasPendingJobs: vi.fn(() => false),
    } as unknown as DyCollectDatabase;
    const monitor = {
      start: vi.fn(() => initializing),
      stop: vi.fn(async () => stoppedState),
    } as unknown as FavoriteMonitor;
    const api = await startApi(
      database,
      new DebugBrowserController(),
      undefined,
      undefined,
      monitor,
    );
    cleanups.push(api.close);

    const started = await fetch(`${api.baseUrl}/favorites/listener/start`, { method: "POST" });
    expect(started.status).toBe(202);
    expect(await started.json()).toMatchObject({ enabled: true, status: "initializing" });
    expect(database.hasPendingJobs).toHaveBeenCalledWith("creator");

    const stopped = await fetch(`${api.baseUrl}/favorites/listener/stop`, { method: "POST" });
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toMatchObject({ enabled: false, status: "stopped" });
  });

  it("rejects creator jobs while favorite mode is active", async () => {
    const database = {
      getFavoriteListenerState: vi.fn(() => ({ ...stoppedState, enabled: true, status: "listening" })),
      hasPendingJobs: vi.fn(() => false),
      createJob: vi.fn(),
    } as unknown as DyCollectDatabase;
    const api = await startApi(database, new DebugBrowserController());
    cleanups.push(api.close);

    const response = await fetch(`${api.baseUrl}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profileUrl: "https://www.douyin.com/user/creator-blocked",
        targetCount: 1,
      }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "favorite_mode_active" });
    expect(database.createJob).not.toHaveBeenCalled();
  });

  it("paginates independent favorite records and returns their details", async () => {
    const favorite = {
      awemeId: "7000000000000000300",
      title: "收藏文章",
      author: "收藏作者",
      sourceUrl: "https://www.douyin.com/video/7000000000000000300",
      publishedAt: null,
      publishedAtSource: "unknown" as const,
      status: "discovered" as const,
      failureCategory: null,
      failureReason: null,
      attempts: 0,
      markdownPath: null,
      mediaPath: null,
      discoveredAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-07-24T00:00:00.000Z",
      completedAt: null,
    };
    const page = { items: [favorite], page: 2, pageSize: 50, total: 51, totalPages: 2 };
    const database = {
      listFavoriteVideos: vi.fn(() => page),
      getFavoriteVideo: vi.fn(() => favorite),
    } as unknown as DyCollectDatabase;
    const api = await startApi(database, new DebugBrowserController());
    cleanups.push(api.close);

    const list = await fetch(`${api.baseUrl}/favorites?page=2`);
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual(page);
    expect(database.listFavoriteVideos).toHaveBeenCalledWith(2, 50);

    const detail = await fetch(`${api.baseUrl}/favorites/${favorite.awemeId}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      awemeId: favorite.awemeId,
      articleAvailable: false,
      markdown: null,
    });
  });
});

describe("maintenance API", () => {
  it("clears task logs and terminal tasks with deletion counts", async () => {
    const database = {
      clearJobLogs: vi.fn(() => ({ deletedLogs: 12 })),
      clearTerminalJobs: vi.fn(() => ({ deletedJobs: 4 })),
    } as unknown as DyCollectDatabase;
    const api = await startApi(database, new DebugBrowserController());
    cleanups.push(api.close);

    const logsResponse = await fetch(`${api.baseUrl}/maintenance/job-logs`, { method: "DELETE" });
    expect(logsResponse.status).toBe(200);
    expect(await logsResponse.json()).toEqual({ deletedLogs: 12 });

    const jobsResponse = await fetch(`${api.baseUrl}/maintenance/terminal-jobs`, { method: "DELETE" });
    expect(jobsResponse.status).toBe(200);
    expect(await jobsResponse.json()).toEqual({ deletedJobs: 4 });
  });

  it("returns a conflict without deleting logs while a task is active", async () => {
    const database = {
      clearJobLogs: vi.fn(() => null),
    } as unknown as DyCollectDatabase;
    const api = await startApi(database, new DebugBrowserController());
    cleanups.push(api.close);

    const response = await fetch(`${api.baseUrl}/maintenance/job-logs`, { method: "DELETE" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "job_active",
      message: expect.stringContaining("运行中或等待验证"),
    });
  });

  it("protects both maintenance writes from cross-origin requests", async () => {
    const database = {
      clearJobLogs: vi.fn(() => ({ deletedLogs: 0 })),
      clearTerminalJobs: vi.fn(() => ({ deletedJobs: 0 })),
    } as unknown as DyCollectDatabase;
    const api = await startApi(database, new DebugBrowserController());
    cleanups.push(api.close);

    const options = { method: "DELETE", headers: { Origin: "https://example.com" } };
    expect((await fetch(`${api.baseUrl}/maintenance/job-logs`, options)).status).toBe(403);
    expect((await fetch(`${api.baseUrl}/maintenance/terminal-jobs`, options)).status).toBe(403);
    expect(database.clearJobLogs).not.toHaveBeenCalled();
    expect(database.clearTerminalJobs).not.toHaveBeenCalled();
  });
});

describe("dashboard download progress", () => {
  it("includes the worker's transient progress in the snapshot", () => {
    const progress = {
      jobId: 3,
      awemeId: "7601484851720380913",
      title: "实时下载测试",
      receivedBytes: 1_048_576,
      totalBytes: 2_097_152,
      percent: 50,
      updatedAt: "2026-07-23T00:00:00.000Z",
    };
    const database = {
      getDashboard: vi.fn(() => ({
        activeJob: null,
        queuedJobs: [],
        recentJobs: [],
        logJobId: null,
        jobLogs: [],
      })),
    } as unknown as DyCollectDatabase;
    const snapshot = createDashboardSnapshot(
      database,
      new DebugBrowserController(),
      { getDownloadProgress: vi.fn(() => progress) },
    );
    expect(snapshot.downloadProgress).toEqual(progress);
  });
});

describe("dashboard event stream", () => {
  it("repeats the latest snapshot every second and stops after the response closes", async () => {
    vi.useFakeTimers();
    try {
      const request = new EventEmitter();
      const response = new EventEmitter() as EventEmitter & {
        status: ReturnType<typeof vi.fn>;
        setHeader: ReturnType<typeof vi.fn>;
        flushHeaders: ReturnType<typeof vi.fn>;
        write: ReturnType<typeof vi.fn>;
      };
      response.status = vi.fn(() => response);
      response.setHeader = vi.fn();
      response.flushHeaders = vi.fn();
      response.write = vi.fn();
      const database = fakeDatabase();
      const handler = createEventsHandler(
        database,
        new DebugBrowserController(),
        { getDownloadProgress: vi.fn(() => null) },
      );

      handler(request as never, response as never, vi.fn());
      expect(response.write).toHaveBeenCalledTimes(1);
      expect(response.write.mock.calls[0]?.[0]).toMatch(/^event: snapshot\ndata: /);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(response.write).toHaveBeenCalledTimes(3);
      expect(response.write.mock.calls.every(([chunk]) => String(chunk).startsWith("event: snapshot\ndata: "))).toBe(true);

      response.emit("close");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(response.write).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("deletion API", () => {
  it("deletes a creator and returns the deleted video count", async () => {
    const secUid = "creator-delete";
    const database = {
      getCreator: vi.fn(() => ({ secUid })),
      hasPendingJobForCreator: vi.fn(() => false),
    } as unknown as DyCollectDatabase;
    const deletionService = {
      deleteCreator: vi.fn(() => ({ deleted: true, secUid, deletedVideos: 3 })),
    } as unknown as DeletionService;
    const api = await startApi(database, new DebugBrowserController(), deletionService);
    cleanups.push(api.close);

    const response = await fetch(`${api.baseUrl}/creators/${secUid}`, { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true, secUid, deletedVideos: 3 });
    expect(deletionService.deleteCreator).toHaveBeenCalledWith(secUid);
  });

  it("returns 404 when a creator no longer exists", async () => {
    const database = { getCreator: vi.fn(() => null) } as unknown as DyCollectDatabase;
    const deletionService = { deleteCreator: vi.fn() } as unknown as DeletionService;
    const api = await startApi(database, new DebugBrowserController(), deletionService);
    cleanups.push(api.close);

    const response = await fetch(`${api.baseUrl}/creators/missing`, { method: "DELETE" });
    expect(response.status).toBe(404);
    expect(deletionService.deleteCreator).not.toHaveBeenCalled();
  });

  it("rejects deletion while the creator has a pending job", async () => {
    const secUid = "creator-busy";
    const database = {
      getCreator: vi.fn(() => ({ secUid })),
      hasPendingJobForCreator: vi.fn(() => true),
    } as unknown as DyCollectDatabase;
    const deletionService = { deleteCreator: vi.fn() } as unknown as DeletionService;
    const api = await startApi(database, new DebugBrowserController(), deletionService);
    cleanups.push(api.close);

    const response = await fetch(`${api.baseUrl}/creators/${secUid}`, { method: "DELETE" });
    expect(response.status).toBe(409);
    expect(deletionService.deleteCreator).not.toHaveBeenCalled();
  });

  it("deletes one video without deleting its creator", async () => {
    const awemeId = "7000000000000000501";
    const video = { awemeId, secUid: "creator-video" };
    const database = {
      getVideo: vi.fn(() => video),
      hasPendingJobForCreator: vi.fn(() => false),
    } as unknown as DyCollectDatabase;
    const deletionService = {
      deleteVideo: vi.fn(() => ({ deleted: true, awemeId, secUid: video.secUid })),
    } as unknown as DeletionService;
    const api = await startApi(database, new DebugBrowserController(), deletionService);
    cleanups.push(api.close);

    const response = await fetch(`${api.baseUrl}/videos/${awemeId}`, { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(deletionService.deleteVideo).toHaveBeenCalledWith(video);
  });

  it("deletes one favorite while the listener remains enabled", async () => {
    const awemeId = "7000000000000000601";
    const favorite = { awemeId };
    const database = {
      getFavoriteVideo: vi.fn(() => favorite),
      hasPendingFavoriteJob: vi.fn(() => false),
      getFavoriteListenerState: vi.fn(() => ({ enabled: true, status: "listening" })),
    } as unknown as DyCollectDatabase;
    const deletionService = {
      deleteFavoriteVideo: vi.fn(() => ({ deleted: true, awemeId })),
    } as unknown as DeletionService;
    const api = await startApi(database, new DebugBrowserController(), deletionService);
    cleanups.push(api.close);

    const response = await fetch(`${api.baseUrl}/favorites/${awemeId}`, { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(deletionService.deleteFavoriteVideo).toHaveBeenCalledWith(favorite);
  });

  it("rejects favorite deletion while that item has an active task", async () => {
    const awemeId = "7000000000000000602";
    const database = {
      getFavoriteVideo: vi.fn(() => ({ awemeId })),
      hasPendingFavoriteJob: vi.fn(() => true),
    } as unknown as DyCollectDatabase;
    const deletionService = {
      deleteFavoriteVideo: vi.fn(),
    } as unknown as DeletionService;
    const api = await startApi(database, new DebugBrowserController(), deletionService);
    cleanups.push(api.close);

    const response = await fetch(`${api.baseUrl}/favorites/${awemeId}`, { method: "DELETE" });
    expect(response.status).toBe(409);
    expect(deletionService.deleteFavoriteVideo).not.toHaveBeenCalled();
  });

  it("returns 404 when deleting a missing favorite", async () => {
    const database = {
      getFavoriteVideo: vi.fn(() => null),
    } as unknown as DyCollectDatabase;
    const deletionService = {
      deleteFavoriteVideo: vi.fn(),
    } as unknown as DeletionService;
    const api = await startApi(database, new DebugBrowserController(), deletionService);
    cleanups.push(api.close);

    const response = await fetch(`${api.baseUrl}/favorites/missing`, { method: "DELETE" });
    expect(response.status).toBe(404);
    expect(deletionService.deleteFavoriteVideo).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin delete request", async () => {
    const database = { getCreator: vi.fn() } as unknown as DyCollectDatabase;
    const deletionService = { deleteCreator: vi.fn() } as unknown as DeletionService;
    const api = await startApi(database, new DebugBrowserController(), deletionService);
    cleanups.push(api.close);

    const response = await fetch(`${api.baseUrl}/creators/creator-delete`, {
      method: "DELETE",
      headers: { Origin: "https://example.com" },
    });
    expect(response.status).toBe(403);
    expect(database.getCreator).not.toHaveBeenCalled();
  });
});

describe("Feishu API", () => {
  it("returns redacted settings and delegates settings, spaces and sync requests", async () => {
    const database = fakeDatabase();
    const feishuService = {
      getSettingsView: vi.fn(() => ({
        appId: "cli_test",
        appSecretConfigured: true,
        favoriteAutoSync: { enabled: false, spaceId: null },
        updatedAt: "2026-07-23T00:00:00.000Z",
      })),
      saveSettings: vi.fn(async () => ({
        appId: "cli_new",
        appSecretConfigured: true,
        favoriteAutoSync: { enabled: false, spaceId: null },
        updatedAt: "2026-07-23T00:01:00.000Z",
      })),
      saveFavoriteAutoSyncSettings: vi.fn(async () => ({
        appId: "cli_new",
        appSecretConfigured: true,
        favoriteAutoSync: { enabled: true, spaceId: "space-1" },
        updatedAt: "2026-07-23T00:02:00.000Z",
      })),
      listSpaces: vi.fn(async () => [{ spaceId: "space-1", name: "知识库", description: null }]),
      syncArticles: vi.fn(async () => ({ spaceId: "space-1", total: 1, synced: 1, skipped: 0, failed: 0, items: [] })),
    } as unknown as FeishuService;
    const api = await startApi(database, new DebugBrowserController(), undefined, feishuService);
    cleanups.push(api.close);

    const settingsResponse = await fetch(`${api.baseUrl}/settings/feishu`);
    expect(await settingsResponse.json()).toEqual({
      appId: "cli_test",
      appSecretConfigured: true,
      favoriteAutoSync: { enabled: false, spaceId: null },
      updatedAt: "2026-07-23T00:00:00.000Z",
    });

    const saveResponse = await fetch(`${api.baseUrl}/settings/feishu`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: "cli_new", appSecret: "new-secret" }),
    });
    expect(saveResponse.status).toBe(200);
    expect(feishuService.saveSettings).toHaveBeenCalledWith("cli_new", "new-secret");

    const favoriteSettingsResponse = await fetch(`${api.baseUrl}/settings/feishu/favorites`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, spaceId: "space-1" }),
    });
    expect(favoriteSettingsResponse.status).toBe(200);
    expect(feishuService.saveFavoriteAutoSyncSettings).toHaveBeenCalledWith(true, "space-1");

    expect((await fetch(`${api.baseUrl}/feishu/spaces`)).status).toBe(200);
    const syncResponse = await fetch(`${api.baseUrl}/feishu/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "favorite",
        spaceId: "space-1",
        awemeIds: ["7601484851720380999"],
      }),
    });
    expect(syncResponse.status).toBe(200);
    expect(feishuService.syncArticles).toHaveBeenCalledWith(
      "favorite",
      "space-1",
      ["7601484851720380999"],
    );
  });

  it("rejects an invalid sync source and protects favorite settings from cross-origin writes", async () => {
    const database = fakeDatabase();
    const feishuService = {
      syncArticles: vi.fn(),
      saveFavoriteAutoSyncSettings: vi.fn(),
    } as unknown as FeishuService;
    const api = await startApi(database, new DebugBrowserController(), undefined, feishuService);
    cleanups.push(api.close);

    const invalidSync = await fetch(`${api.baseUrl}/feishu/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        spaceId: "space-1",
        awemeIds: ["7601484851720380999"],
      }),
    });
    expect(invalidSync.status).toBe(400);
    expect(feishuService.syncArticles).not.toHaveBeenCalled();

    const crossOrigin = await fetch(`${api.baseUrl}/settings/feishu/favorites`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://example.com",
      },
      body: JSON.stringify({ enabled: true, spaceId: "space-1" }),
    });
    expect(crossOrigin.status).toBe(403);
    expect(feishuService.saveFavoriteAutoSyncSettings).not.toHaveBeenCalled();
  });
});
