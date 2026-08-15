import express, { type ErrorRequestHandler } from "express";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { createApi, createEventsHandler } from "./api.js";
import { AsrSettingsService } from "./asr-settings.js";
import { DATABASE_PATH, HOST, PORT, WEB_DIST_DIR } from "./config.js";
import { DyCollectDatabase } from "./db.js";
import { DeletionService } from "./deletion.js";
import { DebugBrowserController } from "./debug-browser.js";
import { AppError, toAppError } from "./errors.js";
import { FeishuService } from "./feishu.js";
import { FavoriteMonitor } from "./favorite-monitor.js";
import { ModelStatusService } from "./model-status.js";
import { configureQwenAsrDevice, shutdownQwenAsr } from "./qwen-asr.js";
import { CrawlWorker } from "./worker.js";

const database = new DyCollectDatabase(DATABASE_PATH);
const modelStatus = new ModelStatusService();
configureQwenAsrDevice(() => database.getAsrDevice());
const asrSettings = new AsrSettingsService(database);
const deletionService = new DeletionService(database);
const feishuService = new FeishuService(database);
await deletionService.cleanupTrash().catch((error) => {
  console.error(`[删除清理] 启动时清理隔离目录失败：${error instanceof Error ? error.message : String(error)}`);
});
const debugBrowser = new DebugBrowserController();
const favoriteMonitor = new FavoriteMonitor(database);
const worker = new CrawlWorker(database, debugBrowser, favoriteMonitor, feishuService, modelStatus);
if (await modelStatus.isReady()) {
  favoriteMonitor.startFromPersistedState();
} else if (database.getFavoriteListenerState().enabled) {
  database.updateFavoriteListener({
    status: "error",
    errorCategory: "model_missing",
    errorMessage: "未检测到 Qwen3-ASR 模型，请运行 npm run setup:model 后恢复监听",
  });
}
worker.start();

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.get("/events", createEventsHandler(database, debugBrowser, worker));
app.use("/api", createApi(
  database,
  worker,
  debugBrowser,
  deletionService,
  feishuService,
  favoriteMonitor,
  modelStatus,
  asrSettings,
));

const hasWebBuild = await access(resolve(WEB_DIST_DIR, "index.html")).then(() => true, () => false);
if (hasWebBuild) {
  app.use(express.static(WEB_DIST_DIR, { index: false, maxAge: "1h" }));
  app.use((request, response, next) => {
    if (request.method !== "GET" || request.path.startsWith("/api/") || request.path === "/events") return next();
    response.sendFile(resolve(WEB_DIST_DIR, "index.html"));
  });
} else {
  app.get("/", (_request, response) => {
    response.type("text/plain").send("DyCollect API 已启动。开发界面请访问 http://localhost:5173");
  });
}

const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  const appError = error instanceof AppError ? error : toAppError(error);
  const status = appError.category === "parse_error"
    ? 400
    : ["feishu_not_configured", "model_missing", "asr_device_unavailable"].includes(appError.category)
      ? 409
      : appError.category === "feishu_error"
        ? 502
        : 500;
  response.status(status).json({ error: appError.category, message: appError.message });
};
app.use(errorHandler);

const server = app.listen(PORT, HOST, () => {
  console.log(`DyCollect 已启动：http://localhost:${PORT}`);
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  await worker.stop();
  await favoriteMonitor.shutdown();
  await debugBrowser.close();
  shutdownQwenAsr();
  database.close();
}

process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
