import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Router, type Request, type RequestHandler, type Response } from "express";
import type {
  DashboardSnapshot,
  AsrDevice,
  FeishuSyncRequest,
  UpdateFavoriteFeishuAutoSyncRequest,
} from "@dycollect/shared";
import { DATA_DIR } from "./config.js";
import { AsrSettingsService, isAsrDevice } from "./asr-settings.js";
import { DyCollectDatabase } from "./db.js";
import { DeletionService } from "./deletion.js";
import type { DebugBrowserController } from "./debug-browser.js";
import { AppError } from "./errors.js";
import { FeishuService } from "./feishu.js";
import { FavoriteMonitor } from "./favorite-monitor.js";
import { ModelStatusService } from "./model-status.js";
import { parseProfileUrl, resolveWithin } from "./utils.js";
import type { CrawlWorker } from "./worker.js";

export function createApi(
  database: DyCollectDatabase,
  worker: CrawlWorker,
  debugBrowser: DebugBrowserController,
  deletionService = new DeletionService(database),
  feishuService = new FeishuService(database),
  favoriteMonitor = new FavoriteMonitor(database),
  modelStatus = new ModelStatusService(),
  asrSettings = new AsrSettingsService(database),
): Router {
  const router = Router();

  router.get("/dashboard", (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json(createDashboardSnapshot(database, debugBrowser, worker));
  });

  router.get("/system/model", async (_request, response, next) => {
    try {
      response.setHeader("Cache-Control", "no-store");
      response.json(await modelStatus.getStatus(true));
    } catch (error) {
      next(error);
    }
  });

  router.post("/jobs", sameOrigin, async (request, response, next) => {
    try {
      await modelStatus.assertReady();
      if (debugBrowser.isActive()) {
        return response.status(409).json({
          error: "debug_browser_active",
          message: "请先在采集主机关闭抖音调试浏览器，再提交任务",
        });
      }
      const listener = database.getFavoriteListenerState();
      if (listener.enabled || database.hasPendingJobs("favorite")) {
        return response.status(409).json({
          error: "favorite_mode_active",
          message: "收藏监听模式正在运行或仍有收藏任务待处理，请停止监听并等待收藏任务结束",
        });
      }
      const profile = parseProfileUrl(String(request.body?.profileUrl ?? ""));
      const targetCount = Number(request.body?.targetCount);
      if (!Number.isInteger(targetCount) || targetCount < 1 || targetCount > 10_000) {
        throw new AppError("parse_error", "目标数量必须是 1 到 10000 的整数");
      }
      const job = database.createJob(profile.profileUrl, profile.secUid, targetCount, Boolean(request.body?.retryPermanent));
      response.status(201).json(job);
    } catch (error) {
      next(error);
    }
  });

  router.get("/jobs", (request, response) => {
    const page = Math.max(1, Number.parseInt(String(request.query.page ?? "1"), 10) || 1);
    response.json(database.listJobs(page, 5));
  });

  router.get("/favorites/listener", (_request, response) => {
    response.json(database.getFavoriteListenerState());
  });

  router.post("/favorites/listener/start", sameOrigin, async (_request, response, next) => {
    try {
      await modelStatus.assertReady();
      const current = database.getFavoriteListenerState();
      if (current.enabled) {
        return response.status(409).json({
          error: "favorite_listener_active",
          message: "收藏监听已经启动",
        });
      }
      if (debugBrowser.isActive()) {
        return response.status(409).json({
          error: "debug_browser_active",
          message: "请先关闭抖音调试浏览器，再启动收藏监听",
        });
      }
      if (database.hasPendingJobs("creator")) {
        return response.status(409).json({
          error: "creator_mode_active",
          message: "存在人物采集任务，请等待任务完成或取消后再启动收藏监听",
        });
      }
      response.status(202).json(favoriteMonitor.start());
    } catch (error) {
      next(error);
    }
  });

  router.post("/favorites/listener/stop", sameOrigin, async (_request, response, next) => {
    try {
      response.json(await favoriteMonitor.stop());
    } catch (error) {
      next(error);
    }
  });

  router.post("/favorites/listener/resume", sameOrigin, async (_request, response, next) => {
    try {
      await modelStatus.assertReady();
      const current = database.getFavoriteListenerState();
      if (!current.enabled || !["waiting_verification", "error"].includes(current.status)) {
        return response.status(409).json({
          error: "favorite_listener_not_paused",
          message: "收藏监听当前不需要恢复",
        });
      }
      response.json(await favoriteMonitor.resume());
    } catch (error) {
      next(error);
    }
  });

  router.get("/favorites", (request, response) => {
    const page = Math.max(1, Number.parseInt(String(request.query.page ?? "1"), 10) || 1);
    response.json(database.listFavoriteVideos(page, 50));
  });

  router.get("/favorites/:awemeId", async (request, response, next) => {
    try {
      const favorite = database.getFavoriteVideo(param(request.params.awemeId));
      if (!favorite) {
        return response.status(404).json({ error: "not_found", message: "收藏作品不存在" });
      }
      let markdown: string | null = null;
      let articleAvailable = false;
      if (favorite.status === "completed" && favorite.markdownPath) {
        const dataFile = resolveWithin(DATA_DIR, favorite.markdownPath);
        const articleRoot = resolve(DATA_DIR, "favorites", "articles");
        const file = dataFile && resolveWithin(articleRoot, dataFile) ? dataFile : null;
        if (file) {
          articleAvailable = await access(file).then(() => true, () => false);
          if (articleAvailable) markdown = await readFile(file, "utf8");
        }
      }
      response.json({ ...favorite, markdown, articleAvailable });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/favorites/:awemeId", sameOrigin, async (request, response, next) => {
    try {
      const awemeId = param(request.params.awemeId);
      const favorite = database.getFavoriteVideo(awemeId);
      if (!favorite) {
        return response.status(404).json({ error: "not_found", message: "收藏作品不存在" });
      }
      if (database.hasPendingFavoriteJob(awemeId)) {
        return response.status(409).json({
          error: "favorite_job_active",
          message: "该收藏作品存在排队、运行中或等待验证的任务，请先等待任务完成或取消任务",
        });
      }
      response.json(await deletionService.deleteFavoriteVideo(favorite));
    } catch (error) {
      next(error);
    }
  });

  router.post("/browser/debug/open", sameOrigin, async (_request, response, next) => {
    try {
      const jobs = database.getDashboard();
      if (jobs.activeJob || jobs.queuedJobs.length > 0 || jobs.favoriteListener.enabled) {
        return response.status(409).json({
          error: "jobs_pending",
          message: "存在运行中或排队任务，暂时不能打开抖音调试浏览器",
        });
      }
      response.json(await debugBrowser.open());
    } catch (error) {
      next(error);
    }
  });

  router.get("/jobs/:jobId", (request, response) => {
    const job = database.getJob(parseId(param(request.params.jobId)));
    if (!job) return response.status(404).json({ error: "not_found", message: "任务不存在" });
    response.json(job);
  });

  router.delete("/jobs/:jobId", sameOrigin, (request, response) => {
    const id = parseId(param(request.params.jobId));
    const job = database.getJob(id);
    if (!job) return response.status(404).json({ error: "not_found", message: "任务不存在" });
    if (!["completed", "completed_partial", "cancelled", "failed"].includes(job.status)) {
      return response.status(409).json({
        error: "job_active",
        message: "请先取消任务并等待任务结束后再删除",
      });
    }
    if (!database.deleteJob(id)) {
      return response.status(409).json({ error: "job_active", message: "任务状态已变化，请刷新后重试" });
    }
    response.json({ deleted: true, jobId: id });
  });

  router.post("/jobs/:jobId/cancel", sameOrigin, (request, response) => {
    const id = parseId(param(request.params.jobId));
    const job = database.cancelJob(id);
    if (!job) return response.status(404).json({ error: "not_found", message: "任务不存在" });
    worker.cancelActive(id);
    response.json(job);
  });

  router.post("/jobs/:jobId/resume", sameOrigin, async (request, response, next) => {
    try {
      await modelStatus.assertReady();
      const job = database.resumeJob(parseId(param(request.params.jobId)));
      if (!job) return response.status(404).json({ error: "not_found", message: "任务不存在" });
      response.json(job);
    } catch (error) {
      next(error);
    }
  });

  router.get("/creators", (_request, response) => {
    response.json(database.listCreators());
  });

  router.get("/settings/feishu", (_request, response) => {
    response.json(feishuService.getSettingsView());
  });

  router.get("/settings/asr", async (_request, response, next) => {
    try {
      response.setHeader("Cache-Control", "no-store");
      response.json(await asrSettings.getView());
    } catch (error) {
      next(error);
    }
  });

  router.put("/settings/asr", sameOrigin, async (request, response, next) => {
    try {
      const device = request.body?.device as AsrDevice | undefined;
      if (!isAsrDevice(device)) throw new AppError("parse_error", "转录设备设置无效");
      const dashboard = database.getDashboard();
      if (dashboard.activeJob || dashboard.queuedJobs.length > 0 || dashboard.favoriteListener.enabled) {
        return response.status(409).json({
          error: "jobs_pending",
          message: "存在运行中或排队任务，或收藏监听仍在启用，暂时不能切换转录设备",
        });
      }
      response.json(await asrSettings.saveDevice(device));
    } catch (error) {
      next(error);
    }
  });

  router.put("/settings/feishu", sameOrigin, async (request, response, next) => {
    try {
      const appSecret = typeof request.body?.appSecret === "string" ? request.body.appSecret : undefined;
      response.json(await feishuService.saveSettings(String(request.body?.appId ?? ""), appSecret));
    } catch (error) {
      next(error);
    }
  });

  router.put("/settings/feishu/favorites", sameOrigin, async (request, response, next) => {
    try {
      const input = request.body as Partial<UpdateFavoriteFeishuAutoSyncRequest> | undefined;
      if (typeof input?.enabled !== "boolean") {
        throw new AppError("parse_error", "自动同步开关无效");
      }
      const spaceId = input.spaceId === null
        ? null
        : typeof input.spaceId === "string"
          ? input.spaceId
          : null;
      response.json(await feishuService.saveFavoriteAutoSyncSettings(input.enabled, spaceId));
    } catch (error) {
      next(error);
    }
  });

  router.delete("/maintenance/job-logs", sameOrigin, (_request, response) => {
    const result = database.clearJobLogs();
    if (!result) {
      return response.status(409).json({
        error: "job_active",
        message: "存在运行中或等待验证的任务，请等待任务结束或取消任务后再清除日志",
      });
    }
    response.json(result);
  });

  router.delete("/maintenance/terminal-jobs", sameOrigin, (_request, response) => {
    response.json(database.clearTerminalJobs());
  });

  router.get("/feishu/spaces", async (_request, response, next) => {
    try {
      response.json(await feishuService.listSpaces());
    } catch (error) {
      next(error);
    }
  });

  router.post("/feishu/sync", sameOrigin, async (request, response, next) => {
    try {
      const input = request.body as Partial<FeishuSyncRequest> | undefined;
      if (input?.source !== "creator" && input?.source !== "favorite") {
        return response.status(400).json({
          error: "parse_error",
          message: "飞书同步来源无效",
        });
      }
      response.json(await feishuService.syncArticles(
        input.source,
        String(input?.spaceId ?? ""),
        Array.isArray(input?.awemeIds) ? input.awemeIds.map(String) : [],
      ));
    } catch (error) {
      next(error);
    }
  });

  router.get("/creators/:secUid", (request, response) => {
    const creator = database.getCreator(param(request.params.secUid));
    if (!creator) return response.status(404).json({ error: "not_found", message: "人物不存在" });
    response.json(creator);
  });

  router.delete("/creators/:secUid", sameOrigin, async (request, response, next) => {
    try {
      const secUid = param(request.params.secUid);
      if (!database.getCreator(secUid)) {
        return response.status(404).json({ error: "not_found", message: "人物不存在" });
      }
      if (database.hasPendingJobForCreator(secUid)) {
        return response.status(409).json({
          error: "creator_job_active",
          message: "该人物存在排队、运行中或等待验证的任务，请先完成或取消任务",
        });
      }
      response.json(await deletionService.deleteCreator(secUid));
    } catch (error) {
      next(error);
    }
  });

  router.get("/creators/:secUid/videos", (request, response) => {
    const page = Math.max(1, Number.parseInt(String(request.query.page ?? "1"), 10) || 1);
    const secUid = param(request.params.secUid);
    if (!database.getCreator(secUid)) {
      return response.status(404).json({ error: "not_found", message: "人物不存在" });
    }
    response.json(database.listVideos(secUid, page, 50));
  });

  router.get("/articles/:awemeId", async (request, response, next) => {
    try {
      const video = database.getVideo(param(request.params.awemeId));
      if (!video) return response.status(404).json({ error: "not_found", message: "作品不存在" });
      let markdown: string | null = null;
      let articleAvailable = false;
      if (video.status === "completed" && video.markdownPath) {
        const dataFile = resolveWithin(DATA_DIR, video.markdownPath);
        const articleRoot = resolve(DATA_DIR, video.secUid, "articles");
        const file = dataFile && resolveWithin(articleRoot, dataFile) ? dataFile : null;
        if (file) {
          articleAvailable = await access(file).then(() => true, () => false);
          if (articleAvailable) markdown = await readFile(file, "utf8");
        }
      }
      response.json({ ...video, markdown, articleAvailable });
    } catch (error) {
      next(error);
    }
  });

  router.delete("/videos/:awemeId", sameOrigin, async (request, response, next) => {
    try {
      const awemeId = param(request.params.awemeId);
      const video = database.getVideo(awemeId);
      if (!video) {
        return response.status(404).json({ error: "not_found", message: "作品不存在" });
      }
      if (database.hasPendingJobForCreator(video.secUid)) {
        return response.status(409).json({
          error: "creator_job_active",
          message: "该人物存在排队、运行中或等待验证的任务，请先完成或取消任务",
        });
      }
      response.json(await deletionService.deleteVideo(video));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export function createEventsHandler(
  database: DyCollectDatabase,
  debugBrowser: DebugBrowserController,
  worker: Pick<CrawlWorker, "getDownloadProgress">,
): RequestHandler {
  return (request, response) => {
    response.status(200);
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders();
    const send = () => {
      const json = JSON.stringify(createDashboardSnapshot(database, debugBrowser, worker));
      response.write(`event: snapshot\ndata: ${json}\n\n`);
    };
    send();
    const timer = setInterval(send, 1_000);
    const cleanup = () => clearInterval(timer);
    response.once("close", cleanup);
    request.once("aborted", cleanup);
  };
}

export function createDashboardSnapshot(
  database: DyCollectDatabase,
  debugBrowser: DebugBrowserController,
  worker: Pick<CrawlWorker, "getDownloadProgress">,
): DashboardSnapshot {
  return {
    ...database.getDashboard(),
    downloadProgress: worker.getDownloadProgress(),
    debugBrowser: debugBrowser.getState(),
  };
}

function parseId(value: string): number {
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : -1;
}

function param(value: string | string[]): string {
  return Array.isArray(value) ? value[0] ?? "" : value;
}

function sameOrigin(request: Request, response: Response, next: () => void): void {
  const origin = request.get("origin");
  if (!origin) return next();
  try {
    const originUrl = new URL(origin);
    const forwardedHost = request.get("x-forwarded-host")?.split(",")[0]?.trim();
    const expectedHost = forwardedHost || request.get("host");
    if (originUrl.host !== expectedHost) {
      response.status(403).json({ error: "forbidden_origin", message: "拒绝跨站写请求" });
      return;
    }
  } catch {
    response.status(403).json({ error: "forbidden_origin", message: "请求来源无效" });
    return;
  }
  next();
}
