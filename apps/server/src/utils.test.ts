import { describe, expect, it } from "vitest";
import {
  abortableSleep,
  decodePublishedAt,
  formatElapsedDuration,
  formatShanghaiFilename,
  parseProfileUrl,
  randomInterVideoDelayMs,
  resolveWithin,
  sanitizeTitle,
} from "./utils.js";

describe("profile URL", () => {
  it("accepts the supported Douyin profile form", () => {
    const parsed = parseProfileUrl("https://www.douyin.com/user/MS4wLjABAAAA1234?from=web");
    expect(parsed.secUid).toBe("MS4wLjABAAAA1234");
    expect(parsed.profileUrl).toBe("https://www.douyin.com/user/MS4wLjABAAAA1234");
  });

  it("rejects untrusted hosts", () => {
    expect(() => parseProfileUrl("https://example.com/user/MS4wLjABAAAA1234")).toThrow();
    expect(() => parseProfileUrl("https://www.douyin.com/user/abcde%2F..%2Fsecret")).toThrow();
  });
});

describe("published time", () => {
  it("decodes the high 32 bits without Number precision loss", () => {
    expect(decodePublishedAt("7601484851720380913", new Date("2026-07-22T00:00:00Z")))
      .toBe("2026-01-31T11:23:30.000Z");
    expect(formatShanghaiFilename("2026-01-31T11:23:30.000Z")).toBe("2026-01-31_19-23-30");
  });

  it("rejects invalid and implausible IDs", () => {
    expect(decodePublishedAt("not-an-id")).toBeNull();
    expect(decodePublishedAt("12345678")).toBeNull();
  });
});

describe("safe files", () => {
  it("sanitizes Windows file names", () => {
    expect(sanitizeTitle('  标题: A/B?  ', "fallback")).toBe("标题 A B");
  });

  it("keeps resolved article paths inside the data root", () => {
    expect(resolveWithin("C:\\data", "person\\article.md")).toContain("article.md");
    expect(resolveWithin("C:\\data", "..\\secret.txt")).toBeNull();
  });
});

describe("inter-video delay", () => {
  it("keeps the random delay inside the inclusive 20-30 second range", () => {
    expect(randomInterVideoDelayMs(() => 0)).toBe(20_000);
    expect(randomInterVideoDelayMs(() => 0.5)).toBe(25_000);
    expect(randomInterVideoDelayMs(() => 1)).toBe(30_000);
  });

  it("can be cancelled immediately", async () => {
    const controller = new AbortController();
    const waiting = abortableSleep(30_000, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ category: "cancelled" });
  });
});

describe("elapsed duration formatting", () => {
  it.each([
    [0, "0.1秒"],
    [40, "0.1秒"],
    [100, "0.1秒"],
    [59_900, "59.9秒"],
    [60_000, "1分"],
    [61_000, "1分1秒"],
    [3_599_000, "59分59秒"],
    [3_600_000, "1小时"],
    [3_601_000, "1小时1秒"],
    [3_660_000, "1小时1分"],
    [3_661_000, "1小时1分1秒"],
    [((27 * 60 + 2) * 60 + 3) * 1_000, "27小时2分3秒"],
  ])("formats %d ms as %s", (durationMs, expected) => {
    expect(formatElapsedDuration(durationMs)).toBe(expected);
  });
});
