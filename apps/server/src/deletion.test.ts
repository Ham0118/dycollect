import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { FavoriteVideoRecord, VideoRecord } from "@dycollect/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DyCollectDatabase } from "./db.js";
import { DeletionService } from "./deletion.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dycollect-delete-"));
  temporaryDirectories.push(root);
  const dataRoot = join(root, "data");
  const database = new DyCollectDatabase(join(root, "archive.sqlite3"));
  const service = new DeletionService(database, dataRoot);
  return { root, dataRoot, database, service };
}

function addVideo(database: DyCollectDatabase, secUid: string, awemeId: string): VideoRecord {
  database.upsertCreator(secUid, `https://www.douyin.com/user/${secUid}`, "删除测试", 1);
  return database.upsertDiscoveredVideo({
    awemeId,
    secUid,
    title: "待删除作品",
    author: "删除测试",
    sourceUrl: `https://www.douyin.com/video/${awemeId}`,
    publishedAt: null,
    publishedAtSource: "unknown",
  });
}

function addFavorite(database: DyCollectDatabase, awemeId: string): FavoriteVideoRecord {
  return database.upsertDiscoveredFavorite({
    awemeId,
    title: "待删除收藏",
    author: "收藏作者",
    sourceUrl: `https://www.douyin.com/video/${awemeId}`,
    publishedAt: null,
    publishedAtSource: "unknown",
  });
}

