import { access, rm } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type {
  CrawlJob,
  CreatorCrawlJob,
  DownloadProgress,
  FavoriteCrawlJob,
  FavoriteVideoRecord,
  JobLog,
  JobLogLevel,
  JobLogStage,
  VideoRecord,
  VideoStatus,
} from "@dycollect/shared";
import { BROWSER_PROFILE_DIR, DATA_DIR } from "./config.js";
import { DyCollectDatabase } from "./db.js";
import { DouyinSession, type DownloadResult, type ProfileSnapshot, type ProfileWork } from "./douyin.js";
import { AppError, PERMANENT_FAILURES, toAppError } from "./errors.js";
import type { DebugBrowserController } from "./debug-browser.js";
import type { FeishuService } from "./feishu.js";
import { FavoriteMonitor } from "./favorite-monitor.js";
import { ModelStatusService } from "./model-status.js";
import { transcribeToMarkdown } from "./transcriber.js";
import {
  abortableSleep,
  decodePublishedAt,
  formatElapsedDuration,
  parseProfileUrl,
  randomInterVideoDelayMs,
  sleep,
} from "./utils.js";

type ExistingVideoDisposition = "duplicate" | "historical_failure" | "attempt";

export function classifyExistingVideo(
  existing: Pick<VideoRecord, "status" | "failureCategory"> | null,
  retryPermanent: boolean,
): ExistingVideoDisposition {
  if (existing?.status === "completed") return "duplicate";
  if (
    existing?.status === "failed"
    && existing.failureCategory
    && PERMANENT_FAILURES.has(existing.failureCategory as never)
    && !retryPermanent
  ) return "historical_failure";
  return "attempt";
}

export function hasReachedTarget(job: Pick<CrawlJob, "processedCount" | "targetCount">): boolean {
  return job.processedCount >= job.targetCount;
}

export class InterVideoGate {
  private hasAttemptedVideo = false;

  constructor(
    private readonly random: () => number = Math.random,
    private readonly wait: (ms: number, signal?: AbortSignal) => Promise<void> = abortableSleep,
    private readonly log: (message: string) => void = console.log,
  ) {}

  async beforeAttempt(
    jobId: number,
    awemeId: string,
    signal: AbortSignal,
    onWaiting: (delayMs: number) => void,
  ): Promise<number> {
    if (!this.hasAttemptedVideo) {
      this.hasAttemptedVideo = true;
      return 0;
    }
    const delayMs = randomInterVideoDelayMs(this.random);
    onWaiting(delayMs);
    this.log(`[任务 #${jobId}] 下一个作品 ${awemeId} 前随机等待 ${(delayMs / 1_000).toFixed(3)} 秒`);
    const startedAt = Date.now();
    await this.wait(delayMs, signal);
    this.log(`[任务 #${jobId}] 随机等待结束，实际等待 ${((Date.now() - startedAt) / 1_000).toFixed(3)} 秒`);
    return delayMs;
  }
}

export class CrawlWorker {
  private stopped = false;
  private loopPromise: Promise<void> | null = null;
  private activeJobId: number | null = null;
  private abortController: AbortController | null = null;
  private downloadProgress: DownloadProgress | null = null;

  constructor(
    private readonly database: DyCollectDatabase,
    private readonly debugBrowser: DebugBrowserController,
    private readonly favoriteMonitor: FavoriteMonitor = new FavoriteMonitor(database),
    private readonly feishuService?: Pick<FeishuService, "syncArticles">,
    private readonly modelStatus: Pick<ModelStatusService, "isReady"> = new ModelStatusService(),
  ) {}

  start(): void {
    if (this.loopPromise) return;
    this.database.recoverInterruptedJobs();
    this.loopPromise = this.runLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abortController?.abort();
    await this.loopPromise;
  }

  cancelActive(jobId: number): void {
    if (this.activeJobId === jobId) this.abortController?.abort();
  }

