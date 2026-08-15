import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { ArticleDetail, CrawlJob, JobLog, VideoRecord } from "@dycollect/shared";
import { DeleteConfirmationDialog, FeishuSyncBadge, formatDate } from "./UI";
import {
  ActiveJob,
  DebugBrowserControl,
  DownloadProgressLogItem,
  FavoriteListenerControl,
  formatBytes,
  JobList,
  Stages,
  TaskLogPanel,
} from "../pages/DashboardPage";
import { pageAfterVideoDeletion } from "../pages/CreatorVideosPage";
import { pageAfterFavoriteDeletion } from "../pages/FavoritesPage";
import {
  articleSyncUnavailableReason,
  canSyncArticleDetail,
  canSyncVideo,
  FeishuSyncDialog,
} from "./FeishuSyncDialog";
import { AppShell, ModelSetupDialog } from "./AppShell";
import { canDeleteJob, JobsPage, pageAfterJobDeletion } from "../pages/JobsPage";
import {
  DataCleanupSection,
  AsrDeviceSection,
  FavoriteFeishuSyncSection,
  MaintenanceCleanupDialog,
} from "../pages/SettingsPage";
import { ArticleDetailView } from "../pages/ArticlePage";
import { FavoritesPage } from "../pages/FavoritesPage";

describe("formatDate", () => {
  it("formats timestamps in Asia/Shanghai", () => {
    expect(formatDate("2026-01-31T11:23:30.000Z")).toContain("2026");
    expect(formatDate(null)).toBe("未知");
  });
});

describe("FeishuSyncBadge", () => {
  it("renders the persisted synchronization state", () => {
    expect(renderToStaticMarkup(createElement(FeishuSyncBadge, { synced: true }))).toContain("已同步");
    expect(renderToStaticMarkup(createElement(FeishuSyncBadge, { synced: false }))).toContain("未同步");
  });
});

describe("DebugBrowserControl", () => {
  it("explains that the browser opens on the collection host", () => {
    const html = renderToStaticMarkup(createElement(DebugBrowserControl, {
      status: "closed",
      opening: false,
      jobsPending: false,
      loading: false,
      error: null,
      onOpen: vi.fn(),
    }));
    expect(html).toContain("打开抖音浏览器");
    expect(html).toContain("运行 听录机 的主机上");
    expect(html).not.toContain("disabled");
  });

  it("disables the button while the debug browser is open", () => {
    const html = renderToStaticMarkup(createElement(DebugBrowserControl, {
      status: "open",
      opening: false,
      jobsPending: false,
      loading: false,
      error: null,
      onOpen: vi.fn(),
    }));
    expect(html).toContain("浏览器已打开");
    expect(html).toContain("disabled");
    expect(html).toContain("直接关闭浏览器窗口");
  });
});

describe("DeleteConfirmationDialog", () => {
  it("describes permanent deletion and exposes a disabled loading state", () => {
    const html = renderToStaticMarkup(createElement(DeleteConfirmationDialog, {
      open: true,
      title: "删除人物？",
      subject: "示例人物",
      description: "此操作不可撤销",
      loading: true,
      error: "人物存在排队任务",
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
    }));
    expect(html).toContain("删除人物？");
    expect(html).toContain("示例人物");
    expect(html).toContain("正在删除");
    expect(html).toContain("人物存在排队任务");
    expect(html.match(/<button[^>]*disabled=""/g)?.length).toBe(2);
  });
});