describe("DeletionService", () => {
  it("removes an entire creator directory and cascaded database records", async () => {
    const { dataRoot, database, service } = await fixture();
    const secUid = "creator-files";
    addVideo(database, secUid, "7000000000000000101");
    const article = join(dataRoot, secUid, "articles", "article.md");
    const media = join(dataRoot, secUid, "work", "aweme_7000000000000000101.mp4");
    await mkdir(join(dataRoot, secUid, "articles"), { recursive: true });
    await mkdir(join(dataRoot, secUid, "work"), { recursive: true });
    await writeFile(article, "article");
    await writeFile(media, "media");

    await expect(service.deleteCreator(secUid)).resolves.toMatchObject({ deleted: true, deletedVideos: 1 });
    expect(existsSync(join(dataRoot, secUid))).toBe(false);
    expect(database.getCreator(secUid)).toBeNull();
    expect(database.getVideo("7000000000000000101")).toBeNull();
    database.close();
  });

  it("deletes a creator whose data directory contains only empty folders", async () => {
    const { dataRoot, database, service } = await fixture();
    const secUid = "creator-empty-folders";
    database.upsertCreator(secUid, `https://www.douyin.com/user/${secUid}`, "空目录人物", 0);
    await mkdir(join(dataRoot, secUid, "articles"), { recursive: true });
    await mkdir(join(dataRoot, secUid, "work"), { recursive: true });

    await expect(service.deleteCreator(secUid)).resolves.toMatchObject({ deleted: true, deletedVideos: 0 });
    expect(database.getCreator(secUid)).toBeNull();
    expect(existsSync(join(dataRoot, secUid))).toBe(false);
    database.close();
  });

  it("removes only recorded and matching temporary files for one video", async () => {
    const { dataRoot, database, service } = await fixture();
    const secUid = "creator-one-video";
    const awemeId = "7000000000000000201";
    addVideo(database, secUid, awemeId);
    const article = join(dataRoot, secUid, "articles", "article.md");
    const media = join(dataRoot, secUid, "work", `aweme_${awemeId}.mp4`);
    const temporaryMedia = `${media}.tmp-1-2-0`;
    const unrelated = join(dataRoot, secUid, "work", "aweme_7000000000000000202.mp4");
    await mkdir(join(dataRoot, secUid, "articles"), { recursive: true });
    await mkdir(join(dataRoot, secUid, "work"), { recursive: true });
    await Promise.all([
      writeFile(article, "article"),
      writeFile(media, "media"),
      writeFile(temporaryMedia, "temporary"),
      writeFile(unrelated, "keep"),
    ]);
    database.updateVideo(awemeId, {
      markdownPath: relative(dataRoot, article),
      mediaPath: relative(dataRoot, media),
    });

    const video = database.getVideo(awemeId)!;
    await expect(service.deleteVideo(video)).resolves.toMatchObject({ deleted: true, awemeId, secUid });
    expect(existsSync(article)).toBe(false);
    expect(existsSync(media)).toBe(false);
    expect(existsSync(temporaryMedia)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
    expect(database.getVideo(awemeId)).toBeNull();
    database.close();
  });

  it("rejects escaped paths before changing the database", async () => {
    const { root, dataRoot, database, service } = await fixture();
    const secUid = "creator-unsafe";
    const awemeId = "7000000000000000301";
    addVideo(database, secUid, awemeId);
    const outside = join(root, "outside.md");
    await writeFile(outside, "keep");
    database.updateVideo(awemeId, { markdownPath: relative(dataRoot, outside) });

    await expect(service.deleteVideo(database.getVideo(awemeId)!)).rejects.toThrow("超出受控目录");
    expect(database.getVideo(awemeId)).not.toBeNull();
    expect(existsSync(outside)).toBe(true);
    database.close();
  });

  it("restores staged files when the database delete fails", async () => {
    const { dataRoot, database } = await fixture();
    const secUid = "creator-restore";
    const awemeId = "7000000000000000401";
    addVideo(database, secUid, awemeId);
    const media = join(dataRoot, secUid, "work", `aweme_${awemeId}.mp4`);
    await mkdir(join(dataRoot, secUid, "work"), { recursive: true });
    await writeFile(media, "media");
    database.updateVideo(awemeId, { mediaPath: relative(dataRoot, media) });
    const failingDatabase = {
      deleteVideo: vi.fn(() => { throw new Error("database unavailable"); }),
    } as unknown as DyCollectDatabase;
    const service = new DeletionService(failingDatabase, dataRoot);

    await expect(service.deleteVideo(database.getVideo(awemeId)!)).rejects.toThrow("database unavailable");
    expect(existsSync(media)).toBe(true);
    database.close();
  });

  it("removes a favorite article, media, and matching temporary files", async () => {
    const { dataRoot, database, service } = await fixture();
    const awemeId = "7000000000000000501";
    addFavorite(database, awemeId);
    const article = join(dataRoot, "favorites", "articles", "article.md");
    const media = join(dataRoot, "favorites", "work", `aweme_${awemeId}.mp4`);
    const temporaryMedia = `${media}.tmp-1-2-0`;
    const unrelated = join(dataRoot, "favorites", "work", "aweme_7000000000000000502.mp4");
    await mkdir(join(dataRoot, "favorites", "articles"), { recursive: true });
    await mkdir(join(dataRoot, "favorites", "work"), { recursive: true });
    await Promise.all([
      writeFile(article, "article"),
      writeFile(media, "media"),
      writeFile(temporaryMedia, "temporary"),
      writeFile(unrelated, "keep"),
    ]);
    database.updateFavoriteVideo(awemeId, {
      markdownPath: relative(dataRoot, article),
      mediaPath: relative(dataRoot, media),
    });

    await expect(service.deleteFavoriteVideo(database.getFavoriteVideo(awemeId)!))
      .resolves.toEqual({ deleted: true, awemeId });
    expect(existsSync(article)).toBe(false);
    expect(existsSync(media)).toBe(false);
    expect(existsSync(temporaryMedia)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
    expect(database.getFavoriteVideo(awemeId)).toBeNull();
    database.close();
  });

  it("rejects an escaped favorite path before changing the database", async () => {
    const { root, dataRoot, database, service } = await fixture();
    const awemeId = "7000000000000000601";
    addFavorite(database, awemeId);
    const outside = join(root, "outside-favorite.md");
    await writeFile(outside, "keep");
    database.updateFavoriteVideo(awemeId, { markdownPath: relative(dataRoot, outside) });

    await expect(service.deleteFavoriteVideo(database.getFavoriteVideo(awemeId)!))
      .rejects.toThrow("超出受控目录");
    expect(database.getFavoriteVideo(awemeId)).not.toBeNull();
    expect(existsSync(outside)).toBe(true);
    database.close();
  });

  it("restores favorite files when the database delete fails", async () => {
    const { dataRoot, database } = await fixture();
    const awemeId = "7000000000000000701";
    addFavorite(database, awemeId);
    const media = join(dataRoot, "favorites", "work", `aweme_${awemeId}.mp4`);
    await mkdir(join(dataRoot, "favorites", "work"), { recursive: true });
    await writeFile(media, "media");
    database.updateFavoriteVideo(awemeId, { mediaPath: relative(dataRoot, media) });
    const failingDatabase = {
      deleteFavoriteVideo: vi.fn(() => { throw new Error("database unavailable"); }),
    } as unknown as DyCollectDatabase;
    const service = new DeletionService(failingDatabase, dataRoot);

    await expect(service.deleteFavoriteVideo(database.getFavoriteVideo(awemeId)!))
      .rejects.toThrow("database unavailable");
    expect(existsSync(media)).toBe(true);
    database.close();
  });
});