  getDownloadProgress(): DownloadProgress | null {
    return this.downloadProgress ? { ...this.downloadProgress } : null;
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      if (!await this.modelStatus.isReady()) {
        await sleep(1_000);
        continue;
      }
      if (this.debugBrowser.isActive()) {
        await sleep(250);
        continue;
      }
      const job = this.database.claimNextJob();
      if (!job) {
        await sleep(750);
        continue;
      }
      this.activeJobId = job.id;
      this.abortController = new AbortController();
      const resumed = this.database.listJobLogs(job.id).length > 0;
      this.log(job.id, "info", "task", resumed ? "任务恢复运行" : "任务开始运行");
      try {
        if (job.mode === "favorite") {
          await this.processFavoriteJob(job, this.abortController.signal);
        } else {
          await this.processJob(job, this.abortController.signal);
        }
      } catch (error) {
        const appError = toAppError(error);
        if (appError.category === "cancelled" || this.database.isCancelRequested(job.id)) {
          this.database.updateJob(job.id, {
            status: "cancelled", stage: "waiting", currentAwemeId: null,
            finishedAt: new Date().toISOString(), errorCategory: null, errorMessage: null,
          });
          this.log(job.id, "warning", "completed", "任务已取消");
        } else {
          this.database.updateJob(job.id, {
            status: "failed", stage: "waiting", currentAwemeId: null,
            finishedAt: new Date().toISOString(), errorCategory: appError.category,
            errorMessage: appError.message,
          });
          this.log(job.id, "error", "completed", `任务失败：${appError.message}`);
        }
      } finally {
        this.downloadProgress = null;
        this.activeJobId = null;
        this.abortController = null;
      }
    }
  }

  private async processJob(initialJob: CreatorCrawlJob, signal: AbortSignal): Promise<void> {
    const parsed = parseProfileUrl(initialJob.profileUrl);
    const session = new DouyinSession(BROWSER_PROFILE_DIR);
    const knownIds = new Set<string>(this.database.listJobVideoIds(initialJob.id));
    const interVideoGate = new InterVideoGate();
    let stagnantPasses = 0;
    let snapshot: ProfileSnapshot;
    try {
      this.log(initialJob.id, "info", "discovering", "正在加载人物主页");
      snapshot = await this.openWithVerification(session, initialJob.id, parsed.profileUrl, signal);
      const nickname = snapshot.nickname || initialJob.creatorNickname || parsed.secUid.slice(-10);
      this.database.upsertCreator(parsed.secUid, parsed.profileUrl, nickname, snapshot.displayedPostCount);
      this.database.updateJob(initialJob.id, { creatorNickname: nickname, stage: "discovering" });
      this.log(
        initialJob.id,
        "success",
        "discovering",
        `人物主页加载完成：${nickname}，当前页面发现 ${snapshot.works.length} 个作品`,
      );

      while (!signal.aborted) {
        this.throwIfCancelled(initialJob.id, signal);
        const currentJob = this.database.getJob(initialJob.id)!;
        if (hasReachedTarget(currentJob)) break;

        const newWorks = snapshot.works.filter((work) => !knownIds.has(work.awemeId));
        for (const work of newWorks) {
          knownIds.add(work.awemeId);
          this.database.incrementDiscoveredCount(initialJob.id);
          this.log(
            initialJob.id,
            "info",
            "discovering",
            `发现${formatWorkLabel(work)}`,
            work.awemeId,
          );
          await this.processWork(initialJob.id, parsed.secUid, nickname, work, session, interVideoGate, signal);
          const refreshed = this.database.getJob(initialJob.id)!;
          if (hasReachedTarget(refreshed)) break;
          this.throwIfCancelled(initialJob.id, signal);
        }

        const refreshed = this.database.getJob(initialJob.id)!;
        if (hasReachedTarget(refreshed)) break;
        this.database.updateJob(initialJob.id, { stage: "discovering", currentAwemeId: null });
        this.log(initialJob.id, "info", "discovering", "当前作品不足，继续扫描人物主页");
        const more = await session.scrollForMore(knownIds);
        snapshot = more.snapshot;
        stagnantPasses = more.changed ? 0 : stagnantPasses + 1;
        if (stagnantPasses >= 3) break;
      }

      this.throwIfCancelled(initialJob.id, signal);
      this.finalizeJob(initialJob);
    } finally {
      await session.close();
    }
  }

  private async processFavoriteJob(initialJob: FavoriteCrawlJob, signal: AbortSignal): Promise<void> {
    const awemeId = initialJob.sourceAwemeId;
    if (!awemeId) throw new AppError("interface_error", "收藏任务缺少作品 ID");
    const favorite = this.database.getFavoriteVideo(awemeId);
    if (!favorite) throw new AppError("interface_error", "收藏任务对应的作品记录不存在");
    const session = await this.favoriteMonitor.acquireProcessingSession();
    try {
      const work: ProfileWork = {
        awemeId,
        title: favorite.title,
        url: favorite.sourceUrl,
      };
      this.database.updateJob(initialJob.id, {
        stage: "discovering",
        currentAwemeId: awemeId,
      });
      this.log(initialJob.id, "info", "discovering", `开始处理新增收藏${formatWorkLabel(work)}`, awemeId);
      await this.processWork(
        initialJob.id,
        "favorites",
        favorite.author || "我的收藏",
        work,
        session,
        new InterVideoGate(),
        signal,
      );
      this.throwIfCancelled(initialJob.id, signal);
      this.finalizeJob(initialJob);
    } finally {
      await this.favoriteMonitor.releaseProcessingSession(session);
    }
  }

  private finalizeJob(initialJob: CrawlJob): void {
    const finalJob = this.database.getJob(initialJob.id)!;
    const finalStatus = hasReachedTarget(finalJob) ? "completed" : "completed_partial";
    this.database.updateJob(initialJob.id, { stage: "finalizing", currentAwemeId: null });
    this.log(initialJob.id, "info", "completed", "正在整理任务结果");
    const finishedAt = new Date().toISOString();
    this.database.updateJob(initialJob.id, {
      status: finalStatus,
      stage: "finalizing",
      currentAwemeId: null,
      finishedAt,
    });
    const taskDuration = formatElapsedDuration(elapsedBetween(initialJob.startedAt, finishedAt));
    this.log(
      initialJob.id,
      finalStatus === "completed" ? "success" : "warning",
      "completed",
      finalStatus === "completed"
        ? `任务完成：成功 ${finalJob.completedCount} 个，失败 ${finalJob.failedCount} 个，跳过重复 ${finalJob.duplicateCount} 个（任务耗时 ${taskDuration}）`
        : `任务部分完成：成功 ${finalJob.completedCount} 个，失败 ${finalJob.failedCount} 个，跳过重复 ${finalJob.duplicateCount} 个（任务耗时 ${taskDuration}）`,
    );
  }

  private async processWork(
    jobId: number,
    secUid: string,
    nickname: string,
    work: ProfileWork,
    session: DouyinSession,
    interVideoGate: InterVideoGate,
    signal: AbortSignal,
  ): Promise<void> {
    const job = this.database.getJob(jobId)!;
    const isFavorite = job.mode === "favorite";
    const existing = isFavorite
      ? this.database.getFavoriteVideo(work.awemeId)
      : this.database.getVideo(work.awemeId);
    const updateStoredVideo = (
      fields: Partial<{
        title: string;
        author: string;
        publishedAt: string | null;
        publishedAtSource: "aweme_id" | "media" | "unknown";
        status: VideoStatus;
        failureCategory: string | null;
        failureReason: string | null;
        markdownPath: string | null;
        mediaPath: string | null;
        completedAt: string | null;
      }>,
      incrementAttempts = false,
    ) => {
      if (isFavorite) {
        this.database.updateFavoriteVideo(work.awemeId, fields, incrementAttempts);
      } else {
        this.database.updateVideo(work.awemeId, fields, incrementAttempts);
      }
    };
    const getStoredVideo = (): VideoRecord | FavoriteVideoRecord => {
      const stored = isFavorite
        ? this.database.getFavoriteVideo(work.awemeId)
        : this.database.getVideo(work.awemeId);
      if (!stored) throw new AppError("interface_error", "作品记录不存在");
      return stored;
    };
    const disposition = classifyExistingVideo(existing, job.retryPermanent);
    if (disposition === "duplicate") {
      this.database.recordJobVideo(jobId, work.awemeId, "skipped");
      this.log(jobId, "warning", "skipped", `${formatWorkLabel(work)}已经收集完成，自动跳过`, work.awemeId);
      return;
    }
    if (disposition === "historical_failure") {
      this.database.recordJobVideo(jobId, work.awemeId, "failed", existing?.failureCategory ?? null);
      this.log(
        jobId,
        "warning",
        "skipped",
        `${formatWorkLabel(work)}存在不重试的历史失败记录，自动跳过`,
        work.awemeId,
      );
      return;
    }

    await interVideoGate.beforeAttempt(jobId, work.awemeId, signal, (delayMs) => {
      this.database.updateJob(jobId, { stage: "waiting", currentAwemeId: work.awemeId });
      this.log(
        jobId,
        "info",
        "waiting",
        `${formatWorkLabel(work)}将在 ${(delayMs / 1_000).toFixed(0)} 秒后开始处理`,
        work.awemeId,
      );
    });
    const workStartedAt = performance.now();

    const publishedAt = existing?.publishedAt ?? decodePublishedAt(work.awemeId);
    let video: VideoRecord | FavoriteVideoRecord = isFavorite
      ? this.database.upsertDiscoveredFavorite({
          awemeId: work.awemeId,
          title: work.title,
          author: nickname === "我的收藏" ? "" : nickname,
          sourceUrl: work.url,
          publishedAt,
          publishedAtSource: publishedAt ? "aweme_id" : "unknown",
        })
      : this.database.upsertDiscoveredVideo({
          awemeId: work.awemeId,
          secUid,
          title: work.title,
          author: nickname,
          sourceUrl: work.url,
          publishedAt,
          publishedAtSource: publishedAt ? "aweme_id" : "unknown",
        });

    try {
      this.database.updateJob(jobId, { currentAwemeId: work.awemeId });
      let mediaFile = await this.existingMediaPath(video);
      if (!mediaFile) {
        this.database.updateJob(jobId, { stage: "downloading" });
        const downloadMessage = `${formatWorkLabel(work)}开始下载`;
        const downloadLog = this.log(jobId, "info", "downloading", downloadMessage, work.awemeId);
        const downloadStartedAt = performance.now();
        updateStoredVideo({
          status: "downloading", failureCategory: null, failureReason: null,
        }, true);
        const outputDir = resolve(DATA_DIR, secUid, "work");
        this.updateDownloadProgress(jobId, work.awemeId, work.title, 0, null);
        let download: DownloadResult;
        try {
          download = await this.retryAfterVerification(
            jobId,
            session,
            () => session.download(
              work.awemeId,
              outputDir,
              signal,
              ({ receivedBytes, totalBytes }) => {
                this.updateDownloadProgress(
                  jobId,
                  work.awemeId,
                  work.title,
                  receivedBytes,
                  totalBytes,
                );
              },
            ),
            signal,
          );
          mediaFile = download.path;
          const resolvedTitle = work.title || download.title || `无标题_${work.awemeId}`;
          const resolvedAuthor = download.author || nickname;
          let resolvedPublishedAt = publishedAt;
          let source: VideoRecord["publishedAtSource"] = publishedAt ? "aweme_id" : "unknown";
          if (!resolvedPublishedAt && isReasonableMediaTime(download.mediaCreationTime)) {
            resolvedPublishedAt = download.mediaCreationTime;
            source = "media";
          }
          updateStoredVideo({
            title: resolvedTitle,
            author: resolvedAuthor,
            publishedAt: resolvedPublishedAt,
            publishedAtSource: source,
            status: "downloaded",
            mediaPath: relative(DATA_DIR, mediaFile),
          });
          video = getStoredVideo();
          this.log(
            jobId,
            "success",
            "downloading",
            `${formatWorkLabel({ ...work, title: resolvedTitle })}下载完成（${formatByteSize(download.sizeBytes)}，耗时 ${formatElapsedDuration(performance.now() - downloadStartedAt)}）`,
            work.awemeId,
          );
        } catch (error) {
          this.database.updateJobLogMessage(
            jobId,
            downloadLog.id,
            sanitizeLogMessage(`${downloadMessage}（耗时 ${formatElapsedDuration(performance.now() - downloadStartedAt)}）`),
          );
          throw error;
        } finally {
          this.clearDownloadProgress(jobId, work.awemeId);
        }
      } else {
        this.log(jobId, "info", "downloading", `${formatWorkLabel(work)}复用已下载的视频文件`, work.awemeId);
      }

      this.throwIfCancelled(jobId, signal);
      this.database.updateJob(jobId, { stage: "transcribing" });
      updateStoredVideo({ status: "transcribing", failureCategory: null, failureReason: null });
      const resolvedWork = { ...work, title: video.title || work.title };
      const stageLogIds: Partial<Record<"extracting_audio" | "transcribing", number>> = {};
      const article = await transcribeToMarkdown({
        mediaFile,
        dataRoot: DATA_DIR,
        secUid,
        awemeId: work.awemeId,
        title: video.title || work.title || `无标题_${work.awemeId}`,
        author: video.author || nickname,
        publishedAt: video.publishedAt,
        sourceUrl: work.url,
        signal,
        onStage: (event) => {
          const isExtracting = event.stage === "extracting_audio";
          const message = `${formatWorkLabel(resolvedWork)}${isExtracting ? "开始提取音频" : "开始语音转录"}`;
          if (event.status === "started") {
            const log = this.log(
              jobId,
              "info",
              isExtracting ? "extracting_audio" : "transcribing",
              message,
              work.awemeId,
            );
            stageLogIds[event.stage] = log.id;
            return;
          }
          const logId = stageLogIds[event.stage];
          if (logId !== undefined) {
            this.database.updateJobLogMessage(
              jobId,
              logId,
              sanitizeLogMessage(`${message}（耗时 ${formatElapsedDuration(event.durationMs)}）`),
            );
          }
        },
      });
      const completedAt = new Date().toISOString();
      let completedMediaPath = getStoredVideo().mediaPath;
      await rm(mediaFile, { force: true }).then(
        () => { completedMediaPath = null; },
        () => undefined,
      );
      this.database.completeVideoForJob({
        jobId,
        awemeId: work.awemeId,
        source: isFavorite ? "favorite" : "creator",
        markdownPath: article.markdownPath,
        mediaPath: completedMediaPath,
        completedAt,
      });
      this.log(
        jobId,
        "success",
        "completed",
        `${formatWorkLabel(resolvedWork)}转录文章已生成（作品总耗时 ${formatElapsedDuration(performance.now() - workStartedAt)}）`,
        work.awemeId,
      );
      if (isFavorite) {
        await this.autoSyncFavorite(jobId, work.awemeId, resolvedWork);
      }
    } catch (error) {
      const appError = toAppError(error);
      if (appError.category === "cancelled") throw appError;
      if (appError.category === "risk_verify") throw appError;
      this.database.failVideoForJob({
        jobId,
        awemeId: work.awemeId,
        source: isFavorite ? "favorite" : "creator",
        errorCategory: appError.category,
        errorMessage: appError.message,
      });
      this.log(
        jobId,
        "error",
        "completed",
        `${formatWorkLabel(work)}处理失败：${appError.message}`,
        work.awemeId,
      );
    }
  }

  private async autoSyncFavorite(
    jobId: number,
    awemeId: string,
    work: Pick<ProfileWork, "awemeId" | "title">,
  ): Promise<void> {
    const settings = this.database.getFavoriteFeishuAutoSyncSettings();
    if (!settings.enabled) return;
    if (!settings.spaceId) {
      this.log(
        jobId,
        "warning",
        "completed",
        `${formatWorkLabel(work)}未配置收藏飞书自动同步的目标知识库，已跳过`,
        awemeId,
      );
      return;
    }
    if (!this.feishuService) {
      this.log(
        jobId,
        "warning",
        "completed",
        `${formatWorkLabel(work)}收藏飞书自动同步服务不可用`,
        awemeId,
      );
      return;
    }

    try {
      const result = await this.feishuService.syncArticles(
        "favorite",
        settings.spaceId,
        [awemeId],
      );
      const item = result.items[0];
      if (!item || item.status === "failed") {
        this.log(
          jobId,
          "warning",
          "completed",
          `${formatWorkLabel(work)}收藏飞书自动同步失败：${item?.message ?? "飞书没有返回同步结果"}`,
          awemeId,
        );
      } else if (item.status === "skipped") {
        this.log(
          jobId,
          "info",
          "completed",
          `${formatWorkLabel(work)}已存在于目标飞书知识库，自动同步已跳过`,
          awemeId,
        );
      } else {
        this.log(
          jobId,
          "success",
          "completed",
          `${formatWorkLabel(work)}已自动同步到飞书知识库`,
          awemeId,
        );
      }
    } catch (error) {
      this.log(
        jobId,
        "warning",
        "completed",
        `${formatWorkLabel(work)}收藏飞书自动同步失败：${toAppError(error).message}`,
        awemeId,
      );
    }
  }

  private async openWithVerification(
    session: DouyinSession,
    jobId: number,
    profileUrl: string,
    signal: AbortSignal,
  ): Promise<ProfileSnapshot> {
    while (true) {
      try {
        return await session.open(profileUrl);
      } catch (error) {
        const appError = toAppError(error);
        if (appError.category !== "risk_verify") throw appError;
        await this.waitForVerification(jobId, appError, signal);
      }
    }
  }

  private async retryAfterVerification<T>(
    jobId: number,
    session: DouyinSession,
    operation: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    while (true) {
      try {
        return await operation();
      } catch (error) {
        const appError = toAppError(error);
        if (appError.category !== "risk_verify") throw appError;
        await this.waitForVerification(jobId, appError, signal);
        await session.checkAccess();
      }
    }
  }

  private async waitForVerification(jobId: number, error: AppError, signal: AbortSignal): Promise<void> {
    const awemeId = this.database.getJob(jobId)?.currentAwemeId ?? null;
    this.clearDownloadProgress(jobId);
    this.log(jobId, "warning", "verification", `任务需要人工验证：${error.message}`, awemeId);
    this.database.updateJob(jobId, {
      status: "waiting_verification", stage: "waiting",
      errorCategory: error.category, errorMessage: error.message,
    });
    while (!signal.aborted) {
      await sleep(750);
      this.throwIfCancelled(jobId, signal);
      if (this.database.getJob(jobId)?.status === "running") {
        this.log(jobId, "success", "verification", "人工验证已完成，任务继续运行", awemeId);
        return;
      }
    }
    throw new AppError("cancelled", "任务已取消");
  }

  private throwIfCancelled(jobId: number, signal: AbortSignal): void {
    if (signal.aborted || this.database.isCancelRequested(jobId)) throw new AppError("cancelled", "任务已取消");
  }

  private async existingMediaPath(
    video: Pick<VideoRecord | FavoriteVideoRecord, "mediaPath" | "status">,
  ): Promise<string | null> {
    if (!video.mediaPath || !["downloaded", "transcribing", "failed"].includes(video.status)) return null;
    const path = resolve(DATA_DIR, video.mediaPath);
    return access(path).then(() => path, () => null);
  }

  private updateDownloadProgress(
    jobId: number,
    awemeId: string,
    title: string,
    receivedBytes: number,
    totalBytes: number | null,
  ): void {
    const safeReceived = Math.max(0, Math.trunc(receivedBytes));
    const safeTotal = totalBytes && totalBytes > 0 ? Math.trunc(totalBytes) : null;
    this.downloadProgress = {
      jobId,
      awemeId,
      title: title.replace(/\s+/gu, " ").trim().slice(0, 80),
      receivedBytes: safeReceived,
      totalBytes: safeTotal,
      percent: safeTotal === null
        ? null
        : Math.min(100, Math.round((safeReceived / safeTotal) * 1_000) / 10),
      updatedAt: new Date().toISOString(),
    };
  }

  private clearDownloadProgress(jobId: number, awemeId?: string): void {
    if (
      this.downloadProgress?.jobId === jobId
      && (awemeId === undefined || this.downloadProgress.awemeId === awemeId)
    ) {
      this.downloadProgress = null;
    }
  }

  private log(
    jobId: number,
    level: JobLogLevel,
    stage: JobLogStage,
    message: string,
    awemeId: string | null = null,
  ): JobLog {
    return this.database.addJobLog({
      jobId,
      awemeId,
      level,
      stage,
      message: sanitizeLogMessage(message),
    });
  }
}

