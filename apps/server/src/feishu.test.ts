import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DyCollectDatabase } from "./db.js";
import { FeishuService } from "./feishu.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(markdown = "# 同步文章\n\n- 作者：测试\n\n## 转录正文\n\n正文内容") {
  const root = await mkdtemp(join(tmpdir(), "dycollect-feishu-"));
  temporaryDirectories.push(root);
  const dataDir = join(root, "data");
  const secUid = "creator-feishu";
  const awemeId = "7601484851720380999";
  const markdownPath = join(secUid, "articles", "article.md");
  const absolute = join(dataDir, markdownPath);
  const favoriteMarkdownPath = join("favorites", "articles", "favorite.md");
  const favoriteAbsolute = join(dataDir, favoriteMarkdownPath);
  await mkdir(join(dataDir, secUid, "articles"), { recursive: true });
  await mkdir(join(dataDir, "favorites", "articles"), { recursive: true });
  await writeFile(absolute, markdown, "utf8");
  await writeFile(favoriteAbsolute, markdown.replace("同步文章", "收藏同步文章"), "utf8");
  const database = new DyCollectDatabase(join(dataDir, "archive.sqlite3"));
  database.upsertCreator(secUid, `https://www.douyin.com/user/${secUid}`, "测试作者", 1);
  database.upsertDiscoveredVideo({
    awemeId,
    secUid,
    title: "同步文章",
    author: "测试作者",
    sourceUrl: `https://www.douyin.com/video/${awemeId}`,
    publishedAt: "2026-01-31T11:23:30.000Z",
    publishedAtSource: "aweme_id",
  });
  database.updateVideo(awemeId, {
    status: "completed",
    markdownPath,
    completedAt: "2026-01-31T11:30:00.000Z",
  });
  database.upsertDiscoveredFavorite({
    awemeId,
    title: "收藏同步文章",
    author: "收藏作者",
    sourceUrl: `https://www.douyin.com/video/${awemeId}`,
    publishedAt: "2026-01-31T11:23:30.000Z",
    publishedAtSource: "aweme_id",
  });
  database.updateFavoriteVideo(awemeId, {
    status: "completed",
    markdownPath: favoriteMarkdownPath,
    completedAt: "2026-01-31T11:30:00.000Z",
  });
  return { database, dataDir, awemeId };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("FeishuService settings and spaces", () => {
  it("validates credentials, redacts the secret and paginates spaces with one cached token", async () => {
    const { database, dataDir } = await fixture();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("tenant_access_token")) return response({ code: 0, tenant_access_token: "t-secret", expire: 7200 });
      if (url.includes("page_token=next")) return response({ code: 0, data: { items: [{ space_id: "2", name: "乙知识库" }], has_more: false } });
      return response({ code: 0, data: { items: [{ space_id: "1", name: "甲知识库", description: "说明" }], has_more: true, page_token: "next" } });
    });
    const service = new FeishuService(database, dataDir, fetchMock as unknown as typeof fetch);

    await service.saveSettings("cli_test", "app-secret");
    expect(service.getSettingsView()).toEqual(expect.objectContaining({ appId: "cli_test", appSecretConfigured: true }));
    expect(service.getSettingsView()).not.toHaveProperty("appSecret");
    expect(service.getSettingsView().favoriteAutoSync).toEqual({ enabled: false, spaceId: null });
    await expect(service.saveFavoriteAutoSyncSettings(true, "missing-space"))
      .rejects.toThrow("目标知识库不可用");
    await service.saveFavoriteAutoSyncSettings(true, "1");
    expect(service.getSettingsView().favoriteAutoSync).toEqual({ enabled: true, spaceId: "1" });
    expect(await service.listSpaces()).toEqual([
      { spaceId: "1", name: "甲知识库", description: "说明" },
      { spaceId: "2", name: "乙知识库", description: null },
    ]);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("tenant_access_token"))).toHaveLength(1);
    database.close();
  });
});

