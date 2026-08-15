import { EventEmitter } from "node:events";
import type { BrowserContext, Page } from "playwright";
import { describe, expect, it, vi } from "vitest";
import { DebugBrowserController, DOUYIN_DEBUG_URL } from "./debug-browser.js";

function fakeBrowser() {
  const events = new EventEmitter();
  const page = { goto: vi.fn(async () => null) } as unknown as Page;
  const close = vi.fn(async () => {
    events.emit("close");
  });
  const context = Object.assign(events, {
    pages: () => [page],
    newPage: vi.fn(async () => page),
    close,
  }) as unknown as BrowserContext;
  return { context, page, close, events };
}

describe("DebugBrowserController", () => {
  it("opens only the Douyin home page and reuses an in-flight launch", async () => {
    const browser = fakeBrowser();
    let release!: (context: BrowserContext) => void;
    const launcher = vi.fn(() => new Promise<BrowserContext>((resolve) => { release = resolve; }));
    const controller = new DebugBrowserController("E:\\profile", launcher);

    const first = controller.open();
    const second = controller.open();
    expect(controller.getState()).toEqual({ status: "opening" });
    expect(first).toBe(second);
    expect(launcher).toHaveBeenCalledOnce();

    release(browser.context);
    await expect(first).resolves.toEqual({ status: "open" });
    expect(browser.page.goto).toHaveBeenCalledWith(DOUYIN_DEBUG_URL, {
      waitUntil: "domcontentloaded",
      timeout: 25_000,
    });
  });

  it("returns to closed when the user closes the browser window", async () => {
    const browser = fakeBrowser();
    const controller = new DebugBrowserController("E:\\profile", async () => browser.context);
    await controller.open();
    browser.events.emit("close");
    expect(controller.getState()).toEqual({ status: "closed" });
  });

  it("closes the browser during service shutdown", async () => {
    const browser = fakeBrowser();
    const controller = new DebugBrowserController("E:\\profile", async () => browser.context);
    await controller.open();
    await controller.close();
    expect(browser.close).toHaveBeenCalledOnce();
    expect(controller.isActive()).toBe(false);
  });
});