export function elapsedBetween(startedAt: string | null, finishedAt: string): number {
  const start = startedAt ? Date.parse(startedAt) : Number.NaN;
  const finish = Date.parse(finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(finish)) return 0;
  return Math.max(0, finish - start);
}

export function sanitizeLogMessage(message: string): string {
  return message
    .replace(/https?:\/\/\S+/giu, "[链接已隐藏]")
    .replace(/[A-Za-z]:[\\/][^\s]+/gu, "[路径已隐藏]")
    .replace(/(?:^|\s)\/(?:[^\s/]+\/)+[^\s]*/gu, " [路径已隐藏]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 500);
}

export function formatWorkLabel(work: Pick<ProfileWork, "awemeId" | "title">): string {
  const title = work.title.replace(/\s+/gu, " ").trim().slice(0, 80);
  return title ? `作品《${title}》（${work.awemeId}）` : `作品 ${work.awemeId}`;
}

export function formatByteSize(bytes: number): string {
  const safeBytes = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  if (safeBytes < 1_024) return `${Math.round(safeBytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = safeBytes / 1_024;
  let unitIndex = 0;
  while (value >= 1_024 && unitIndex < units.length - 1) {
    value /= 1_024;
    unitIndex += 1;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function isReasonableMediaTime(value: string | null): value is string {
  if (!value) return false;
  const time = new Date(value).getTime();
  return Number.isFinite(time) && time >= Date.UTC(2016, 0, 1) && time <= Date.now() + 86_400_000;
}
