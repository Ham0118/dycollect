import type { BrowserContext, Page } from "playwright";
import type { DebugBrowserState, DebugBrowserStatus } from "@dycollect/shared";
import { BROWSER_PROFILE_DIR, DEFAULT_TIMEOUT_MS } from "./config.js";
import { launchPersistentChromium } from "./douyin.js";

export const DOUYIN_DEBUG_URL = "https://www.douyin.com/";

export type DebugBrowserLauncher = (userDataDir: string) => Promise<BrowserContext>;

export class DebugBrowserController {
  private context: BrowserContext | null = null;
  private status: DebugBrowserStatus = "closed";
  private opening: Promise<DebugBrowserState> | null = null;

  constructor(
    private readonly userDataDir = BROWSER_PROFILE_DIR,
    private readonly launcher: DebugBrowserLauncher = launchPersistentChromium,
  ) {}

  getState(): DebugBrowserState {
    return { status: this.status };
  }

  isActive(): boolean {
    return this.status !== "closed";
  }

  open(): Promise<DebugBrowserState> {
    if (this.status === "open") return Promise.resolve(this.getState());
    if (this.opening) return this.opening;
    this.status = "opening";
    this.opening = this.launch().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  async close(): Promise<void> {
    await this.opening?.catch(() => undefined);
    const context = this.context;
    this.context = null;
    this.status = "closed";
    await context?.close().catch(() => undefined);
  }

  private async launch(): Promise<DebugBrowserState> {
    try {
      const context = await this.launcher(this.userDataDir);
      this.context = context;
      context.once("close", () => {
        if (this.context === context) this.context = null;
        this.status = "closed";
      });
      this.status = "open";
      const page = context.pages()[0] ?? await context.newPage();
      await this.openDouyinHome(page);
      return this.getState();
    } catch (error) {
      this.context = null;
      this.status = "closed";
      throw error;
    }
  }

  private async openDouyinHome(page: Page): Promise<void> {
    await page.goto(DOUYIN_DEBUG_URL, {
      waitUntil: "domcontentloaded",
      timeout: DEFAULT_TIMEOUT_MS,
    }).catch(() => undefined);
  }
}
