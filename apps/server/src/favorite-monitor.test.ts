import { describe, expect, it, vi } from "vitest";
import type { ProfileWork } from "./douyin.js";
import type { DyCollectDatabase } from "./db.js";
import { FavoriteMonitor, selectNewFavoriteWorks } from "./favorite-monitor.js";

const work = (awemeId: string): ProfileWork => ({
  awemeId,
  title: `作品 ${awemeId}`,
  url: `https://www.douyin.com/video/${awemeId}`,
});

describe("favorite monitor boundaries", () => {
  it("treats the first item as the boundary when nothing changed", () => {
    expect(selectNewFavoriteWorks(
      [work("300"), work("200")],
      new Set(["300", "200"]),
      new Set(),
    )).toEqual([]);
    expect(selectNewFavoriteWorks([], new Set(["300"]), new Set())).toEqual([]);
  });

  it("returns only the newest prefix and preserves page order", () => {
    expect(selectNewFavoriteWorks(
      [work("500"), work("400"), work("300"), work("200")],
      new Set(["300", "200"]),
      new Set(),
    ).map((item) => item.awemeId)).toEqual(["500", "400"]);
  });

  it("uses any database record as the known boundary", () => {
    expect(selectNewFavoriteWorks(
      [work("500"), work("400"), work("300")],
      new Set(),
      new Set(["400"]),
    ).map((item) => item.awemeId)).toEqual(["500"]);
  });

  it("does not treat older items revealed after an unfavorite as new", () => {
    expect(selectNewFavoriteWorks(
      [work("200"), work("100"), work("50")],
      new Set(["300", "200", "100"]),
      new Set(),
    )).toEqual([]);
  });

  it("accepts all visible works only after an explicitly empty initialization baseline", () => {
    expect(selectNewFavoriteWorks(
      [work("200"), work("100")],
      new Set(),
      new Set(),
      true,
    ).map((item) => item.awemeId)).toEqual(["200", "100"]);
  });

  it("stops safely when no memory or database boundary can be found", () => {
    expect(() => selectNewFavoriteWorks(
      [work("500"), work("400")],
      new Set(["300"]),
      new Set(),
    ))
      .toThrow("无法确认收藏列表的新增边界");
  });
});

describe("favorite monitor deduplication", () => {
  it("checks the database, enqueues only the new prefix, and learns the whole visible page", async () => {
    const database = {
      findExistingFavoriteIds: vi.fn(() => new Set<string>()),
      enqueueFavoriteWorks: vi.fn(() => []),
      updateFavoriteListener: vi.fn(),
    } as unknown as DyCollectDatabase;
    const monitor = new FavoriteMonitor(database);
    (monitor as unknown as { knownFavoriteIds: Set<string> }).knownFavoriteIds = new Set(["300"]);
    const processSnapshot = (monitor as unknown as {
      processSnapshot: (works: ProfileWork[]) => Promise<void>;
    }).processSnapshot.bind(monitor);

    await processSnapshot([work("500"), work("400"), work("300"), work("200")]);

    expect(database.findExistingFavoriteIds).toHaveBeenCalledWith(["500", "400", "300", "200"]);
    expect(database.enqueueFavoriteWorks).toHaveBeenCalledWith(
      [work("400"), work("500")],
      "500",
    );
    expect((monitor as unknown as { knownFavoriteIds: Set<string> }).knownFavoriteIds)
      .toEqual(new Set(["500", "400", "300", "200"]));

    await processSnapshot([work("300"), work("200"), work("100")]);
    expect(database.enqueueFavoriteWorks).toHaveBeenCalledTimes(1);
    expect(database.updateFavoriteListener).toHaveBeenCalledWith(expect.objectContaining({
      cursorAwemeId: "300",
    }));
    expect((monitor as unknown as { knownFavoriteIds: Set<string> }).knownFavoriteIds.has("100")).toBe(true);
  });
});

describe("favorite processing page focus", () => {
  it("restores the listener page after opening the background processing page", async () => {
    const processingSession = {
      openUtilityPage: vi.fn(async () => undefined),
    };
    const ownerSession = {
      createSibling: vi.fn(async () => processingSession),
      bringToFront: vi.fn(async () => undefined),
    };
    const monitor = new FavoriteMonitor({} as DyCollectDatabase);
    (monitor as unknown as { ownerSession: unknown }).ownerSession = ownerSession;

    await expect(monitor.acquireProcessingSession()).resolves.toBe(processingSession);
    expect(ownerSession.createSibling).toHaveBeenCalledWith(true);
    expect(processingSession.openUtilityPage).toHaveBeenCalledOnce();
    expect(ownerSession.bringToFront).toHaveBeenCalledOnce();
    expect(processingSession.openUtilityPage.mock.invocationCallOrder[0])
      .toBeLessThan(ownerSession.bringToFront.mock.invocationCallOrder[0]!);
  });
});