describe("FeishuService article sync", () => {
  it("syncs creator and favorite records with the same ID independently", async () => {
    const { database, dataDir, awemeId } = await fixture();
    let nodeCalls = 0;
    const writeUrls: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("tenant_access_token")) {
        return response({ code: 0, tenant_access_token: "t-secret", expire: 7200 });
      }
      if (url.includes("/nodes")) {
        nodeCalls += 1;
        return response({
          code: 0,
          data: {
            node: {
              node_token: `wik-node-${nodeCalls}`,
              obj_token: `doc-id-${nodeCalls}`,
            },
          },
        });
      }
      if (url.includes("/children?")) {
        writeUrls.push(url);
        return response({ code: 0, data: { children: [] } });
      }
      throw new Error(`unexpected request ${url}`);
    }) as unknown as typeof fetch;
    const service = new FeishuService(database, dataDir, fetcher);
    await service.saveSettings("cli_test", "app-secret");

    expect((await service.syncArticles("creator", "space-one", [awemeId])).synced).toBe(1);
    expect((await service.syncArticles("favorite", "space-one", [awemeId])).synced).toBe(1);
    expect(nodeCalls).toBe(2);
    expect(database.getFeishuSync(awemeId, "space-one")).toMatchObject({
      status: "synced",
      documentId: "doc-id-1",
    });
    expect(database.getFavoriteFeishuSync(awemeId, "space-one")).toMatchObject({
      status: "synced",
      documentId: "doc-id-2",
    });
    expect(new URL(writeUrls[0]!).searchParams.get("client_token"))
      .not.toBe(new URL(writeUrls[1]!).searchParams.get("client_token"));
    database.close();
  });

  it("creates a document once, writes blocks and skips an already-synced article", async () => {
    const { database, dataDir, awemeId } = await fixture();
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.includes("tenant_access_token")) return response({ code: 0, tenant_access_token: "t-secret", expire: 7200 });
      if (url.includes("/wiki/v2/spaces/space-one/nodes")) return response({ code: 0, data: { node: { node_token: "wik-node", obj_token: "doc-id" } } });
      if (url.includes("/children?")) return response({ code: 0, data: { children: [] } });
      throw new Error(`unexpected request ${url}`);
    }) as unknown as typeof fetch;
    const service = new FeishuService(database, dataDir, fetcher);
    await service.saveSettings("cli_test", "app-secret");

    const first = await service.syncArticles("creator", "space-one", [awemeId, awemeId]);
    expect(first).toEqual(expect.objectContaining({ total: 1, synced: 1, skipped: 0, failed: 0 }));
    const nodeCall = calls.find((call) => call.url.includes("/wiki/v2/spaces/space-one/nodes"));
    expect(nodeCall?.body).toEqual(expect.objectContaining({ obj_type: "docx", node_type: "origin", title: "同步文章" }));
    const blockCall = calls.find((call) => call.url.includes("/children?"));
    expect(blockCall?.url).toContain("client_token=");
    expect(blockCall?.body).toEqual(expect.objectContaining({ index: 0 }));

    const second = await service.syncArticles("creator", "space-one", [awemeId]);
    expect(second).toEqual(expect.objectContaining({ synced: 0, skipped: 1, failed: 0 }));
    expect(calls.filter((call) => call.url.includes("/wiki/v2/spaces/space-one/nodes"))).toHaveLength(1);
    database.close();
  });

  it("reuses the created document after a write failure", async () => {
    const { database, dataDir, awemeId } = await fixture();
    let nodeCalls = 0;
    let writeCalls = 0;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("tenant_access_token")) return response({ code: 0, tenant_access_token: "t-secret", expire: 7200 });
      if (url.includes("/nodes")) {
        nodeCalls += 1;
        return response({ code: 0, data: { node: { node_token: "wik-node", obj_token: "doc-id" } } });
      }
      if (url.includes("/children?")) {
        writeCalls += 1;
        return writeCalls === 1
          ? response({ code: 1770001, msg: "invalid param" })
          : response({ code: 0, data: { children: [] } });
      }
      throw new Error(`unexpected request ${url}`);
    }) as unknown as typeof fetch;
    const service = new FeishuService(database, dataDir, fetcher);
    await service.saveSettings("cli_test", "app-secret");

    expect((await service.syncArticles("creator", "space-one", [awemeId])).failed).toBe(1);
    expect(database.getFeishuSync(awemeId, "space-one")?.status).toBe("failed");
    expect((await service.syncArticles("creator", "space-one", [awemeId])).synced).toBe(1);
    expect(nodeCalls).toBe(1);
    expect(writeCalls).toBe(2);
    expect(database.getFeishuSync(awemeId, "space-one")?.status).toBe("synced");
    database.close();
  });
});
