import { access, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { BrowserContext, Page } from "playwright";
import { chromium } from "playwright";
import { AppError } from "./errors.js";
import { probeMedia } from "./media.js";
import { DEFAULT_TIMEOUT_MS } from "./config.js";
import { abortableSleep, sleep } from "./utils.js";

export const MOBILE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 TikTok/26.2.0 TTWebView/TikTokWebView";

const RISK_URL = /(verify|captcha|login|passport)/i;
const RISK_TEXT = /(安全验证|完成验证|扫码登录|验证码登录|密码登录|手机号登录|captcha|verify)/i;

export interface ProfileWork {
  awemeId: string;
  title: string;
  url: string;
}

export interface ProfileSnapshot {
  nickname: string;
  displayedPostCount: number | null;
  works: ProfileWork[];
  scrollHeight: number;
}

export const PROFILE_SELECTORS = Object.freeze({
  root: '#user_detail_element[data-e2e="user-detail"]',
  nickname: '[data-e2e="user-info"] h1',
  postCount: '#semiTabpost [data-e2e="user-tab-count"]',
  scrollList: '[data-e2e="user-post-list"] > ul[data-e2e="scroll-list"]',
  workLink: 'a[href^="/video/"], a[href^="https://www.douyin.com/video/"]',
  workTitle: "p",
});

const PROFILE_STRUCTURE_ERROR = "抖音人物主页结构已变化，无法定位唯一作品列表";
const PROFILE_AUTH_TEXT = /(登录|安全验证|完成验证|扫码|验证码|captcha|verify)/i;

export interface ProfileDomItem {
  href: string | null;
  title: string;
}

export interface ProfileDomSnapshot {
  rootCount: number;
  listCount: number;
  postCountCount: number;
  nickname: string;
  postCountText: string | null;
  listText: string;
  items: ProfileDomItem[];
  scrollHeight: number;
}

export interface FavoriteSnapshot {
  works: ProfileWork[];
  scrollHeight: number;
}

export interface FavoriteDomSnapshot {
  rootCount: number;
  markerCount: number;
  listCount: number;
  items: ProfileDomItem[];
  scrollHeight: number;
}

export const FAVORITE_SELECTORS = Object.freeze({
  root: '#user_detail_element[data-e2e="user-detail"]',
  marker: '[data-e2e="user-favorite-list"]',
  scrollList: '[data-e2e="user-post-list"] > ul[data-e2e="scroll-list"]',
  workLink: 'a[href^="/video/"], a[href^="https://www.douyin.com/video/"]',
  workTitle: "p",
  videoTab: "#semiTabvideo",
  refreshTabs: Object.freeze([
    "#semiTabfavorite_folder",
    "#semiTabmusic",
    "#semiTabcompilation",
    "#semiTabplaylet",
  ]),
});

const FAVORITE_STRUCTURE_ERROR = "抖音收藏列表结构已变化，无法定位唯一收藏作品列表";

export function randomIntegerInclusive(
  minimum: number,
  maximum: number,
  random: () => number = Math.random,
): number {
  const value = Math.min(1 - Number.EPSILON, Math.max(0, random()));
  return minimum + Math.floor(value * (maximum - minimum + 1));
}

export function parseFavoriteDomSnapshot(
  raw: FavoriteDomSnapshot,
  final = true,
): FavoriteSnapshot | null {
  if (raw.rootCount !== 1 || raw.markerCount !== 1 || raw.listCount !== 1) {
    if (!final) return null;
    throw new AppError("interface_error", FAVORITE_STRUCTURE_ERROR);
  }
  const works = dedupeWorksInOrder(raw.items.flatMap((item) => {
    const work = parseProfileWorkHref(item.href, item.title);
    return work ? [work] : [];
  }));
  if (works.length > 0) return { works, scrollHeight: raw.scrollHeight };
  if (!final) return null;
  if (raw.items.length > 0) throw new AppError("interface_error", FAVORITE_STRUCTURE_ERROR);
  return { works: [], scrollHeight: raw.scrollHeight };
}

export function parseProfileWorkHref(href: string | null, title = ""): ProfileWork | null {
  if (!href) return null;
  try {
    const url = new URL(href, "https://www.douyin.com/");
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "www.douyin.com") return null;
    const match = url.pathname.match(/^\/video\/(\d{8,})\/?$/);
    if (!match) return null;
    return {
      awemeId: match[1],
      title: title.trim(),
      url: `https://www.douyin.com/video/${match[1]}`,
    };
  } catch {
    return null;
  }
}

