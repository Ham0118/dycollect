import { dirname, isAbsolute, relative, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { AppError } from "./errors.js";

export interface ParsedProfile {
  profileUrl: string;
  secUid: string;
}

export function parseProfileUrl(input: string): ParsedProfile {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new AppError("parse_error", "请输入有效的抖音人物主页 URL");
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "www.douyin.com") {
    throw new AppError("parse_error", "人物主页必须来自 https://www.douyin.com");
  }
  const match = url.pathname.match(/^\/user\/([^/?#]+)\/?$/);
  if (!match) throw new AppError("parse_error", "链接不是受支持的抖音人物主页");
  const secUid = decodeURIComponent(match[1]);
  if (secUid.length < 8 || secUid.length > 256 || !/^[A-Za-z0-9_-]+$/.test(secUid)) {
    throw new AppError("parse_error", "人物主页 ID 无效");
  }
  url.search = "";
  url.hash = "";
  return { profileUrl: url.toString().replace(/\/$/, ""), secUid };
}

export function decodePublishedAt(awemeId: string, now = new Date()): string | null {
  if (!/^\d{8,}$/.test(awemeId)) return null;
  try {
    const seconds = BigInt(awemeId) >> 32n;
    if (seconds > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    const date = new Date(Number(seconds) * 1_000);
    const earliest = Date.UTC(2016, 0, 1);
    const latest = now.getTime() + 24 * 60 * 60 * 1_000;
    if (!Number.isFinite(date.getTime()) || date.getTime() < earliest || date.getTime() > latest) {
      return null;
    }
    return date.toISOString();
  } catch {
    return null;
  }
}

export function formatShanghaiDate(iso: string | null): string {
  if (!iso) return "发布时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

export function formatShanghaiFilename(iso: string | null): string {
  if (!iso) return "unknown-time";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}_${get("hour")}-${get("minute")}-${get("second")}`;
}

export function sanitizeTitle(value: string, fallback: string): string {
  const cleaned = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  return (cleaned || fallback).slice(0, 80);
}

export function resolveWithin(root: string, path: string): string | null {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const rel = relative(root, absolute);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)) ? absolute : null;
}

export async function ensureParent(file: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
}

export const sleep = (ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));

export function formatElapsedDuration(durationMs: number): string {
  const safeMilliseconds = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  const seconds = safeMilliseconds / 1_000;
  if (seconds < 60) return `${Math.max(0.1, seconds).toFixed(1)}秒`;

  const roundedSeconds = Math.round(seconds);
  if (seconds < 60 * 60) {
    const minutes = Math.floor(roundedSeconds / 60);
    const remainingSeconds = roundedSeconds % 60;
    return `${minutes}分${remainingSeconds ? `${remainingSeconds}秒` : ""}`;
  }

  const hours = Math.floor(roundedSeconds / (60 * 60));
  const minutes = Math.floor((roundedSeconds % (60 * 60)) / 60);
  const remainingSeconds = roundedSeconds % 60;
  return [
    `${hours}小时`,
    minutes ? `${minutes}分` : "",
    remainingSeconds ? `${remainingSeconds}秒` : "",
  ].join("");
}

export function randomInterVideoDelayMs(random: () => number = Math.random): number {
  const value = Math.min(1 - Number.EPSILON, Math.max(0, random()));
  return 20_000 + Math.floor(value * 10_001);
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveSleep, rejectSleep) => {
    if (signal?.aborted) {
      rejectSleep(new AppError("cancelled", "任务已取消"));
      return;
    }
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      rejectSleep(new AppError("cancelled", "任务已取消"));
    };
    function finish() {
      signal?.removeEventListener("abort", onAbort);
      resolveSleep();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