describe("model initialization UI", () => {
  it("shows the terminal command and missing files without offering a download action", () => {
    const html = renderToStaticMarkup(createElement(ModelSetupDialog, {
      open: true,
      status: {
        state: "incomplete",
        modelId: "Qwen/Qwen3-ASR-0.6B-hf",
        missingFiles: ["tokenizer.json"],
        setupCommand: "npm run setup:model",
      },
      checking: false,
      onRefresh: vi.fn(),
      onClose: vi.fn(),
    }));
    expect(html).toContain("模型文件不完整");
    expect(html).toContain("npm run setup:model");
    expect(html).toContain("tokenizer.json");
    expect(html).toContain("重新检测");
    expect(html).not.toContain("下载模型");
  });

  it("disables task resume and listener start while the model is unavailable", () => {
    const listener = renderToStaticMarkup(createElement(FavoriteListenerControl, {
      state: null,
      loading: false,
      busy: false,
      browserActive: false,
      creatorJobsPending: false,
      favoriteJobsPending: false,
      modelUnavailable: true,
      error: null,
      onAction: vi.fn(),
    }));
    expect(listener.match(/<button[^>]*disabled=""/g)?.length).toBe(1);
  });
});

describe("ASR device settings", () => {
  it("shows available devices and keeps MPS marked experimental", () => {
    const html = renderToStaticMarkup(createElement(AsrDeviceSection, {
      settings: {
        selectedDevice: "auto",
        resolvedDevice: "cuda",
        availableDevices: ["cuda", "cpu"],
        diagnostic: null,
      },
      selectedDevice: "auto",
      loading: false,
      saving: false,
      saved: false,
      error: null,
      onDeviceChange: vi.fn(),
      onSubmit: vi.fn(),
    }));
    expect(html).toContain("转录设备");
    expect(html).toContain("NVIDIA CUDA");
    expect(html).toContain("Apple MPS（实验性）");
    expect(html).toContain("当前解析设备");
  });
});

describe("settings data cleanup", () => {
  it("renders both destructive actions and disables them together while cleaning", () => {
    const html = renderToStaticMarkup(createElement(DataCleanupSection, {
      busy: true,
      status: "已清除 3 条任务日志",
      onRequest: vi.fn(),
    }));
    expect(html).toContain("数据清理");
    expect(html).toContain("清除所有任务日志");
    expect(html).toContain("清除最近任务");
    expect(html).toContain("已清除 3 条任务日志");
    expect(html.match(/<button[^>]*disabled=""/g)?.length).toBe(2);
  });

  it("explains the exact deletion boundary in both confirmation dialogs", () => {
    const logs = renderToStaticMarkup(createElement(MaintenanceCleanupDialog, {
      target: "logs",
      loading: false,
      error: "存在运行中或等待验证的任务",
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
    }));
    const jobs = renderToStaticMarkup(createElement(MaintenanceCleanupDialog, {
      target: "jobs",
      loading: false,
      error: null,
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
    }));
    expect(logs).toContain("全部任务日志");
    expect(logs).toContain("任务处理明细仍会保留");
    expect(logs).toContain("存在运行中或等待验证的任务");
    expect(jobs).toContain("全部终态任务");
    expect(jobs).toContain("级联删除对应日志与处理明细");
    expect(jobs).toContain("飞书同步记录不会被删除");
  });
});

describe("task failure reasons", () => {
  const failedJob: CrawlJob = {
    id: 8,
    mode: "creator",
    sourceAwemeId: null,
    profileUrl: "https://www.douyin.com/user/creator-test",
    secUid: "creator-test",
    creatorNickname: "失败人物",
    targetCount: 2,
    retryPermanent: false,
    status: "failed",
    stage: "waiting",
    discoveredCount: 1,
    duplicateCount: 0,
    completedCount: 0,
    failedCount: 0,
    processedCount: 0,
    currentAwemeId: null,
    errorCategory: "network_error",
    errorMessage: "主页网络请求失败",
    cancelRequested: false,
    createdAt: "2026-07-22T00:00:00.000Z",
    startedAt: "2026-07-22T00:00:01.000Z",
    finishedAt: "2026-07-22T00:00:02.000Z",
    updatedAt: "2026-07-22T00:00:02.000Z",
  };

  it("shows a failure reason in recent jobs", () => {
    const html = renderToStaticMarkup(createElement(JobList, { title: "最近任务", jobs: [failedJob], empty: "暂无" }));
    expect(html).toContain("失败原因：");
    expect(html).toContain("主页网络请求失败");
  });

  it("shows the verification reason in the active job card", () => {
    const waitingJob = { ...failedJob, status: "waiting_verification" as const, errorMessage: "需要完成人机验证" };
    const html = renderToStaticMarkup(createElement(ActiveJob, { job: waitingJob, onRefresh: vi.fn(async () => undefined) }));
    expect(html).toContain("需要完成人机验证");
    expect(html).toContain("失败原因：");
  });
});