export function lastValidProfileItem(items: readonly ProfileDomItem[]): { index: number; href: string } | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (parseProfileWorkHref(item.href, item.title) && item.href) return { index, href: item.href };
  }
  return null;
}

export function parseProfileDomSnapshot(
  raw: ProfileDomSnapshot,
  final = true,
): ProfileSnapshot | null {
  if (raw.rootCount !== 1 || raw.listCount !== 1 || raw.postCountCount !== 1) {
    if (!final) return null;
    throw new AppError("interface_error", PROFILE_STRUCTURE_ERROR);
  }

  const countMatch = raw.postCountText?.replace(/,/g, "").match(/\d+/) ?? null;
  if (!countMatch) {
    if (!final) return null;
    throw new AppError("interface_error", PROFILE_STRUCTURE_ERROR);
  }

  const displayedPostCount = Number.parseInt(countMatch[0], 10);
  const works = dedupeWorksInOrder(
    raw.items.flatMap((item) => {
      const work = parseProfileWorkHref(item.href, item.title);
      return work ? [work] : [];
    }),
  );
  const snapshot = {
    nickname: raw.nickname.trim(),
    displayedPostCount,
    works,
    scrollHeight: raw.scrollHeight,
  };
  if (displayedPostCount === 0 || works.length > 0) return snapshot;
  if (PROFILE_AUTH_TEXT.test(raw.listText.slice(0, 1_000))) {
    throw new AppError("risk_verify", "抖音作品列表需要登录或完成人机验证");
  }
  if (!final) return null;
  throw new AppError("interface_error", PROFILE_STRUCTURE_ERROR);
}

function emptyProfileDomSnapshot(): ProfileDomSnapshot {
  return {
    rootCount: 0,
    listCount: 0,
    postCountCount: 0,
    nickname: "",
    postCountText: null,
    listText: "",
    items: [],
    scrollHeight: 0,
  };
}

export function dedupeWorksInOrder(works: ProfileWork[]): ProfileWork[] {
  const seen = new Set<string>();
  return works.filter((work) => {
    if (seen.has(work.awemeId)) return false;
    seen.add(work.awemeId);
    return true;
  });
}

interface Address {
  uri?: string;
  url_list?: string[];
}

interface AwemeDetail {
  aweme_id?: string | number;
  desc?: string;
  author?: { nickname?: string };
  video?: {
    play_addr?: Address;
    play_addr_h264?: Address;
    play_addr_265?: Address;
    bit_rate?: Array<{ play_addr?: Address }>;
  };
}

export interface DownloadResult {
  path: string;
  title: string;
  author: string;
  mediaCreationTime: string | null;
  sizeBytes: number;
}

export type Candidate = { url: string; kind: "playback" | "cdn" };

export interface MediaDownloadProgress {
  receivedBytes: number;
  totalBytes: number | null;
}

export type MediaDownloadProgressCallback = (progress: MediaDownloadProgress) => void;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
type CookieProvider = (url: string) => Promise<Array<{ name: string; value: string }>>;

export function findMatchingDetail(payload: unknown, targetId: string): AwemeDetail | null {
  const seen = new Set<object>();
  const stack: unknown[] = [payload];
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    const object = value as Record<string, unknown>;
    if (String(object.aweme_id ?? "") === targetId && object.video && typeof object.video === "object") {
      return object as AwemeDetail;
    }
    if (Array.isArray(value)) stack.push(...value);
    else stack.push(...Object.values(object));
  }
  return null;
}

export function buildCandidates(detail: AwemeDetail): Candidate[] {
  const primary = [detail.video?.play_addr, detail.video?.play_addr_h264, detail.video?.play_addr_265];
  const bitrates = Array.isArray(detail.video?.bit_rate)
    ? detail.video!.bit_rate!.map((entry) => entry.play_addr)
    : [];
  const all = [...primary, ...bitrates];
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const add = (url: string | undefined, kind: Candidate["kind"]) => {
    if (!url || seen.has(url)) return;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") return;
      seen.add(url);
      candidates.push({ url, kind });
    } catch {
      // Ignore malformed candidates from the upstream response.
    }
  };
  for (const address of all) {
    if (!address?.uri) continue;
    const playback = new URL("https://aweme.snssdk.com/aweme/v1/play/");
    playback.searchParams.set("video_id", address.uri);
    playback.searchParams.set("ratio", "1080p");
    playback.searchParams.set("line", "0");
    add(playback.toString(), "playback");
  }
  for (const address of primary) for (const url of address?.url_list ?? []) add(url, "cdn");
  for (const address of bitrates) for (const url of address?.url_list ?? []) add(url, "cdn");
  return candidates;
}

