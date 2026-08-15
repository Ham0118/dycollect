import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  FavoriteVideoRecord,
  FeishuSettingsView,
  FeishuSpace,
  FeishuSyncItemResult,
  FeishuSyncResult,
  FeishuSyncSource,
  VideoRecord,
} from "@dycollect/shared";
import { DATA_DIR, DEFAULT_TIMEOUT_MS } from "./config.js";
import { DyCollectDatabase, type FeishuCredentials, type FeishuSyncRecord } from "./db.js";
import { AppError } from "./errors.js";
import { markdownToFeishu, type FeishuBlock } from "./feishu-markdown.js";
import { resolveWithin, sleep } from "./utils.js";

const FEISHU_BASE_URL = "https://open.feishu.cn/open-apis";
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1_000;
const BLOCKS_PER_REQUEST = 50;
const TOKEN_ERROR_CODES = new Set([99991663, 99991665, 99991671]);

interface TenantTokenResponse {
  code: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
}

interface FeishuResponse<T> {
  code: number;
  msg?: string;
  data?: T;
}

interface CachedToken {
  appId: string;
  value: string;
  expiresAt: number;
}

export type FeishuFetch = typeof fetch;

export class FeishuService {
  private token: CachedToken | null = null;
  private syncQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly database: DyCollectDatabase,
    private readonly dataDir = DATA_DIR,
    private readonly fetcher: FeishuFetch = fetch,
  ) {}

  getSettingsView(): FeishuSettingsView {
    const credentials = this.database.getFeishuCredentials();
    return {
      appId: credentials?.appId ?? "",
      appSecretConfigured: Boolean(credentials?.appSecret),
      favoriteAutoSync: this.database.getFavoriteFeishuAutoSyncSettings(),
      updatedAt: credentials?.updatedAt ?? null,
    };
  }

  async saveSettings(appIdInput: string, appSecretInput?: string): Promise<FeishuSettingsView> {
    const appId = appIdInput.trim();
    const existing = this.database.getFeishuCredentials();
    const suppliedSecret = appSecretInput?.trim() ?? "";
    if (!appId || appId.length > 128) throw new AppError("parse_error", "请输入有效的飞书 App ID");
    if ((!existing || existing.appId !== appId) && !suppliedSecret) {
      throw new AppError("parse_error", "首次配置或修改 App ID 时必须填写 App Secret");
    }
    const appSecret = suppliedSecret || existing?.appSecret || "";
    if (!appSecret || appSecret.length > 512) throw new AppError("parse_error", "请输入有效的飞书 App Secret");

    const freshToken = await this.requestTenantToken({ appId, appSecret, updatedAt: "" });
    this.database.saveFeishuCredentials(appId, appSecret);
    this.token = { appId, value: freshToken.value, expiresAt: freshToken.expiresAt };
    return this.getSettingsView();
  }

  async saveFavoriteAutoSyncSettings(
    enabled: boolean,
    spaceIdInput: string | null,
  ): Promise<FeishuSettingsView> {
    if (!this.database.getFeishuCredentials()) {
      throw new AppError("feishu_not_configured", "请先配置飞书 App ID 和 App Secret");
    }
    const spaceId = spaceIdInput?.trim() || null;
    if (spaceId && !/^[A-Za-z0-9_-]{1,128}$/.test(spaceId)) {
      throw new AppError("parse_error", "请选择有效的飞书知识库");
    }
    if (enabled) {
      if (!spaceId) throw new AppError("parse_error", "开启自动同步前请选择目标知识库");
      const spaces = await this.listSpaces();
      if (!spaces.some((space) => space.spaceId === spaceId)) {
        throw new AppError("parse_error", "目标知识库不可用，请刷新后重新选择");
      }
    }
    this.database.saveFavoriteFeishuAutoSyncSettings(enabled, spaceId);
    return this.getSettingsView();
  }

  async listSpaces(): Promise<FeishuSpace[]> {
    const spaces: FeishuSpace[] = [];
    let pageToken = "";
    for (let page = 0; page < 100; page += 1) {
      const query = new URLSearchParams({ page_size: "50" });
      if (pageToken) query.set("page_token", pageToken);
      const data = await this.authorizedRequest<{
        items?: Array<{ space_id?: string; name?: string; description?: string }>;
        has_more?: boolean;
        page_token?: string;
      }>(`/wiki/v2/spaces?${query}`);
      for (const item of data.items ?? []) {
        if (!item.space_id) continue;
        spaces.push({
          spaceId: item.space_id,
          name: item.name?.trim() || `知识库 ${item.space_id}`,
          description: item.description?.trim() || null,
        });
      }
      if (!data.has_more) break;
      if (!data.page_token || data.page_token === pageToken) {
        throw new AppError("feishu_error", "飞书知识库分页响应无效");
      }
      pageToken = data.page_token;
    }
    return spaces.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  }

  syncArticles(
    source: FeishuSyncSource,
    spaceIdInput: string,
    awemeIdsInput: string[],
  ): Promise<FeishuSyncResult> {
    const task = async () => this.performSync(source, spaceIdInput, awemeIdsInput);
    const run = this.syncQueue.then(task, task);
    this.syncQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async performSync(
    source: FeishuSyncSource,
    spaceIdInput: string,
    awemeIdsInput: string[],
  ): Promise<FeishuSyncResult> {
    if (source !== "creator" && source !== "favorite") {
      throw new AppError("parse_error", "飞书同步来源无效");
    }
    const spaceId = spaceIdInput.trim();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(spaceId)) {
      throw new AppError("parse_error", "请选择有效的飞书知识库");
    }
    if (!Array.isArray(awemeIdsInput)) throw new AppError("parse_error", "同步文章列表无效");
    const awemeIds = [...new Set(awemeIdsInput.map((value) => String(value).trim()))];
    if (awemeIds.length < 1 || awemeIds.length > 50 || awemeIds.some((id) => !/^\d{8,32}$/.test(id))) {
      throw new AppError("parse_error", "每次请选择 1 到 50 篇有效文章进行同步");
    }
    await this.getTenantToken();

    const items: FeishuSyncItemResult[] = [];
    for (const awemeId of awemeIds) items.push(await this.syncOne(source, spaceId, awemeId));
    return {
      spaceId,
      total: items.length,
      synced: items.filter((item) => item.status === "synced").length,
      skipped: items.filter((item) => item.status === "skipped").length,
      failed: items.filter((item) => item.status === "failed").length,
      items,
    };
  }

  private async syncOne(
    source: FeishuSyncSource,
    spaceId: string,
    awemeId: string,
  ): Promise<FeishuSyncItemResult> {
    const video = source === "favorite"
      ? this.database.getFavoriteVideo(awemeId)
      : this.database.getVideo(awemeId);
    const title = video?.title?.trim() || `无标题 ${awemeId}`;
    if (!video) return failedItem(awemeId, title, "作品不存在");

    let record = this.getSyncRecord(source, awemeId, spaceId);
    if (record?.status === "synced") {
      this.completeSyncRecord(source, awemeId, spaceId, record.writtenBlocks);
      return { awemeId, title, status: "skipped", message: "已同步到该知识库，已跳过" };
    }
    if (video.status !== "completed" || !video.markdownPath) {
      return failedItem(awemeId, title, "文章尚未生成，无法同步");
    }

    try {
      const markdown = await this.readMarkdown(source, video);
      const content = markdownToFeishu(markdown);
      const documentTitle = normalizeDocumentTitle(content.title || title, awemeId);
      if (!record) {
        const node = await this.createNode(spaceId, documentTitle);
        record = this.createSyncRecord(source, {
          awemeId,
          spaceId,
          nodeToken: node.nodeToken,
          documentId: node.documentId,
        });
      }
      await this.writeRemainingBlocks(source, record, content.blocks, markdown);
      this.completeSyncRecord(source, awemeId, spaceId, content.blocks.length);
      return { awemeId, title, status: "synced", message: "同步成功" };
    } catch (error) {
      const message = publicErrorMessage(error);
      if (record || this.getSyncRecord(source, awemeId, spaceId)) {
        this.failSyncRecord(source, awemeId, spaceId, message);
      }
      return failedItem(awemeId, title, message);
    }
  }

  private async readMarkdown(
    source: FeishuSyncSource,
    video: VideoRecord | FavoriteVideoRecord,
  ): Promise<string> {
    const dataFile = video.markdownPath ? resolveWithin(this.dataDir, video.markdownPath) : null;
    const articleRoot = source === "favorite"
      ? resolve(this.dataDir, "favorites", "articles")
      : resolve(this.dataDir, (video as VideoRecord).secUid, "articles");
    const file = dataFile && resolveWithin(articleRoot, dataFile) ? dataFile : null;
    if (!file || !await access(file).then(() => true, () => false)) {
      throw new AppError("feishu_error", "文章文件不存在或不可读取");
    }
    return readFile(file, "utf8");
  }

  private async createNode(spaceId: string, title: string): Promise<{ nodeToken: string; documentId: string }> {
    const data = await this.authorizedRequest<{
      node?: { node_token?: string; obj_token?: string };
    }>(`/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes`, {
      method: "POST",
      body: JSON.stringify({ obj_type: "docx", node_type: "origin", title }),
    });
    const nodeToken = data.node?.node_token;
    const documentId = data.node?.obj_token;
    if (!nodeToken || !documentId) throw new AppError("feishu_error", "飞书没有返回新文档标识");
    return { nodeToken, documentId };
  }

  private async writeRemainingBlocks(
    source: FeishuSyncSource,
    record: FeishuSyncRecord,
    blocks: FeishuBlock[],
    markdown: string,
  ): Promise<void> {
    let written = Math.min(record.writtenBlocks, blocks.length);
    while (written < blocks.length) {
      const chunk = blocks.slice(written, written + BLOCKS_PER_REQUEST);
      const clientToken = createHash("sha256")
        .update(`${source}:${record.spaceId}:${record.awemeId}:${written}:${markdown}`)
        .digest("hex")
        .slice(0, 32);
      const query = new URLSearchParams({ document_revision_id: "-1", client_token: clientToken });
      const documentId = encodeURIComponent(record.documentId);
      await this.authorizedRequest(
        `/docx/v1/documents/${documentId}/blocks/${documentId}/children?${query}`,
        { method: "POST", body: JSON.stringify({ index: written, children: chunk }) },
      );
      written += chunk.length;
      this.updateSyncProgress(source, record.awemeId, record.spaceId, written);
    }
  }

  private getSyncRecord(
    source: FeishuSyncSource,
    awemeId: string,
    spaceId: string,
  ): FeishuSyncRecord | null {
    return source === "favorite"
      ? this.database.getFavoriteFeishuSync(awemeId, spaceId)
      : this.database.getFeishuSync(awemeId, spaceId);
  }

  private createSyncRecord(
    source: FeishuSyncSource,
    input: {
      awemeId: string;
      spaceId: string;
      nodeToken: string;
      documentId: string;
    },
  ): FeishuSyncRecord {
    return source === "favorite"
      ? this.database.createFavoriteFeishuSync(input)
      : this.database.createFeishuSync(input);
  }

  private updateSyncProgress(
    source: FeishuSyncSource,
    awemeId: string,
    spaceId: string,
    writtenBlocks: number,
  ): void {
    if (source === "favorite") {
      this.database.updateFavoriteFeishuSyncProgress(awemeId, spaceId, writtenBlocks);
    } else {
      this.database.updateFeishuSyncProgress(awemeId, spaceId, writtenBlocks);
    }
  }

  private completeSyncRecord(
    source: FeishuSyncSource,
    awemeId: string,
    spaceId: string,
    writtenBlocks: number,
  ): void {
    if (source === "favorite") {
      this.database.completeFavoriteFeishuSync(awemeId, spaceId, writtenBlocks);
    } else {
      this.database.completeFeishuSync(awemeId, spaceId, writtenBlocks);
    }
  }

  private failSyncRecord(
    source: FeishuSyncSource,
    awemeId: string,
    spaceId: string,
    message: string,
  ): void {
    if (source === "favorite") {
      this.database.failFavoriteFeishuSync(awemeId, spaceId, message);
    } else {
      this.database.failFeishuSync(awemeId, spaceId, message);
    }
  }

  private async getTenantToken(force = false): Promise<string> {
    const credentials = this.database.getFeishuCredentials();
    if (!credentials) throw new AppError("feishu_not_configured", "请先在设置中配置飞书 App ID 和 App Secret");
    if (!force && this.token?.appId === credentials.appId && this.token.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) {
      return this.token.value;
    }
    const token = await this.requestTenantToken(credentials);
    this.token = { appId: credentials.appId, ...token };
    return token.value;
  }

  private async requestTenantToken(credentials: FeishuCredentials): Promise<{ value: string; expiresAt: number }> {
    const response = await this.fetchJson<TenantTokenResponse>("/auth/v3/tenant_access_token/internal", {
      method: "POST",
      body: JSON.stringify({ app_id: credentials.appId, app_secret: credentials.appSecret }),
    }, false);
    if (response.code !== 0 || !response.tenant_access_token || !response.expire) {
      throw new AppError("feishu_error", `飞书应用凭证验证失败：${safeFeishuMessage(response.msg, response.code)}`);
    }
    return {
      value: response.tenant_access_token,
      expiresAt: Date.now() + Math.max(60, response.expire) * 1_000,
    };
  }

  private async authorizedRequest<T = Record<string, unknown>>(
    path: string,
    init: RequestInit = {},
    retryToken = true,
  ): Promise<T> {
    const token = await this.getTenantToken();
    const response = await this.fetchJson<FeishuResponse<T>>(path, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...init.headers },
    });
    if (response.code === 0 && response.data) return response.data;
    if (retryToken && TOKEN_ERROR_CODES.has(response.code)) {
      this.token = null;
      return this.authorizedRequest<T>(path, init, false);
    }
    throw new AppError("feishu_error", `飞书接口调用失败：${safeFeishuMessage(response.msg, response.code)}`);
  }

  private async fetchJson<T>(path: string, init: RequestInit, retryTransient = true): Promise<T> {
    const attempts = retryTransient ? 3 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await this.fetcher(`${FEISHU_BASE_URL}${path}`, {
          ...init,
          headers: { "Content-Type": "application/json; charset=utf-8", ...init.headers },
          signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        });
        if ((response.status === 429 || response.status >= 500) && attempt + 1 < attempts) {
          await sleep(250 * 2 ** attempt);
          continue;
        }
        if (!response.ok) throw new AppError("feishu_error", httpErrorMessage(response.status));
        return await response.json() as T;
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (attempt + 1 < attempts) {
          await sleep(250 * 2 ** attempt);
          continue;
        }
        const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        throw new AppError("feishu_error", timedOut ? "连接飞书超时，请稍后重试" : "无法连接飞书开放平台");
      }
    }
    throw new AppError("feishu_error", "无法连接飞书开放平台");
  }
}

function normalizeDocumentTitle(value: string, awemeId: string): string {
  return (value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim() || `无标题 ${awemeId}`).slice(0, 255);
}

function failedItem(awemeId: string, title: string, message: string): FeishuSyncItemResult {
  return { awemeId, title, status: "failed", message };
}

function publicErrorMessage(error: unknown): string {
  if (error instanceof AppError) return error.message;
  return "同步文章时发生未知错误";
}

function safeFeishuMessage(message: string | undefined, code: number): string {
  const cleaned = message?.replace(/[\r\n]+/g, " ").slice(0, 240).trim();
  return cleaned || `错误码 ${code}`;
}

function httpErrorMessage(status: number): string {
  if (status === 401) return "飞书访问凭证无效";
  if (status === 403) return "飞书应用没有访问该知识库的权限";
  if (status === 429) return "飞书请求过于频繁，请稍后重试";
  return `飞书开放平台暂时不可用（HTTP ${status}）`;
}