describe("task stages and logs", () => {
  const logs: JobLog[] = [
    {
      id: 1,
      jobId: 9,
      awemeId: "7601484851720380913",
      level: "info",
      stage: "downloading",
      message: `作品《${"会自动换行的长标题".repeat(20)}》（7601484851720380913）开始下载`,
      createdAt: "2026-07-22T00:00:01.000Z",
    },
    {
      id: 2,
      jobId: 9,
      awemeId: "7601484851720380913",
      level: "success",
      stage: "completed",
      message: "转录文章已生成",
      createdAt: "2026-07-22T00:00:02.000Z",
    },
  ];

  it("labels the existing strip as the current processing stage", () => {
    const active = renderToStaticMarkup(createElement(Stages, { active: "downloading" }));
    const verification = renderToStaticMarkup(createElement(Stages, {
      active: "waiting",
      waitingVerification: true,
    }));
    expect(active).toContain("当前处理阶段");
    expect(active).toContain("下载");
    expect(verification).toContain("等待人工验证");
  });

  it("renders a wrapping, vertical-only live log for the active task", () => {
    const html = renderToStaticMarkup(createElement(TaskLogPanel, {
      activeJobId: 9,
      jobId: 9,
      logs,
    }));
    expect(html).toContain("任务 #9 的实时日志");
    expect(html).toContain("aria-live=\"polite\"");
    expect(html).toContain("overflow-x-hidden");
    expect(html).toContain("overflow-y-auto");
    expect(html).toContain("开始下载");
    expect(html).toContain("转录文章已生成");
  });

  it("keeps the most recent terminal task log visible while idle", () => {
    const html = renderToStaticMarkup(createElement(TaskLogPanel, {
      activeJobId: null,
      jobId: 9,
      logs,
    }));
    expect(html).toContain("最近任务 #9 的日志");
  });
});

describe("video download progress", () => {
  const baseProgress = {
    jobId: 9,
    awemeId: "7601484851720380913",
    title: "小白如何开始 Vibe coding",
    receivedBytes: 1_048_576,
    totalBytes: 2_097_152,
    percent: 50,
    updatedAt: "2026-07-23T00:00:00.000Z",
  };

  it("renders exact percentage and size when total bytes are known", () => {
    const html = renderToStaticMarkup(createElement(DownloadProgressLogItem, {
      progress: baseProgress,
    }));
    expect(html).toContain("小白如何开始 Vibe coding");
    expect(html).toContain("下载中 50.0%");
    expect(html).toContain("1.00 MB / 2.00 MB");
    expect(html).toContain("50.0%");
    expect(html).toContain("<progress");
    expect(html).toContain("data-transient-download=\"true\"");
  });

  it("renders downloaded bytes with an indeterminate bar when total size is unknown", () => {
    const html = renderToStaticMarkup(createElement(DownloadProgressLogItem, {
      progress: { ...baseProgress, totalBytes: null, percent: null },
    }));
    expect(html).toContain("已下载 1.00 MB · 总大小未知");
    expect(html).toContain("download-progress-indeterminate");
  });

  it("shows a connection state before the first response chunk", () => {
    const html = renderToStaticMarkup(createElement(DownloadProgressLogItem, {
      progress: { ...baseProgress, receivedBytes: 0, totalBytes: null, percent: null },
    }));
    expect(html).toContain("正在连接媒体服务器");
    expect(formatBytes(1_572_864)).toBe("1.50 MB");
  });

  it("only adds the temporary row to its matching task log", () => {
    const matching = renderToStaticMarkup(createElement(TaskLogPanel, {
      activeJobId: 9,
      jobId: 9,
      logs: [],
      downloadProgress: baseProgress,
    }));
    const mismatching = renderToStaticMarkup(createElement(TaskLogPanel, {
      activeJobId: 8,
      jobId: 8,
      logs: [],
      downloadProgress: baseProgress,
    }));
    expect(matching).toContain("data-transient-download=\"true\"");
    expect(mismatching).not.toContain("data-transient-download=\"true\"");
  });
});