export class DouyinSession {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private ownsContext = true;
  private closePageAfterDetail = false;

  constructor(
    private readonly userDataDir: string,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly random: () => number = Math.random,
    private readonly wait: (ms: number, signal?: AbortSignal) => Promise<void> = abortableSleep,
  ) {}

  async open(profileUrl: string): Promise<ProfileSnapshot> {
    if (!this.context) {
      await mkdir(dirname(this.userDataDir), { recursive: true });
      this.context = await launchPersistentChromium(this.userDataDir);
      this.page = this.context.pages()[0] ?? await this.context.newPage();
    }
    await this.page!.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: this.timeoutMs }).catch(() => {
      throw new AppError("network_error", "无法打开抖音人物主页");
    });
    await this.page!.evaluate(() => {
      if ("scrollRestoration" in history) history.scrollRestoration = "manual";
      window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    });
    await this.assertNotBlocked();
    return this.waitForProfileSnapshot();
  }

  async recheck(): Promise<ProfileSnapshot> {
    await this.assertNotBlocked();
    return this.waitForProfileSnapshot();
  }

  async checkAccess(): Promise<void> {
    await this.assertNotBlocked();
  }

  async openUtilityPage(url = "https://www.douyin.com/"): Promise<void> {
    await this.ensureContext();
    await this.page!.goto(url, { waitUntil: "domcontentloaded", timeout: this.timeoutMs }).catch(() => {
      throw new AppError("network_error", "无法打开抖音页面");
    });
    await this.assertNotBlocked();
  }

  async bringToFront(): Promise<void> {
    await this.page?.bringToFront().catch(() => undefined);
  }

  async openFavorites(url: string): Promise<FavoriteSnapshot> {
    await this.ensureContext();
    await this.page!.goto(url, { waitUntil: "domcontentloaded", timeout: this.timeoutMs }).catch(() => {
      throw new AppError("network_error", "无法打开抖音收藏列表");
    });
    await this.page!.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" }));
    await this.assertNotBlocked();
    return this.waitForFavoriteSnapshot();
  }

  async refreshFavorites(signal?: AbortSignal): Promise<FavoriteSnapshot> {
    if (!this.page) throw new AppError("interface_error", "浏览器尚未打开");
    await this.wait(randomIntegerInclusive(2_000, 4_000, this.random), signal);
    const availableTabs = await this.page.evaluate((selectors) =>
      selectors.refreshTabs.filter((selector) =>
        document.querySelector(selector) instanceof HTMLElement), FAVORITE_SELECTORS);
    if (availableTabs.length === 0) {
      throw new AppError("interface_error", FAVORITE_STRUCTURE_ERROR);
    }
    const refreshTab = availableTabs[
      randomIntegerInclusive(0, availableTabs.length - 1, this.random)
    ]!;
    const refreshClicked = await this.page.evaluate((selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) return false;
      element.click();
      return true;
    }, refreshTab);
    if (!refreshClicked) throw new AppError("interface_error", FAVORITE_STRUCTURE_ERROR);

    await this.wait(randomIntegerInclusive(1_000, 3_000, this.random), signal);
    const videoClicked = await this.page.evaluate((selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) return false;
      element.click();
      return true;
    }, FAVORITE_SELECTORS.videoTab);
    if (!videoClicked) throw new AppError("interface_error", FAVORITE_STRUCTURE_ERROR);

    await this.page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" }));
    await this.assertNotBlocked();
    return this.waitForFavoriteSnapshot(signal);
  }

  async createSibling(closePageAfterDetail = false): Promise<DouyinSession> {
    if (!this.context) throw new AppError("interface_error", "抖音浏览器尚未打开");
    const sibling = new DouyinSession(
      this.userDataDir,
      this.timeoutMs,
      this.fetchImpl,
      this.random,
      this.wait,
    );
    sibling.context = this.context;
    sibling.page = await this.context.newPage();
    sibling.ownsContext = false;
    sibling.closePageAfterDetail = closePageAfterDetail;
    return sibling;
  }

  async snapshot(): Promise<ProfileSnapshot> {
    if (!this.page) throw new AppError("interface_error", "浏览器尚未打开");
    const snapshot = parseProfileDomSnapshot(await this.readProfileDom());
    if (!snapshot) throw new AppError("interface_error", PROFILE_STRUCTURE_ERROR);
    return snapshot;
  }

  async scrollForMore(knownIds: ReadonlySet<string>): Promise<{ snapshot: ProfileSnapshot; changed: boolean }> {
    if (!this.page) throw new AppError("interface_error", "浏览器尚未打开");
    const beforeRaw = await this.readProfileDom();
    const before = parseProfileDomSnapshot(beforeRaw);
    if (!before) throw new AppError("interface_error", PROFILE_STRUCTURE_ERROR);
    const target = lastValidProfileItem(beforeRaw.items);
    const structureValid = await this.page.evaluate(({ selectors, targetItem }) => {
      const roots = document.querySelectorAll(selectors.root);
      if (roots.length !== 1) return false;
      const lists = roots[0]!.querySelectorAll<HTMLUListElement>(selectors.scrollList);
      if (lists.length !== 1) return false;
      const items = Array.from(lists[0]!.children)
        .filter((child): child is HTMLLIElement => child.tagName === "LI");
      if (targetItem) {
        const item = items[targetItem.index];
        const link = item?.querySelector<HTMLAnchorElement>(selectors.workLink);
        if (!item || link?.getAttribute("href") !== targetItem.href) return false;
        item.scrollIntoView({ block: "end", behavior: "smooth" });
      }
      window.scrollBy(0, Math.max(480, window.innerHeight * 0.75));
      return true;
    }, { selectors: PROFILE_SELECTORS, targetItem: target });
    if (!structureValid) throw new AppError("interface_error", PROFILE_STRUCTURE_ERROR);
    const deadline = Date.now() + 5_000;
    let snapshot = before;
    while (Date.now() < deadline) {
      await sleep(500);
      await this.assertNotBlocked();
      snapshot = await this.snapshot();
      if (snapshot.works.some((work) => !knownIds.has(work.awemeId)) || snapshot.scrollHeight > before.scrollHeight) {
        return { snapshot, changed: true };
      }
    }
    return { snapshot, changed: false };
  }

  private async waitForProfileSnapshot(): Promise<ProfileSnapshot> {
    const deadline = Date.now() + this.timeoutMs;
    let raw: ProfileDomSnapshot | null = null;
    while (Date.now() < deadline) {
      raw = await this.readProfileDom();
      const snapshot = parseProfileDomSnapshot(raw, false);
      if (snapshot) return snapshot;
      await sleep(250);
    }
    await this.assertNotBlocked();
    const snapshot = parseProfileDomSnapshot(raw ?? emptyProfileDomSnapshot(), true);
    if (!snapshot) throw new AppError("interface_error", PROFILE_STRUCTURE_ERROR);
    return snapshot;
  }

  private async readProfileDom(): Promise<ProfileDomSnapshot> {
    if (!this.page) throw new AppError("interface_error", "浏览器尚未打开");
    return this.page.evaluate((selectors) => {
      const roots = document.querySelectorAll<HTMLElement>(selectors.root);
      const root = roots.length === 1 ? roots[0]! : null;
      const lists = root?.querySelectorAll<HTMLUListElement>(selectors.scrollList) ?? [];
      const list = lists.length === 1 ? lists[0]! : null;
      const countNodes = root?.querySelectorAll<HTMLElement>(selectors.postCount) ?? [];
      const nickname = root?.querySelector<HTMLElement>(selectors.nickname)?.textContent ?? "";
      const items = list
        ? Array.from(list.children)
          .filter((child): child is HTMLLIElement => child.tagName === "LI")
          .map((item) => {
            const link = item.querySelector<HTMLAnchorElement>(selectors.workLink);
            return {
              href: link?.getAttribute("href") ?? null,
              title: link?.querySelector<HTMLElement>(selectors.workTitle)?.textContent?.trim() ?? "",
            };
          })
        : [];
      return {
        rootCount: roots.length,
        listCount: lists.length,
        postCountCount: countNodes.length,
        nickname,
        postCountText: countNodes.length === 1 ? countNodes[0]!.textContent : null,
        listText: list?.parentElement?.textContent?.trim() ?? "",
        items,
        scrollHeight: document.documentElement.scrollHeight,
      };
    }, PROFILE_SELECTORS);
  }

  async download(
    awemeId: string,
    outputDir: string,
    signal?: AbortSignal,
    onProgress?: MediaDownloadProgressCallback,
  ): Promise<DownloadResult> {
    if (!this.page || !this.context) throw new AppError("interface_error", "浏览器尚未打开");
    if (signal?.aborted) throw new AppError("cancelled", "任务已取消");
    const detail = await this.fetchDetail(awemeId);
    const candidates = buildCandidates(detail);
    if (this.closePageAfterDetail) await this.closePageOnly();
    if (!candidates.length) throw new AppError("no_matching_video", "匹配作品没有可用视频资源");
    await mkdir(outputDir, { recursive: true });
    const finalFile = resolve(outputDir, `aweme_${awemeId}.mp4`);
    const downloaded = await this.downloadCandidates(candidates, finalFile, signal, onProgress);
    return {
      path: finalFile,
      title: typeof detail.desc === "string" ? detail.desc : "",
      author: typeof detail.author?.nickname === "string" ? detail.author.nickname : "",
      mediaCreationTime: downloaded.mediaCreationTime,
      sizeBytes: downloaded.sizeBytes,
    };
  }

  async close(): Promise<void> {
    if (this.ownsContext) await this.context?.close().catch(() => undefined);
    else await this.closePageOnly();
    this.context = null;
    this.page = null;
  }

  private async closePageOnly(): Promise<void> {
    const page = this.page;
    this.page = null;
    await page?.close().catch(() => undefined);
  }

  private async ensureContext(): Promise<void> {
    if (this.context) return;
    await mkdir(dirname(this.userDataDir), { recursive: true });
    this.context = await launchPersistentChromium(this.userDataDir);
    this.page = this.context.pages()[0] ?? await this.context.newPage();
  }

  private async waitForFavoriteSnapshot(signal?: AbortSignal): Promise<FavoriteSnapshot> {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const snapshot = await this.favoriteSnapshot(false);
      if (snapshot) return snapshot;
      await this.wait(250, signal);
    }
    const snapshot = await this.favoriteSnapshot(true);
    if (!snapshot) throw new AppError("interface_error", FAVORITE_STRUCTURE_ERROR);
    return snapshot;
  }

  private async favoriteSnapshot(final = true): Promise<FavoriteSnapshot | null> {
    if (!this.page) throw new AppError("interface_error", "浏览器尚未打开");
    const raw = await this.page.evaluate((selectors) => {
      const roots = document.querySelectorAll<HTMLElement>(selectors.root);
      const root = roots.length === 1 ? roots[0]! : null;
      const markers = root?.querySelectorAll<HTMLElement>(selectors.marker) ?? [];
      const lists = root?.querySelectorAll<HTMLUListElement>(selectors.scrollList) ?? [];
      const list = lists.length === 1 ? lists[0]! : null;
      const items = list
        ? Array.from(list.children)
          .filter((child): child is HTMLLIElement => child.tagName === "LI")
          .map((item) => {
            const link = item.querySelector<HTMLAnchorElement>(selectors.workLink);
            return {
              href: link?.getAttribute("href") ?? null,
              title: link?.querySelector<HTMLElement>(selectors.workTitle)?.textContent?.trim() ?? "",
            };
          })
        : [];
      return {
        rootCount: roots.length,
        markerCount: markers.length,
        listCount: lists.length,
        items,
        scrollHeight: document.documentElement.scrollHeight,
      };
    }, FAVORITE_SELECTORS);
    return parseFavoriteDomSnapshot(raw, final);
  }

  private async assertNotBlocked(): Promise<void> {
    if (!this.page) return;
    if (RISK_URL.test(this.page.url())) throw new AppError("risk_verify", "抖音要求登录或完成人机验证");
    const text = await this.page.locator("body").innerText({ timeout: 3_000 }).catch(() => "");
    if (RISK_TEXT.test(text.slice(0, 12_000))) throw new AppError("risk_verify", "抖音要求登录或完成人机验证");
  }

  private async fetchDetail(targetId: string): Promise<AwemeDetail> {
    const result = await this.page!.evaluate(async ({ id, timeout }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const endpoint = new URL("https://www.douyin.com/aweme/v1/web/aweme/detail/");
        endpoint.searchParams.set("aweme_id", id);
        endpoint.searchParams.set("aid", "6383");
        endpoint.searchParams.set("device_platform", "webapp");
        const response = await fetch(endpoint, {
          credentials: "include",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        return { ok: response.ok, status: response.status, data: await response.json().catch(() => null) };
      } catch (error) {
        return { networkError: error instanceof Error ? error.name : "fetch_error" };
      } finally {
        clearTimeout(timer);
      }
    }, { id: targetId, timeout: this.timeoutMs }) as {
      ok?: boolean; status?: number; data?: unknown; networkError?: string;
    };
    if (result.networkError) throw new AppError("network_error", "媒体解析请求失败或超时");
    if (result.status === 403) {
      await this.assertNotBlocked();
      throw new AppError("interface_error", "媒体解析接口拒绝了请求");
    }
    const data = result.data as Record<string, unknown> | null;
    if (!result.ok || !data || ("status_code" in data && data.status_code !== 0)) {
      throw new AppError("interface_error", "媒体解析接口返回异常");
    }
    const detail = findMatchingDetail(data, targetId);
    if (!detail) throw new AppError("no_matching_video", "响应中没有与目标 ID 完全匹配的视频");
    return detail;
  }

  private async downloadCandidates(
    candidates: Candidate[],
    finalFile: string,
    signal?: AbortSignal,
    onProgress?: MediaDownloadProgressCallback,
  ): Promise<{ mediaCreationTime: string | null; sizeBytes: number }> {
    let downloaded = 0;
    let forbidden = 0;
    const tempFiles = new Set<string>();
    try {
      for (let index = 0; index < candidates.length; index += 1) {
        if (signal?.aborted) throw new AppError("cancelled", "任务已取消");
        const candidate = candidates[index];
        const tempFile = `${finalFile}.tmp-${process.pid}-${Date.now()}-${index}`;
        tempFiles.add(tempFile);
        onProgress?.({ receivedBytes: 0, totalBytes: null });
        const timeoutController = new AbortController();
        const onAbort = () => timeoutController.abort(signal?.reason);
        const requestTimeout = setTimeout(
          () => timeoutController.abort(new Error("media_download_timeout")),
          this.timeoutMs,
        );
        signal?.addEventListener("abort", onAbort, { once: true });
        let response: Response;
        try {
          response = await fetchCandidateWithScopedCookies({
            url: candidate.url,
            referer: candidate.kind === "playback" ? "https://www.iesdouyin.com/" : "https://www.douyin.com/",
            signal: timeoutController.signal,
            cookies: (url) => this.context!.cookies(url),
            fetchImpl: this.fetchImpl,
          });
        } catch {
          clearTimeout(requestTimeout);
          signal?.removeEventListener("abort", onAbort);
          if (signal?.aborted) throw new AppError("cancelled", "任务已取消");
          continue;
        }
        clearTimeout(requestTimeout);
        if (response.status === 403) {
          forbidden += 1;
          await response.body?.cancel().catch(() => undefined);
          signal?.removeEventListener("abort", onAbort);
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          signal?.removeEventListener("abort", onAbort);
          continue;
        }
        let sizeBytes: number;
        try {
          sizeBytes = await streamResponseToFile(
            response,
            tempFile,
            timeoutController.signal,
            onProgress,
            this.timeoutMs,
          );
          downloaded += 1;
        } catch {
          signal?.removeEventListener("abort", onAbort);
          await rm(tempFile, { force: true });
          tempFiles.delete(tempFile);
          if (signal?.aborted) throw new AppError("cancelled", "任务已取消");
          continue;
        }
        signal?.removeEventListener("abort", onAbort);
        const probe = await probeMedia(tempFile, this.timeoutMs, signal);
        if (!probe.hasAudio) {
          await rm(tempFile, { force: true });
          tempFiles.delete(tempFile);
          continue;
        }
        await commitValidatedFile(tempFile, finalFile);
        tempFiles.delete(tempFile);
        return { mediaCreationTime: probe.creationTime, sizeBytes };
      }
    } finally {
      await Promise.all([...tempFiles].map((file) => rm(file, { force: true }).catch(() => undefined)));
    }
    if (downloaded > 0) throw new AppError("no_audio_stream", "所有候选文件均没有有效音轨");
    if (candidates.length > 0 && forbidden === candidates.length) {
      throw new AppError("download_403", "所有媒体请求均被服务器拒绝");
    }
    throw new AppError("network_error", "没有媒体候选成功下载");
  }
}

