import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { DyCollectDatabase } from "./db.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createDatabase() {
  const directory = await mkdtemp(join(tmpdir(), "dycollect-db-"));
  temporaryDirectories.push(directory);
  return {
    database: new DyCollectDatabase(join(directory, "archive.sqlite3")),
    path: join(directory, "archive.sqlite3"),
  };
}

describe("DyCollectDatabase", () => {
  it("persists the selected ASR device", async () => {
    const { database, path } = await createDatabase();
    expect(database.getAsrDevice()).toBe("auto");
    expect(database.saveAsrDevice("cpu")).toBe("cpu");
    database.close();
    const reopened = new DyCollectDatabase(path);
    expect(reopened.getAsrDevice()).toBe("cpu");
    reopened.close();
  });

  it("claims jobs serially and recovers an interrupted job after restart", async () => {
    const { database, path } = await createDatabase();
    const first = database.createJob("https://www.douyin.com/user/creator-one", "creator-one", 3, false);
    const second = database.createJob("https://www.douyin.com/user/creator-two", "creator-two", 2, false);

    expect(database.claimNextJob()?.id).toBe(first.id);
    expect(database.getJob(first.id)?.status).toBe("running");
    expect(database.getJob(second.id)?.status).toBe("queued");
    database.recordJobVideo(first.id, "11111111", "completed");
    database.recordJobVideo(first.id, "22222222", "failed", "network_error");
    expect(database.getJob(first.id)?.processedCount).toBe(2);
    database.close();

    const reopened = new DyCollectDatabase(path);
    reopened.recoverInterruptedJobs();
    expect(reopened.getJob(first.id)?.status).toBe("queued");
    expect(reopened.getJob(first.id)?.processedCount).toBe(2);
    expect(reopened.listJobVideoIds(first.id)).toEqual(["11111111", "22222222"]);
    expect(reopened.claimNextJob()?.id).toBe(first.id);
    reopened.close();
  });

  it("deduplicates videos and sorts unknown publication times last", async () => {
    const { database } = await createDatabase();
    database.upsertCreator("creator-one", "https://www.douyin.com/user/creator-one", "测试人物", 20);
    const base = {
      secUid: "creator-one",
      author: "测试人物",
      publishedAtSource: "aweme_id" as const,
    };
    database.upsertDiscoveredVideo({
      ...base,
      awemeId: "7601484851720380913",
      title: "较新作品",
      sourceUrl: "https://www.douyin.com/video/7601484851720380913",
      publishedAt: "2026-01-31T11:23:30.000Z",
    });
    database.upsertDiscoveredVideo({
      ...base,
      awemeId: "7000000000000000000",
      title: "未知时间",
      sourceUrl: "https://www.douyin.com/video/7000000000000000000",
      publishedAt: null,
      publishedAtSource: "unknown",
    });
    database.upsertDiscoveredVideo({
      ...base,
      awemeId: "7601484851720380913",
      title: "不会覆盖原始标题",
      sourceUrl: "https://www.douyin.com/video/7601484851720380913",
      publishedAt: "2026-01-31T11:23:30.000Z",
    });

    const page = database.listVideos("creator-one", 1, 50);
    expect(page.total).toBe(2);
    expect(page.items.map((video) => video.title)).toEqual(["较新作品", "未知时间"]);
    database.close();
  });

  it("deletes a creator and its videos while preserving job history", async () => {
    const { database } = await createDatabase();
    const secUid = "creator-delete";
    database.upsertCreator(secUid, `https://www.douyin.com/user/${secUid}`, "待删除人物", 2);
    for (const awemeId of ["7000000000000000001", "7000000000000000002"]) {
      database.upsertDiscoveredVideo({
        awemeId,
        secUid,
        title: awemeId,
        author: "待删除人物",
        sourceUrl: `https://www.douyin.com/video/${awemeId}`,
        publishedAt: null,
        publishedAtSource: "unknown",
      });
    }
    const job = database.createJob(`https://www.douyin.com/user/${secUid}`, secUid, 2, false);
    database.recordJobVideo(job.id, "7000000000000000001", "completed");
    database.addJobLog({
      jobId: job.id,
      awemeId: "7000000000000000001",
      level: "success",
      stage: "completed",
      message: "文章已生成",
    });

    expect(database.deleteCreator(secUid)).toBe(2);
    expect(database.getCreator(secUid)).toBeNull();
    expect(database.getVideo("7000000000000000001")).toBeNull();
    expect(database.getVideo("7000000000000000002")).toBeNull();
    expect(database.getJob(job.id)).not.toBeNull();
    expect(database.listJobVideoIds(job.id)).toEqual(["7000000000000000001"]);
    expect(database.listJobLogs(job.id)).toHaveLength(1);
    database.close();
  });

  it("deletes only the selected video", async () => {
    const { database } = await createDatabase();
    const secUid = "creator-video-delete";
    database.upsertCreator(secUid, `https://www.douyin.com/user/${secUid}`, "作品删除测试", 2);
    for (const awemeId of ["7000000000000000011", "7000000000000000012"]) {
      database.upsertDiscoveredVideo({
        awemeId,
        secUid,
        title: awemeId,
        author: "作品删除测试",
        sourceUrl: `https://www.douyin.com/video/${awemeId}`,
        publishedAt: null,
        publishedAtSource: "unknown",
      });
    }

    expect(database.deleteVideo("7000000000000000011")).toBe(true);
    expect(database.getVideo("7000000000000000011")).toBeNull();
    expect(database.getVideo("7000000000000000012")).not.toBeNull();
    expect(database.getCreator(secUid)).not.toBeNull();
    database.close();
  });

  it("persists Feishu credentials and cascades sync mappings with videos", async () => {
    const { database } = await createDatabase();
    const secUid = "creator-feishu";
    const awemeId = "7601484851720380998";
    database.upsertCreator(secUid, `https://www.douyin.com/user/${secUid}`, "飞书测试", 1);
    database.upsertDiscoveredVideo({
      awemeId,
      secUid,
      title: "飞书文章",
      author: "飞书测试",
      sourceUrl: `https://www.douyin.com/video/${awemeId}`,
      publishedAt: null,
      publishedAtSource: "unknown",
    });

    database.saveFeishuCredentials("cli_test", "secret-value");
    expect(database.getFeishuCredentials()).toEqual(expect.objectContaining({ appId: "cli_test", appSecret: "secret-value" }));
    database.createFeishuSync({ awemeId, spaceId: "space-1", nodeToken: "wik-node", documentId: "doc-id" });
    expect(database.getVideo(awemeId)?.feishuSynced).toBe(false);
    database.updateFeishuSyncProgress(awemeId, "space-1", 12);
    expect(database.getFeishuSync(awemeId, "space-1")).toEqual(expect.objectContaining({ status: "pending", writtenBlocks: 12 }));
    database.failFeishuSync(awemeId, "space-1", "写入失败");
    expect(database.getFeishuSync(awemeId, "space-1")).toEqual(expect.objectContaining({ status: "failed", lastError: "写入失败" }));
    expect(database.getVideo(awemeId)?.feishuSynced).toBe(false);
    database.completeFeishuSync(awemeId, "space-1", 20);
    expect(database.getFeishuSync(awemeId, "space-1")).toEqual(expect.objectContaining({ status: "synced", writtenBlocks: 20, lastError: null }));
    expect(database.getVideo(awemeId)?.feishuSynced).toBe(true);
    database.createFeishuSync({ awemeId, spaceId: "space-2", nodeToken: "wik-node-2", documentId: "doc-id-2" });
    database.failFeishuSync(awemeId, "space-2", "另一个空间失败");
    expect(database.getVideo(awemeId)?.feishuSynced).toBe(true);

    database.deleteVideo(awemeId);
    expect(database.getFeishuSync(awemeId, "space-1")).toBeNull();
    database.close();
  });

  it("persists favorite auto sync and isolates favorite mappings from creator mappings", async () => {
    const { database } = await createDatabase();
    const awemeId = "7601484851720380888";
    const secUid = "creator-shared-feishu";
    database.upsertCreator(secUid, `https://www.douyin.com/user/${secUid}`, "人物作者", 1);
    database.upsertDiscoveredVideo({
      awemeId,
      secUid,
      title: "人物文章",
      author: "人物作者",
      sourceUrl: `https://www.douyin.com/video/${awemeId}`,
      publishedAt: null,
      publishedAtSource: "unknown",
    });
    database.upsertDiscoveredFavorite({
      awemeId,
      title: "收藏文章",
      author: "收藏作者",
      sourceUrl: `https://www.douyin.com/video/${awemeId}`,
      publishedAt: null,
      publishedAtSource: "unknown",
    });

    expect(database.getFavoriteFeishuAutoSyncSettings()).toEqual({
      enabled: false,
      spaceId: null,
    });
    database.saveFeishuCredentials("cli_favorite", "favorite-secret");
    expect(database.saveFavoriteFeishuAutoSyncSettings(true, "space-shared")).toEqual({
      enabled: true,
      spaceId: "space-shared",
    });

    database.createFeishuSync({
      awemeId,
      spaceId: "space-shared",
      nodeToken: "creator-node",
      documentId: "creator-doc",
    });
    database.createFavoriteFeishuSync({
      awemeId,
      spaceId: "space-shared",
      nodeToken: "favorite-node",
      documentId: "favorite-doc",
    });
    database.completeFeishuSync(awemeId, "space-shared", 3);
    database.failFavoriteFeishuSync(awemeId, "space-shared", "收藏写入失败");

    expect(database.getFeishuSync(awemeId, "space-shared")).toMatchObject({
      status: "synced",
      documentId: "creator-doc",
    });
    expect(database.getFavoriteFeishuSync(awemeId, "space-shared")).toMatchObject({
      status: "failed",
      documentId: "favorite-doc",
      lastError: "收藏写入失败",
    });
    expect(database.getVideo(awemeId)?.feishuSynced).toBe(true);
    expect(database.getFavoriteVideo(awemeId)?.feishuSynced).toBe(false);
    database.completeFavoriteFeishuSync(awemeId, "space-shared", 3);
    expect(database.getFavoriteVideo(awemeId)?.feishuSynced).toBe(true);
    expect(database.getVideo(awemeId)?.feishuSynced).toBe(true);

    expect(database.deleteFavoriteVideo(awemeId)).toBe(true);
    expect(database.getFavoriteFeishuSync(awemeId, "space-shared")).toBeNull();
    expect(database.getFeishuSync(awemeId, "space-shared")).not.toBeNull();
    database.close();
  });

  it("detects an active task for one favorite and preserves its terminal task history after deletion", async () => {
    const { database } = await createDatabase();
    const awemeId = "7000000000000000251";
    const [job] = database.enqueueFavoriteWorks([{
      awemeId,
      title: "收藏任务历史",
      url: `https://www.douyin.com/video/${awemeId}`,
    }], awemeId);

    expect(job).toBeDefined();
    expect(database.hasPendingFavoriteJob(awemeId)).toBe(true);
    database.updateJob(job!.id, { status: "completed", stage: "finalizing" });
    database.recordJobVideo(job!.id, awemeId, "completed");
    expect(database.hasPendingFavoriteJob(awemeId)).toBe(false);

    expect(database.deleteFavoriteVideo(awemeId)).toBe(true);
    expect(database.getFavoriteVideo(awemeId)).toBeNull();
    expect(database.getJob(job!.id)).not.toBeNull();
    expect(database.listJobVideoIds(job!.id)).toEqual([awemeId]);
    database.close();
  });

  it("paginates jobs newest first and deletes only terminal task history", async () => {
    const { database } = await createDatabase();
    const secUid = "creator-job-history";
    const awemeId = "7601484851720380997";
    database.upsertCreator(secUid, `https://www.douyin.com/user/${secUid}`, "任务人物", 1);
    database.upsertDiscoveredVideo({
      awemeId,
      secUid,
      title: "保留的作品",
      author: "任务人物",
      sourceUrl: `https://www.douyin.com/video/${awemeId}`,
      publishedAt: null,
      publishedAtSource: "unknown",
    });

    const jobs = Array.from({ length: 7 }, (_, index) => database.createJob(
      `https://www.douyin.com/user/${secUid}-${index}`,
      `${secUid}-${index}`,
      index + 1,
      false,
    ));
    const terminalJob = jobs[0];
    const queuedJob = jobs[6];
    database.updateJob(terminalJob.id, { status: "completed", stage: "finalizing" });
    database.recordJobVideo(terminalJob.id, awemeId, "completed");
    database.addJobLog({
      jobId: terminalJob.id,
      awemeId,
      level: "success",
      stage: "completed",
      message: "任务完成",
    });

    const firstPage = database.listJobs(1, 5);
    expect(firstPage).toMatchObject({ page: 1, pageSize: 5, total: 7, totalPages: 2 });
    expect(firstPage.items.map((job) => job.id)).toEqual(jobs.slice(2).reverse().map((job) => job.id));
    expect(database.listJobs(2, 5).items.map((job) => job.id)).toEqual(jobs.slice(0, 2).reverse().map((job) => job.id));

    expect(database.deleteJob(queuedJob.id)).toBe(false);
    expect(database.getJob(queuedJob.id)).not.toBeNull();
    expect(database.deleteJob(terminalJob.id)).toBe(true);
    expect(database.getJob(terminalJob.id)).toBeNull();
    expect(database.listJobVideoIds(terminalJob.id)).toEqual([]);
    expect(database.listJobLogs(terminalJob.id)).toEqual([]);
    expect(database.getCreator(secUid)).not.toBeNull();
    expect(database.getVideo(awemeId)).not.toBeNull();
    database.close();
  });

  it("limits dashboard recent jobs to five", async () => {
    const { database } = await createDatabase();
    for (let index = 0; index < 7; index += 1) {
      const job = database.createJob(`https://www.douyin.com/user/recent-${index}`, `recent-${index}`, 1, false);
      database.updateJob(job.id, { status: "completed", stage: "finalizing" });
    }
    expect(database.getDashboard().recentJobs).toHaveLength(5);
    database.close();
  });

  it("clears all task logs only when no task is active and keeps log IDs monotonic", async () => {
    const { database } = await createDatabase();
    const first = database.createJob("https://www.douyin.com/user/clear-logs-one", "clear-logs-one", 1, false);
    const second = database.createJob("https://www.douyin.com/user/clear-logs-two", "clear-logs-two", 1, false);
    const firstLog = database.addJobLog({
      jobId: first.id,
      level: "info",
      stage: "task",
      message: "第一条日志",
    });
    const secondLog = database.addJobLog({
      jobId: second.id,
      level: "info",
      stage: "task",
      message: "第二条日志",
    });

    expect(database.clearJobLogs()).toEqual({ deletedLogs: 2 });
    expect(database.listJobLogs(first.id)).toEqual([]);
    expect(database.listJobLogs(second.id)).toEqual([]);
    expect(database.clearJobLogs()).toEqual({ deletedLogs: 0 });

    const nextLog = database.addJobLog({
      jobId: second.id,
      level: "info",
      stage: "task",
      message: "清理后的日志",
    });
    expect(nextLog.id).toBeGreaterThan(Math.max(firstLog.id, secondLog.id));
    database.close();
  });

  it("does not clear task logs while a task is running or waiting for verification", async () => {
    const { database } = await createDatabase();
    const job = database.createJob("https://www.douyin.com/user/active-logs", "active-logs", 1, false);
    database.claimNextJob();
    database.addJobLog({
      jobId: job.id,
      level: "info",
      stage: "task",
      message: "活动任务日志",
    });

    expect(database.clearJobLogs()).toBeNull();
    expect(database.listJobLogs(job.id)).toHaveLength(1);
    database.updateJob(job.id, { status: "waiting_verification", stage: "waiting" });
    expect(database.clearJobLogs()).toBeNull();
    expect(database.listJobLogs(job.id)).toHaveLength(1);
    database.close();
  });

  it("clears every terminal task with cascaded details while preserving active work and collected data", async () => {
    const { database } = await createDatabase();
    const secUid = "maintenance-history";
    const awemeId = "7601484851720380998";
    database.upsertCreator(secUid, `https://www.douyin.com/user/${secUid}`, "保留人物", 1);
    database.upsertDiscoveredVideo({
      awemeId,
      secUid,
      title: "保留作品",
      author: "保留人物",
      sourceUrl: `https://www.douyin.com/video/${awemeId}`,
      publishedAt: null,
      publishedAtSource: "unknown",
    });
    database.createFeishuSync({
      awemeId,
      spaceId: "maintenance-space",
      nodeToken: "maintenance-node",
      documentId: "maintenance-document",
    });

    const terminalStatuses = ["completed", "completed_partial", "cancelled", "failed"] as const;
    const terminalJobs = terminalStatuses.map((status, index) => {
      const job = database.createJob(
        `https://www.douyin.com/user/terminal-${index}`,
        `terminal-${index}`,
        1,
        false,
      );
      database.updateJob(job.id, { status, stage: status === "cancelled" || status === "failed" ? "waiting" : "finalizing" });
      database.recordJobVideo(job.id, awemeId, status === "failed" ? "failed" : "completed");
      database.addJobLog({
        jobId: job.id,
        awemeId,
        level: status === "failed" ? "error" : "success",
        stage: "completed",
        message: `终态任务 ${status}`,
      });
      return job;
    });

    const active = database.createJob("https://www.douyin.com/user/maintenance-active", "maintenance-active", 1, false);
    database.claimNextJob();
    database.recordJobVideo(active.id, awemeId, "completed");
    database.addJobLog({ jobId: active.id, awemeId, level: "info", stage: "task", message: "活动任务" });
    const queued = database.createJob("https://www.douyin.com/user/maintenance-queued", "maintenance-queued", 1, false);

    expect(database.clearTerminalJobs()).toEqual({ deletedJobs: 4 });
    expect(terminalJobs.every((job) => database.getJob(job.id) === null)).toBe(true);
    expect(terminalJobs.every((job) => database.listJobVideoIds(job.id).length === 0)).toBe(true);
    expect(terminalJobs.every((job) => database.listJobLogs(job.id).length === 0)).toBe(true);
    expect(database.getJob(active.id)?.status).toBe("running");
    expect(database.getJob(queued.id)?.status).toBe("queued");
    expect(database.listJobVideoIds(active.id)).toEqual([awemeId]);
    expect(database.listJobLogs(active.id)).toHaveLength(1);
    expect(database.getCreator(secUid)).not.toBeNull();
    expect(database.getVideo(awemeId)).not.toBeNull();
    expect(database.getFeishuSync(awemeId, "maintenance-space")).not.toBeNull();
    expect(database.clearTerminalJobs()).toEqual({ deletedJobs: 0 });
    database.close();
  });

  it("keeps the newest 300 task logs in chronological order", async () => {
    const { database } = await createDatabase();
    const job = database.createJob("https://www.douyin.com/user/logs", "logs", 1, false);
    for (let index = 0; index < 305; index += 1) {
      database.addJobLog({
        jobId: job.id,
        awemeId: String(70_000_000 + index),
        level: "info",
        stage: "discovering",
        message: `日志 ${index}`,
      });
    }

    const logs = database.listJobLogs(job.id);
    expect(logs).toHaveLength(300);
    expect(logs[0]?.message).toBe("日志 5");
    expect(logs.at(-1)?.message).toBe("日志 304");
    expect(logs.every((log, index) => index === 0 || log.id > logs[index - 1]!.id)).toBe(true);
    database.close();
  });

  it("updates only the selected task log message without changing its identity or order", async () => {
    const { database } = await createDatabase();
    const firstJob = database.createJob("https://www.douyin.com/user/log-update-one", "log-update-one", 1, false);
    const secondJob = database.createJob("https://www.douyin.com/user/log-update-two", "log-update-two", 1, false);
    const original = database.addJobLog({
      jobId: firstJob.id,
      level: "info",
      stage: "extracting_audio",
      message: "开始提取音频",
    });

    const updated = database.updateJobLogMessage(firstJob.id, original.id, "开始提取音频（耗时 0.4秒）");
    expect(updated).toMatchObject({
      id: original.id,
      jobId: firstJob.id,
      message: "开始提取音频（耗时 0.4秒）",
      createdAt: original.createdAt,
    });
    expect(database.updateJobLogMessage(secondJob.id, original.id, "不应更新")).toBeNull();
    expect(database.listJobLogs(firstJob.id)).toEqual([updated]);
    database.close();
  });

  it("shows active task logs and falls back to the latest terminal task", async () => {
    const { database } = await createDatabase();
    const finished = database.createJob("https://www.douyin.com/user/finished", "finished", 1, false);
    database.updateJob(finished.id, { status: "completed", stage: "finalizing" });
    database.addJobLog({ jobId: finished.id, level: "success", stage: "completed", message: "旧任务完成" });

    expect(database.getDashboard()).toMatchObject({
      logJobId: finished.id,
      jobLogs: [expect.objectContaining({ message: "旧任务完成" })],
    });

    const active = database.createJob("https://www.douyin.com/user/active", "active", 1, false);
    database.claimNextJob();
    database.addJobLog({ jobId: active.id, level: "info", stage: "task", message: "新任务开始" });
    expect(database.getDashboard()).toMatchObject({
      logJobId: active.id,
      jobLogs: [expect.objectContaining({ message: "新任务开始" })],
    });
    database.close();
  });

  it("persists the favorite listener lifecycle separately from task execution", async () => {
    const { database, path } = await createDatabase();
    expect(database.getFavoriteListenerState()).toMatchObject({
      enabled: false,
      status: "stopped",
      baselineAwemeId: null,
      cursorAwemeId: null,
    });
    database.updateFavoriteListener({
      enabled: true,
      status: "listening",
      baselineAwemeId: "7000000000000000100",
      cursorAwemeId: "7000000000000000100",
      lastCheckedAt: "2026-07-24T00:00:00.000Z",
    });
    database.close();

    const reopened = new DyCollectDatabase(path);
    expect(reopened.getFavoriteListenerState()).toMatchObject({
      enabled: true,
      status: "listening",
      baselineAwemeId: "7000000000000000100",
      cursorAwemeId: "7000000000000000100",
    });
    reopened.close();
  });

  it("creates one oldest-first task per new favorite and keeps favorite data independent", async () => {
    const { database } = await createDatabase();
    const sharedAwemeId = "7000000000000000201";
    database.upsertCreator("creator-independent", "https://www.douyin.com/user/creator-independent", "人物作者", 1);
    database.upsertDiscoveredVideo({
      awemeId: sharedAwemeId,
      secUid: "creator-independent",
      title: "人物模块标题",
      author: "人物作者",
      sourceUrl: `https://www.douyin.com/video/${sharedAwemeId}`,
      publishedAt: null,
      publishedAtSource: "unknown",
    });

    const jobs = database.enqueueFavoriteWorks([
      {
        awemeId: sharedAwemeId,
        title: "较早新增收藏",
        url: `https://www.douyin.com/video/${sharedAwemeId}`,
      },
      {
        awemeId: "7000000000000000202",
        title: "较晚新增收藏",
        url: "https://www.douyin.com/video/7000000000000000202",
      },
    ], "7000000000000000202");

    expect(jobs).toHaveLength(2);
    expect(jobs.map((job) => ({
      mode: job.mode,
      sourceAwemeId: job.sourceAwemeId,
      targetCount: job.targetCount,
    }))).toEqual([
      { mode: "favorite", sourceAwemeId: sharedAwemeId, targetCount: 1 },
      { mode: "favorite", sourceAwemeId: "7000000000000000202", targetCount: 1 },
    ]);
    expect(database.claimNextJob()?.sourceAwemeId).toBe(sharedAwemeId);
    expect(database.getFavoriteListenerState().cursorAwemeId).toBe("7000000000000000202");
    expect(database.getFavoriteVideo(sharedAwemeId)?.title).toBe("较早新增收藏");
    expect(database.getVideo(sharedAwemeId)?.title).toBe("人物模块标题");
    expect(database.findExistingFavoriteIds([
      sharedAwemeId,
      "7000000000000000202",
      "7000000000000000999",
      sharedAwemeId,
    ])).toEqual(new Set([sharedAwemeId, "7000000000000000202"]));
    expect(database.findExistingFavoriteIds([])).toEqual(new Set());

    database.updateFavoriteVideo(sharedAwemeId, { status: "completed", author: "收藏作者" });
    expect(database.getFavoriteVideo(sharedAwemeId)).toMatchObject({ status: "completed", author: "收藏作者" });
    expect(database.getVideo(sharedAwemeId)).toMatchObject({ status: "discovered", author: "人物作者" });
    expect(database.enqueueFavoriteWorks([{
      awemeId: sharedAwemeId,
      title: "重复收藏",
      url: `https://www.douyin.com/video/${sharedAwemeId}`,
    }], sharedAwemeId)).toEqual([]);

    database.deleteCreator("creator-independent");
    expect(database.getVideo(sharedAwemeId)).toBeNull();
    expect(database.getFavoriteVideo(sharedAwemeId)).not.toBeNull();
    database.close();
  });

  it("migrates an unversioned development database while preserving collected and Feishu data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dycollect-db-legacy-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "archive.sqlite3");
    const legacy = new Database(path);
    legacy.pragma("foreign_keys = ON");
    legacy.exec(`
      CREATE TABLE creators (
        sec_uid TEXT PRIMARY KEY,
        profile_url TEXT NOT NULL UNIQUE,
        nickname TEXT NOT NULL DEFAULT '',
        displayed_post_count INTEGER,
        first_seen_at TEXT NOT NULL,
        last_crawled_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE videos (
        aweme_id TEXT PRIMARY KEY,
        sec_uid TEXT NOT NULL REFERENCES creators(sec_uid) ON DELETE CASCADE,
        title TEXT NOT NULL DEFAULT '',
        author TEXT NOT NULL DEFAULT '',
        source_url TEXT NOT NULL,
        published_at TEXT,
        published_at_source TEXT NOT NULL DEFAULT 'unknown',
        status TEXT NOT NULL DEFAULT 'discovered',
        failure_category TEXT,
        failure_reason TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        markdown_path TEXT,
        media_path TEXT,
        discovered_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE favorite_videos (
        aweme_id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        author TEXT NOT NULL DEFAULT '',
        source_url TEXT NOT NULL,
        published_at TEXT,
        published_at_source TEXT NOT NULL DEFAULT 'unknown',
        status TEXT NOT NULL DEFAULT 'discovered',
        failure_category TEXT,
        failure_reason TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        markdown_path TEXT,
        media_path TEXT,
        discovered_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE feishu_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        app_id TEXT NOT NULL,
        app_secret TEXT NOT NULL,
        favorite_auto_sync_enabled INTEGER NOT NULL DEFAULT 0,
        favorite_auto_sync_space_id TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE feishu_syncs (
        aweme_id TEXT NOT NULL REFERENCES videos(aweme_id) ON DELETE CASCADE,
        space_id TEXT NOT NULL,
        node_token TEXT NOT NULL,
        document_id TEXT NOT NULL,
        status TEXT NOT NULL,
        written_blocks INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (aweme_id, space_id)
      );
      CREATE TABLE favorite_feishu_syncs (
        aweme_id TEXT NOT NULL REFERENCES favorite_videos(aweme_id) ON DELETE CASCADE,
        space_id TEXT NOT NULL,
        node_token TEXT NOT NULL,
        document_id TEXT NOT NULL,
        status TEXT NOT NULL,
        written_blocks INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (aweme_id, space_id)
      );
      CREATE TABLE favorite_listener (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        enabled INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'stopped',
        baseline_aweme_id TEXT,
        cursor_aweme_id TEXT,
        last_checked_at TEXT,
        error_category TEXT,
        error_message TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE crawl_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mode TEXT NOT NULL DEFAULT 'creator',
        source_aweme_id TEXT,
        profile_url TEXT NOT NULL,
        sec_uid TEXT NOT NULL,
        creator_nickname TEXT,
        target_count INTEGER NOT NULL,
        retry_permanent INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'queued',
        stage TEXT NOT NULL DEFAULT 'waiting',
        discovered_count INTEGER NOT NULL DEFAULT 0,
        duplicate_count INTEGER NOT NULL DEFAULT 0,
        completed_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        current_aweme_id TEXT,
        error_category TEXT,
        error_message TEXT,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE job_videos (
        job_id INTEGER NOT NULL REFERENCES crawl_jobs(id) ON DELETE CASCADE,
        aweme_id TEXT NOT NULL,
        outcome TEXT NOT NULL,
        error_category TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (job_id, aweme_id)
      );
      CREATE TABLE job_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER NOT NULL REFERENCES crawl_jobs(id) ON DELETE CASCADE,
        aweme_id TEXT,
        level TEXT NOT NULL,
        stage TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    const now = "2026-07-24T00:00:00.000Z";
    legacy.prepare(`
      INSERT INTO creators VALUES ('legacy-creator', 'https://www.douyin.com/user/legacy-creator', '旧人物', 1, ?, ?, ?)
    `).run(now, now, now);
    legacy.prepare(`
      INSERT INTO videos VALUES (
        '7000000000000000901', 'legacy-creator', '旧人物文章', '旧人物',
        'https://www.douyin.com/video/7000000000000000901', NULL, 'unknown',
        'completed', NULL, NULL, 1, 'legacy-creator/articles/a.md', NULL, ?, ?, ?
      )
    `).run(now, now, now);
    legacy.prepare(`
      INSERT INTO favorite_videos VALUES (
        '7000000000000000902', '旧收藏文章', '收藏作者',
        'https://www.douyin.com/video/7000000000000000902', NULL, 'unknown',
        'completed', NULL, NULL, 1, 'favorites/articles/b.md', NULL, ?, ?, ?
      )
    `).run(now, now, now);
    legacy.prepare(`INSERT INTO feishu_settings VALUES (1, 'cli_legacy', 'secret', 1, 'space-favorite', ?)`).run(now);
    legacy.prepare(`
      INSERT INTO feishu_syncs VALUES (
        '7000000000000000901', 'space-creator', 'node-creator', 'doc-creator',
        'synced', 3, NULL, ?, ?
      )
    `).run(now, now);
    legacy.prepare(`
      INSERT INTO favorite_feishu_syncs VALUES (
        '7000000000000000902', 'space-favorite', 'node-favorite', 'doc-favorite',
        'synced', 4, NULL, ?, ?
      )
    `).run(now, now);
    legacy.prepare(`
      INSERT INTO favorite_listener VALUES (
        1, 1, 'listening', '7000000000000000902', '7000000000000000902',
        ?, NULL, NULL, ?
      )
    `).run(now, now);
    const oldJob = legacy.prepare(`
      INSERT INTO crawl_jobs(
        mode, source_aweme_id, profile_url, sec_uid, creator_nickname,
        target_count, retry_permanent, status, stage, created_at, updated_at
      ) VALUES ('creator', NULL, 'https://www.douyin.com/user/legacy-creator',
        'legacy-creator', '旧人物', 1, 0, 'completed', 'finalizing', ?, ?)
    `).run(now, now);
    legacy.prepare(`INSERT INTO job_videos VALUES (?, '7000000000000000901', 'completed', NULL, ?)`).run(oldJob.lastInsertRowid, now);
    legacy.prepare(`INSERT INTO job_logs(job_id, level, stage, message, created_at) VALUES (?, 'success', 'completed', '旧日志', ?)`).run(oldJob.lastInsertRowid, now);
    legacy.close();

    const database = new DyCollectDatabase(path);
    expect(database.getVideo("7000000000000000901")).toMatchObject({
      title: "旧人物文章",
      feishuSynced: false,
    });
    expect(database.getFavoriteVideo("7000000000000000902")).toMatchObject({
      title: "旧收藏文章",
      feishuSynced: false,
    });
    expect(database.getFeishuCredentials()).toMatchObject({ appId: "cli_legacy", appSecret: "secret" });
    expect(database.getFeishuSync("7000000000000000901", "space-creator")).not.toBeNull();
    expect(database.getFavoriteFeishuSync("7000000000000000902", "space-favorite")).not.toBeNull();
    expect(database.listJobs(1)).toMatchObject({ total: 0, items: [] });
    expect(database.getFavoriteListenerState()).toMatchObject({
      enabled: false,
      status: "stopped",
      baselineAwemeId: "7000000000000000902",
      cursorAwemeId: "7000000000000000902",
    });
    database.close();

    const migrated = new Database(path, { readonly: true });
    expect(migrated.pragma("user_version", { simple: true })).toBe(2);
    expect((migrated.prepare(`SELECT device FROM asr_settings WHERE id=1`).get() as { device: string }).device).toBe("auto");
    expect((migrated.prepare(`PRAGMA table_info(crawl_jobs)`).all() as Array<{ name: string }>)
      .map((column) => column.name)).not.toContain("completed_count");
    migrated.close();
  });

  it("enforces mode-specific task fields and returns stable discriminated task shapes", async () => {
    const { database, path } = await createDatabase();
    const creatorJob = database.createJob(
      "https://www.douyin.com/user/strict-creator",
      "strict-creator",
      2,
      true,
    );
    const [favoriteJob] = database.enqueueFavoriteWorks([{
      awemeId: "7000000000000000910",
      title: "严格收藏",
      url: "https://www.douyin.com/video/7000000000000000910",
    }], "7000000000000000910");
    expect(creatorJob).toMatchObject({
      mode: "creator",
      sourceAwemeId: null,
      profileUrl: "https://www.douyin.com/user/strict-creator",
      secUid: "strict-creator",
    });
    expect(favoriteJob).toMatchObject({
      mode: "favorite",
      sourceAwemeId: "7000000000000000910",
      profileUrl: null,
      secUid: null,
      creatorNickname: null,
      targetCount: 1,
      retryPermanent: false,
    });
    database.close();

    const raw = new Database(path);
    const insert = raw.prepare(`
      INSERT INTO crawl_jobs(
        mode, source_aweme_id, profile_url, sec_uid, creator_nickname,
        target_count, retry_permanent, status, stage, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 'waiting', ?, ?)
    `);
    const now = "2026-07-24T00:00:00.000Z";
    expect(() => insert.run("favorite", "7000000000000000911", "https://example.com", null, null, 1, 0, now, now)).toThrow();
    expect(() => insert.run("favorite", "7000000000000000912", null, null, null, 2, 0, now, now)).toThrow();
    expect(() => insert.run("favorite", null, null, null, null, 1, 0, now, now)).toThrow();
    expect(() => insert.run("creator", "7000000000000000913", "https://example.com", "creator", null, 1, 0, now, now)).toThrow();
    raw.close();
  });

  it("derives task totals from the latest job video outcomes", async () => {
    const { database } = await createDatabase();
    const job = database.createJob("https://www.douyin.com/user/job-stats", "job-stats", 3, false);
    database.recordJobVideo(job.id, "7000000000000000921", "completed");
    database.recordJobVideo(job.id, "7000000000000000922", "failed", "network_error");
    database.recordJobVideo(job.id, "7000000000000000923", "skipped");
    expect(database.getJob(job.id)).toMatchObject({
      completedCount: 1,
      failedCount: 1,
      duplicateCount: 1,
      processedCount: 2,
    });

    database.recordJobVideo(job.id, "7000000000000000922", "completed");
    expect(database.getJob(job.id)).toMatchObject({
      completedCount: 2,
      failedCount: 0,
      duplicateCount: 1,
      processedCount: 2,
    });
    database.close();
  });

  it("commits video terminal state and job outcome atomically", async () => {
    const { database } = await createDatabase();
    const secUid = "atomic-video";
    const awemeId = "7000000000000000931";
    const rollbackAwemeId = "7000000000000000932";
    database.upsertCreator(secUid, `https://www.douyin.com/user/${secUid}`, "原子人物", 2);
    for (const id of [awemeId, rollbackAwemeId]) {
      database.upsertDiscoveredVideo({
        awemeId: id,
        secUid,
        title: id,
        author: "原子人物",
        sourceUrl: `https://www.douyin.com/video/${id}`,
        publishedAt: null,
        publishedAtSource: "unknown",
      });
    }
    const job = database.createJob(`https://www.douyin.com/user/${secUid}`, secUid, 2, false);
    database.completeVideoForJob({
      jobId: job.id,
      awemeId,
      source: "creator",
      markdownPath: `${secUid}/articles/${awemeId}.md`,
      mediaPath: null,
      completedAt: "2026-07-24T00:00:00.000Z",
    });
    expect(database.getVideo(awemeId)?.status).toBe("completed");
    expect(database.getJob(job.id)?.completedCount).toBe(1);

    expect(() => database.failVideoForJob({
      jobId: 999_999,
      awemeId: rollbackAwemeId,
      source: "creator",
      errorCategory: "network_error",
      errorMessage: "网络失败",
    })).toThrow();
    expect(database.getVideo(rollbackAwemeId)).toMatchObject({
      status: "discovered",
      failureCategory: null,
      failureReason: null,
    });
    database.close();
  });
});