describe("pageAfterVideoDeletion", () => {
  it("returns to the previous page after deleting the last item", () => {
    expect(pageAfterVideoDeletion(3, 1)).toBe(2);
    expect(pageAfterVideoDeletion(1, 1)).toBe(1);
    expect(pageAfterVideoDeletion(3, 2)).toBe(3);
  });
});

describe("pageAfterFavoriteDeletion", () => {
  it("returns to the previous page only after deleting the last item", () => {
    expect(pageAfterFavoriteDeletion(3, 1)).toBe(2);
    expect(pageAfterFavoriteDeletion(1, 1)).toBe(1);
    expect(pageAfterFavoriteDeletion(3, 2)).toBe(3);
  });
});

describe("task list", () => {
  it("adds the task list navigation and loading page", () => {
    const navigation = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ["/jobs"] }, createElement(AppShell)));
    const page = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ["/jobs?page=1"] }, createElement(JobsPage)));
    expect(navigation).toContain("任务列表");
    expect(page).toContain("任务列表");
    expect(page).toContain("正在读取任务");
  });

  it("allows deletion only for terminal tasks", () => {
    expect(canDeleteJob({ status: "completed" })).toBe(true);
    expect(canDeleteJob({ status: "completed_partial" })).toBe(true);
    expect(canDeleteJob({ status: "cancelled" })).toBe(true);
    expect(canDeleteJob({ status: "failed" })).toBe(true);
    expect(canDeleteJob({ status: "queued" })).toBe(false);
    expect(canDeleteJob({ status: "running" })).toBe(false);
    expect(canDeleteJob({ status: "waiting_verification" })).toBe(false);
  });

  it("returns to the previous page after deleting its last task", () => {
    expect(pageAfterJobDeletion(3, 1)).toBe(2);
    expect(pageAfterJobDeletion(1, 1)).toBe(1);
    expect(pageAfterJobDeletion(3, 2)).toBe(3);
  });
});

describe("favorite listener mode", () => {
  const listener = {
    enabled: true,
    status: "initializing" as const,
    baselineAwemeId: null,
    cursorAwemeId: null,
    lastCheckedAt: null,
    errorCategory: null,
    errorMessage: null,
    updatedAt: "2026-07-24T00:00:00.000Z",
  };

  it("shows initialization before the listener becomes active", () => {
    const initializing = renderToStaticMarkup(createElement(FavoriteListenerControl, {
      state: listener,
      loading: false,
      busy: false,
      browserActive: false,
      creatorJobsPending: false,
      favoriteJobsPending: false,
      error: null,
      onAction: vi.fn(),
    }));
    const listening = renderToStaticMarkup(createElement(FavoriteListenerControl, {
      state: {
        ...listener,
        status: "listening",
        baselineAwemeId: "7000000000000000400",
        cursorAwemeId: "7000000000000000400",
      },
      loading: false,
      busy: false,
      browserActive: false,
      creatorJobsPending: false,
      favoriteJobsPending: false,
      error: null,
      onAction: vi.fn(),
    }));
    expect(initializing).toContain("监听正在初始化");
    expect(initializing).toContain("只记录当前最新作品作为基线");
    expect(initializing).not.toContain(">监听中<");
    expect(listening).toContain(">监听中<");
    expect(listening).toContain("7000000000000000400");
  });

  it("adds the independent favorites navigation and loading page", () => {
    const navigation = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ["/favorites"] }, createElement(AppShell)));
    const page = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ["/favorites"] }, createElement(FavoritesPage)));
    expect(navigation).toContain("我的收藏");
    expect(page).toContain("我的收藏");
    expect(page).toContain("正在读取收藏");
    expect(page).toContain("同步飞书");
  });
});