export function parseContentLength(value: string | null): number | null {
  if (!value || !/^\d+$/u.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function buildCookieHeader(cookies: ReadonlyArray<{ name: string; value: string }>): string {
  return cookies
    .filter((cookie) => cookie.name && !/[\r\n;]/u.test(cookie.name) && !/[\r\n]/u.test(cookie.value))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

export async function fetchCandidateWithScopedCookies(input: {
  url: string;
  referer: string;
  signal: AbortSignal;
  cookies: CookieProvider;
  fetchImpl?: FetchLike;
  maxRedirects?: number;
}): Promise<Response> {
  const fetchRequest = input.fetchImpl ?? fetch;
  const maxRedirects = input.maxRedirects ?? 5;
  let currentUrl = input.url;
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const parsed = new URL(currentUrl);
    if (parsed.protocol !== "https:") throw new Error("media_url_must_use_https");
    const headers = new Headers({
      Accept: "*/*",
      Referer: input.referer,
      "User-Agent": MOBILE_USER_AGENT,
    });
    const cookie = buildCookieHeader(await input.cookies(parsed.toString()));
    if (cookie) headers.set("Cookie", cookie);
    const response = await fetchRequest(parsed, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: input.signal,
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (!location || redirects === maxRedirects) throw new Error("media_redirect_failed");
    currentUrl = new URL(location, parsed).toString();
  }
  throw new Error("media_redirect_failed");
}

export async function streamResponseToFile(
  response: Response,
  destination: string,
  signal?: AbortSignal,
  onProgress?: MediaDownloadProgressCallback,
  inactivityTimeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<number> {
  if (!response.body) throw new Error("media_response_has_no_body");
  if (signal?.aborted) throw signal.reason ?? new Error("media_download_aborted");
  const totalBytes = parseContentLength(response.headers.get("content-length"));
  const reader = response.body.getReader();
  const file = await open(destination, "wx");
  let receivedBytes = 0;
  let completed = false;
  onProgress?.({ receivedBytes, totalBytes });
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new Error("media_download_aborted");
      const { done, value } = await readStreamChunk(reader, signal, inactivityTimeoutMs);
      if (done) break;
      let offset = 0;
      while (offset < value.byteLength) {
        const { bytesWritten } = await file.write(value.subarray(offset));
        if (bytesWritten <= 0) throw new Error("media_file_write_failed");
        offset += bytesWritten;
      }
      receivedBytes += value.byteLength;
      onProgress?.({ receivedBytes, totalBytes });
    }
    completed = true;
    return receivedBytes;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
    await file.close();
    if (!completed) await rm(destination, { force: true }).catch(() => undefined);
  }
}

function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
  inactivityTimeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new Error("media_download_aborted"));
  }
  return new Promise((resolveRead, rejectRead) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      rejectRead(signal?.reason ?? new Error("media_download_aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      cleanup();
      rejectRead(new Error("media_download_inactivity_timeout"));
    }, Math.max(1, inactivityTimeoutMs));
    reader.read().then(
      (result) => {
        cleanup();
        resolveRead(result);
      },
      (error: unknown) => {
        cleanup();
        rejectRead(error);
      },
    );
  });
}

export async function launchPersistentChromium(userDataDir: string): Promise<BrowserContext> {
  const options = {
    headless: false,
    locale: "zh-CN",
    viewport: { width: 1440, height: 900 },
    args: ["--window-size=1440,900"],
  };
  try {
    return await chromium.launchPersistentContext(userDataDir, options);
  } catch {
    for (const channel of ["chrome", "msedge"] as const) {
      try {
        return await chromium.launchPersistentContext(userDataDir, { ...options, channel });
      } catch {
        // Try the next installed Chromium channel.
      }
    }
    throw new AppError("interface_error", "无法启动 Chromium，请安装 Playwright Chromium、Chrome 或 Edge");
  }
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(() => true, () => false);
}

async function commitValidatedFile(tempFile: string, finalFile: string): Promise<void> {
  const backup = `${finalFile}.backup-${process.pid}-${Date.now()}`;
  const hadPrevious = await exists(finalFile);
  if (hadPrevious) await rename(finalFile, backup);
  try {
    await rename(tempFile, finalFile);
    if (hadPrevious) await rm(backup, { force: true });
  } catch (error) {
    if (hadPrevious && await exists(backup)) await rename(backup, finalFile).catch(() => undefined);
    throw error;
  }
}