describe("Feishu article selection", () => {
  const article = {
    awemeId: "7601484851720380999",
    secUid: "creator",
    title: "可同步文章",
    author: "作者",
    sourceUrl: "https://www.douyin.com/video/7601484851720380999",
    publishedAt: null,
    publishedAtSource: "unknown",
    status: "completed",
    failureCategory: null,
    failureReason: null,
    attempts: 1,
    markdownPath: "creator/articles/article.md",
    mediaPath: null,
    feishuSynced: false,
    discoveredAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:00.000Z",
  } satisfies VideoRecord;

  it("only enables completed articles with a Markdown path", () => {
    expect(canSyncVideo(article)).toBe(true);
    expect(canSyncVideo({ ...article, markdownPath: null })).toBe(false);
    expect(canSyncVideo({ ...article, status: "failed" })).toBe(false);
  });

  it("renders the sync dialog confirmation controls", () => {
    const html = renderToStaticMarkup(createElement(FeishuSyncDialog, {
      open: true,
      source: "creator",
      articles: [article],
      onCancel: vi.fn(),
      onComplete: vi.fn(),
    }));
    expect(html).toContain("同步到飞书知识库");
    expect(html).toContain("已选择 1 篇文章");
    expect(html).toContain("确认同步");
    expect(html).toContain("取消");
  });

  it("renders favorite automatic sync settings with the selected knowledge base", () => {
    const html = renderToStaticMarkup(createElement(FavoriteFeishuSyncSection, {
      configured: true,
      enabled: true,
      spaceId: "space-favorite",
      spaces: [{
        spaceId: "space-favorite",
        name: "收藏知识库",
        description: "自动同步目标",
      }],
      loadingSpaces: false,
      saving: false,
      saved: true,
      error: null,
      onEnabledChange: vi.fn(),
      onSpaceChange: vi.fn(),
      onReload: vi.fn(),
      onSubmit: vi.fn(),
    }));
    expect(html).toContain("收藏飞书同步");
    expect(html).toContain("收藏知识库");
    expect(html).toContain("checked");
    expect(html).toContain("收藏飞书同步设置已保存");
  });

  it("enables the detail action and passes exactly one article to the dialog", () => {
    const detail = {
      ...article,
      markdown: "# 可同步文章",
      articleAvailable: true,
    } satisfies ArticleDetail;
    const html = renderToStaticMarkup(createElement(
      MemoryRouter,
      null,
      createElement(ArticleDetailView, {
        article: detail,
        html: "<h1>可同步文章</h1>",
        syncOpen: true,
        onSyncOpenChange: vi.fn(),
      }),
    ));
    const action = html.match(/<button[^>]*data-article-feishu-sync="true"[^>]*>/)?.[0] ?? "";
    expect(canSyncArticleDetail(detail)).toBe(true);
    expect(action).not.toContain("disabled");
    expect(html).toContain("同步飞书");
    expect(html).toContain("已选择 1 篇文章");
  });

  it("keeps the detail action disabled and explains why the article is unavailable", () => {
    const missingFile = {
      ...article,
      markdown: null,
      articleAvailable: false,
    } satisfies ArticleDetail;
    const html = renderToStaticMarkup(createElement(
      MemoryRouter,
      null,
      createElement(ArticleDetailView, {
        article: missingFile,
        html: "",
        syncOpen: false,
        onSyncOpenChange: vi.fn(),
      }),
    ));
    const action = html.match(/<button[^>]*data-article-feishu-sync="true"[^>]*>/)?.[0] ?? "";
    expect(canSyncArticleDetail(missingFile)).toBe(false);
    expect(articleSyncUnavailableReason(missingFile)).toContain("Markdown 文件不可用");
    expect(action).toContain("disabled");
    expect(html).toContain("Markdown 文件不可用，暂时无法同步飞书");

    const transcribing = { ...missingFile, status: "transcribing" as const, markdownPath: null };
    expect(articleSyncUnavailableReason(transcribing)).toContain("文章尚未生成");
  });
});
