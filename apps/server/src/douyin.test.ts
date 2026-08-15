import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCandidates,
  buildCookieHeader,
  dedupeWorksInOrder,
  DouyinSession,
  fetchCandidateWithScopedCookies,
  FAVORITE_SELECTORS,
  findMatchingDetail,
  lastValidProfileItem,
  parseContentLength,
  parseFavoriteDomSnapshot,
  parseProfileDomSnapshot,
  parseProfileWorkHref,
  PROFILE_SELECTORS,
  randomIntegerInclusive,
  streamResponseToFile,
  type ProfileDomSnapshot,
  type FavoriteDomSnapshot,
} from "./douyin.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Douyin media matching", () => {
  it("finds only the exact aweme ID", () => {
    const payload = {
      decoy: { aweme_id: "99999999", video: { play_addr: { uri: "wrong" } } },
      nested: { aweme_id: "12345678", video: { play_addr: { uri: "right" } } },
    };
    expect(findMatchingDetail(payload, "12345678")?.video?.play_addr?.uri).toBe("right");
    expect(findMatchingDetail(payload, "11111111")).toBeNull();
  });

  it("orders and deduplicates candidates from the matching detail", () => {
    const candidates = buildCandidates({
      video: {
        play_addr: { uri: "main", url_list: ["https://cdn.example/main"] },
        play_addr_h264: { uri: "h264", url_list: ["https://cdn.example/h264"] },
        play_addr_265: { uri: "h265", url_list: [] },
        bit_rate: [{ play_addr: { uri: "bitrate", url_list: ["https://cdn.example/main"] } }],
      },
    });
    expect(candidates.map((item) => item.kind)).toEqual(["playback", "playback", "playback", "playback", "cdn", "cdn"]);
    expect(candidates.at(-1)?.url).toBe("https://cdn.example/h264");
  });
});

describe("profile work ordering", () => {
  const profileDom = (overrides: Partial<ProfileDomSnapshot> = {}): ProfileDomSnapshot => ({
    rootCount: 1,
    listCount: 1,
    postCountCount: 1,
    nickname: "测试人物",
    postCountText: "2",
    listText: "作品列表",
    items: [
      { href: "/video/11111111", title: "第一个作品" },
      { href: "https://www.douyin.com/video/22222222?from=profile", title: "第二个作品" },
    ],
    scrollHeight: 2_000,
    ...overrides,
  });

  it("uses only stable IDs, data attributes, scoped tags, and video hrefs", () => {
    expect(PROFILE_SELECTORS).toEqual({
      root: '#user_detail_element[data-e2e="user-detail"]',
      nickname: '[data-e2e="user-info"] h1',
      postCount: '#semiTabpost [data-e2e="user-tab-count"]',
      scrollList: '[data-e2e="user-post-list"] > ul[data-e2e="scroll-list"]',
      workLink: 'a[href^="/video/"], a[href^="https://www.douyin.com/video/"]',
      workTitle: "p",
    });
    expect(Object.values(PROFILE_SELECTORS)).not.toContain("ul");
    expect(FAVORITE_SELECTORS).toEqual({
      root: '#user_detail_element[data-e2e="user-detail"]',
      marker: '[data-e2e="user-favorite-list"]',
      scrollList: '[data-e2e="user-post-list"] > ul[data-e2e="scroll-list"]',
      workLink: 'a[href^="/video/"], a[href^="https://www.douyin.com/video/"]',
      workTitle: "p",
      videoTab: "#semiTabvideo",
      refreshTabs: [
        "#semiTabfavorite_folder",
        "#semiTabmusic",
        "#semiTabcompilation",
        "#semiTabplaylet",
      ],
    });
    expect(Object.values(FAVORITE_SELECTORS).join(" ")).not.toContain("[class");
    expect(Object.values(FAVORITE_SELECTORS).join(" ")).not.toContain(":nth");
  });

  it("waits for a real favorite item before establishing the initial boundary", () => {
    const loading: FavoriteDomSnapshot = {
      rootCount: 1,
      markerCount: 1,
      listCount: 1,
      items: [],
      scrollHeight: 1_000,
    };
    expect(parseFavoriteDomSnapshot(loading, false)).toBeNull();
    expect(parseFavoriteDomSnapshot(loading, true)).toEqual({ works: [], scrollHeight: 1_000 });
    expect(parseFavoriteDomSnapshot({
      ...loading,
      items: [{ href: "/video/7000000000000000500", title: "当前最新收藏" }],
    }, false)?.works[0]?.awemeId).toBe("7000000000000000500");
    expect(() => parseFavoriteDomSnapshot({
      ...loading,
      items: [{ href: "/note/7000000000000000500", title: "非视频结构" }],
    }, true)).toThrow("收藏列表结构已变化");
    expect(() => parseFavoriteDomSnapshot({
      ...loading,
      markerCount: 0,
    }, true)).toThrow("收藏列表结构已变化");
  });

  it("accepts only exact same-origin video paths and canonicalizes their URLs", () => {
    expect(parseProfileWorkHref("/video/12345678", " 标题 ")).toEqual({
      awemeId: "12345678",
      title: "标题",
      url: "https://www.douyin.com/video/12345678",
    });
    expect(parseProfileWorkHref("https://www.douyin.com/video/12345678/?from=profile")?.awemeId).toBe("12345678");
    expect(parseProfileWorkHref("https://example.com/video/12345678")).toBeNull();
    expect(parseProfileWorkHref("https://www.douyin.com/shipin/12345678")).toBeNull();
    expect(parseProfileWorkHref("/video/not-a-number")).toBeNull();
  });

  it("parses only the fixed list payload, preserves order, and removes duplicates", () => {
    const snapshot = parseProfileDomSnapshot(profileDom({
      postCountText: "作品 3",
      items: [
        { href: "/video/11111111", title: "第一个作品" },
        { href: "https://attacker.example/video/99999999", title: "页面其他区域的诱饵" },
        { href: "https://www.douyin.com/video/22222222", title: "第二个作品" },
        { href: "/video/11111111?duplicate=1", title: "重复作品" },
      ],
    }));
    expect(snapshot?.works.map((work) => work.awemeId)).toEqual(["11111111", "22222222"]);
    expect(snapshot?.nickname).toBe("测试人物");
    expect(snapshot?.displayedPostCount).toBe(3);
  });

  it.each([
    ["missing root", { rootCount: 0 }],
    ["duplicate root", { rootCount: 2 }],
    ["missing list", { listCount: 0 }],
    ["duplicate list", { listCount: 2 }],
    ["missing post count", { postCountCount: 0, postCountText: null }],
  ])("fails strictly for %s", (_name, overrides) => {
    const raw = profileDom(overrides);
    expect(parseProfileDomSnapshot(raw, false)).toBeNull();
    expect(() => parseProfileDomSnapshot(raw)).toThrow("抖音人物主页结构已变化");
  });

  it("accepts a real empty profile but rejects hidden positive-count works", () => {
    expect(parseProfileDomSnapshot(profileDom({
      postCountText: "0",
      items: [],
    }))).toMatchObject({ displayedPostCount: 0, works: [] });

    expect(() => parseProfileDomSnapshot(profileDom({
      postCountText: "2",
      listText: "看更多最新作品 登录",
      items: [],
    }))).toThrow("需要登录或完成人机验证");

    const pending = profileDom({
      postCountText: "2",
      listText: "作品正在加载",
      items: [],
    });
    expect(parseProfileDomSnapshot(pending, false)).toBeNull();
    expect(() => parseProfileDomSnapshot(pending)).toThrow("抖音人物主页结构已变化");
  });

  it("targets the final direct item containing a valid work link", () => {
    expect(lastValidProfileItem([
      { href: "/video/11111111", title: "第一个" },
      { href: null, title: "占位节点" },
      { href: "https://www.douyin.com/video/22222222", title: "第二个" },
      { href: "https://example.com/video/33333333", title: "错误域名" },
    ])).toEqual({ index: 2, href: "https://www.douyin.com/video/22222222" });
    expect(lastValidProfileItem([{ href: null, title: "暂无更多" }])).toBeNull();
  });

  it("preserves UL child order while removing later duplicates", () => {
    const works = dedupeWorksInOrder([
      { awemeId: "11111111", title: "第一个孩子", url: "https://www.douyin.com/video/11111111" },
      { awemeId: "22222222", title: "第二个孩子", url: "https://www.douyin.com/video/22222222" },
      { awemeId: "11111111", title: "重复", url: "https://www.douyin.com/video/11111111" },
    ]);
    expect(works.map((work) => work.awemeId)).toEqual(["11111111", "22222222"]);
    expect(works[0]?.title).toBe("第一个孩子");
  });
});

describe("favorite list refresh", () => {
  it("uses inclusive random bounds", () => {
    expect(randomIntegerInclusive(2_000, 4_000, () => 0)).toBe(2_000);
    expect(randomIntegerInclusive(2_000, 4_000, () => 0.5)).toBe(3_000);
    expect(randomIntegerInclusive(2_000, 4_000, () => 1)).toBe(4_000);
    expect(randomIntegerInclusive(1_000, 3_000, () => 1)).toBe(3_000);
  });

  it("switches to a random available tab and back to video without reloading", async () => {
    const waits: number[] = [];
    const evaluate = vi.fn()
      .mockResolvedValueOnce(["#semiTabmusic", "#semiTabplaylet"])
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        rootCount: 1,
        markerCount: 1,
        listCount: 1,
        items: [{ href: "/video/7000000000000000600", title: "当前收藏" }],
        scrollHeight: 1_000,
      });
    const reload = vi.fn();
    const random = vi.fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.99)
      .mockReturnValueOnce(1);
    const wait = vi.fn(async (ms: number) => { waits.push(ms); });
    const session = new DouyinSession(
      "E:\\unused-test-profile",
      25_000,
      fetch,
      random,
      wait,
    );
    (session as unknown as { page: unknown }).page = {
      evaluate,
      reload,
      url: () => "https://www.douyin.com/user/self?showTab=favorite_collection",
      locator: () => ({ innerText: vi.fn(async () => "") }),
    };

    await expect(session.refreshFavorites()).resolves.toMatchObject({
      works: [expect.objectContaining({ awemeId: "7000000000000000600" })],
    });
    expect(waits).toEqual([2_000, 3_000]);
    expect(evaluate.mock.calls[1]?.[1]).toBe("#semiTabplaylet");
    expect(evaluate.mock.calls[2]?.[1]).toBe("#semiTabvideo");
    expect(reload).not.toHaveBeenCalled();
  });

  it("fails strictly when no refresh tab or video tab can be clicked", async () => {
    const wait = vi.fn(async () => undefined);
    const noRefreshTab = new DouyinSession("E:\\unused-test-profile", 25_000, fetch, () => 0, wait);
    (noRefreshTab as unknown as { page: unknown }).page = {
      evaluate: vi.fn(async () => []),
    };
    await expect(noRefreshTab.refreshFavorites()).rejects.toThrow("收藏列表结构已变化");

    const noVideoTab = new DouyinSession("E:\\unused-test-profile", 25_000, fetch, () => 0, wait);
    (noVideoTab as unknown as { page: unknown }).page = {
      evaluate: vi.fn()
        .mockResolvedValueOnce(["#semiTabmusic"])
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false),
    };
    await expect(noVideoTab.refreshFavorites()).rejects.toThrow("收藏列表结构已变化");
  });

  it("cancels immediately during a random wait", async () => {
    const controller = new AbortController();
    const evaluate = vi.fn();
    const session = new DouyinSession("E:\\unused-test-profile", 25_000, fetch, () => 0);
    (session as unknown as { page: unknown }).page = { evaluate };

    const refresh = session.refreshFavorites(controller.signal);
    controller.abort();
    await expect(refresh).rejects.toThrow("任务已取消");
    expect(evaluate).not.toHaveBeenCalled();
  });
});

describe("favorite processing page lifecycle", () => {
  const detailPayload = {
    aweme_detail: {
      aweme_id: "7000000000000000700",
      desc: "收藏详情",
      author: { nickname: "测试作者" },
      video: { play_addr: { uri: "media-token", url_list: [] } },
    },
  };

  it("closes a favorite processing page after detail parsing and before media download", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dycollect-favorite-page-"));
    temporaryDirectories.push(directory);
    const close = vi.fn(async () => undefined);
    const page = {
      close,
      evaluate: vi.fn(async () => ({ ok: true, status: 200, data: detailPayload })),
    };
    const context = { newPage: vi.fn(async () => page) };
    const owner = new DouyinSession("E:\\unused-test-profile");
    (owner as unknown as { context: unknown }).context = context;
    const session = await owner.createSibling(true);
    const downloadCandidates = vi.fn(async () => {
      expect(close).toHaveBeenCalledOnce();
      return { mediaCreationTime: null, sizeBytes: 1_024 };
    });
    (session as unknown as { downloadCandidates: typeof downloadCandidates }).downloadCandidates = downloadCandidates;

    await expect(session.download("7000000000000000700", directory)).resolves.toMatchObject({
      title: "收藏详情",
      author: "测试作者",
      sizeBytes: 1_024,
    });
    expect(downloadCandidates).toHaveBeenCalledOnce();
    await session.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps a normal creator page open after detail parsing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dycollect-creator-page-"));
    temporaryDirectories.push(directory);
    const close = vi.fn(async () => undefined);
    const page = {
      close,
      evaluate: vi.fn(async () => ({ ok: true, status: 200, data: detailPayload })),
    };
    const session = new DouyinSession("E:\\unused-test-profile");
    (session as unknown as { page: unknown; context: unknown }).page = page;
    (session as unknown as { page: unknown; context: unknown }).context = {};
    const downloadCandidates = vi.fn(async () => {
      expect(close).not.toHaveBeenCalled();
      return { mediaCreationTime: null, sizeBytes: 2_048 };
    });
    (session as unknown as { downloadCandidates: typeof downloadCandidates }).downloadCandidates = downloadCandidates;

    await expect(session.download("7000000000000000700", directory)).resolves.toMatchObject({
      sizeBytes: 2_048,
    });
    expect(close).not.toHaveBeenCalled();
  });
});

describe("streaming media download", () => {
  it("writes chunks while reporting known content length", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dycollect-stream-"));
    temporaryDirectories.push(directory);
    const destination = join(directory, "video.tmp");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4, 5]));
        controller.close();
      },
    });
    const progress: Array<{ receivedBytes: number; totalBytes: number | null }> = [];

    await expect(streamResponseToFile(
      new Response(stream, { headers: { "Content-Length": "5" } }),
      destination,
      undefined,
      (update) => progress.push(update),
    )).resolves.toBe(5);
    expect([...await readFile(destination)]).toEqual([1, 2, 3, 4, 5]);
    expect(progress).toEqual([
      { receivedBytes: 0, totalBytes: 5 },
      { receivedBytes: 2, totalBytes: 5 },
      { receivedBytes: 5, totalBytes: 5 },
    ]);
  });

  it("reports downloaded bytes without inventing a total size", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dycollect-stream-"));
    temporaryDirectories.push(directory);
    const progress: Array<{ receivedBytes: number; totalBytes: number | null }> = [];
    await streamResponseToFile(
      new Response(new Uint8Array([1, 2, 3])),
      join(directory, "unknown.tmp"),
      undefined,
      (update) => progress.push(update),
    );
    expect(progress.at(-1)).toEqual({ receivedBytes: 3, totalBytes: null });
    expect(parseContentLength("not-a-size")).toBeNull();
    expect(parseContentLength("0")).toBeNull();
  });

  it("allows long downloads while media chunks keep arriving", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dycollect-stream-"));
    temporaryDirectories.push(directory);
    const destination = join(directory, "large-video.tmp");
    let chunkNumber = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const pushChunk = () => {
          chunkNumber += 1;
          controller.enqueue(new Uint8Array([chunkNumber]));
          if (chunkNumber === 5) controller.close();
          else setTimeout(pushChunk, 30);
        };
        setTimeout(pushChunk, 30);
      },
    });

    await expect(streamResponseToFile(
      new Response(stream),
      destination,
      undefined,
      undefined,
      100,
    )).resolves.toBe(5);
    expect([...await readFile(destination)]).toEqual([1, 2, 3, 4, 5]);
  });

  it("stops and removes the partial file when media delivery stalls", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dycollect-stream-"));
    temporaryDirectories.push(directory);
    const destination = join(directory, "stalled-video.tmp");
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(streamResponseToFile(
      new Response(stream),
      destination,
      undefined,
      undefined,
      20,
    )).rejects.toThrow("media_download_inactivity_timeout");
    expect(cancelled).toBe(true);
    await expect(access(destination)).rejects.toBeDefined();
  });

  it("removes a partial file when cancellation interrupts the stream", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dycollect-stream-"));
    temporaryDirectories.push(directory);
    const destination = join(directory, "cancelled.tmp");
    const controller = new AbortController();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new Uint8Array([1, 2, 3]));
        streamController.enqueue(new Uint8Array([4, 5, 6]));
      },
    }));

    await expect(streamResponseToFile(response, destination, controller.signal, (update) => {
      if (update.receivedBytes > 0) controller.abort();
    })).rejects.toBeDefined();
    await expect(access(destination)).rejects.toBeDefined();
  });
});

describe("scoped media cookies", () => {
  it("rebuilds cookies for every redirect destination", async () => {
    const calls: Array<{ url: string; cookie: string | null }> = [];
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, cookie: headers.get("cookie") });
      return url.includes("first.example")
        ? new Response(null, { status: 302, headers: { Location: "https://second.example/video" } })
        : new Response(new Uint8Array([1]), { status: 200 });
    });
    const cookies = vi.fn(async (url: string) => url.includes("first.example")
      ? [{ name: "first_only", value: "one" }]
      : [{ name: "second_only", value: "two" }]);

    const response = await fetchCandidateWithScopedCookies({
      url: "https://first.example/video",
      referer: "https://www.douyin.com/",
      signal: new AbortController().signal,
      cookies,
      fetchImpl,
    });

    expect(response.status).toBe(200);
    expect(calls).toEqual([
      { url: "https://first.example/video", cookie: "first_only=one" },
      { url: "https://second.example/video", cookie: "second_only=two" },
    ]);
    expect(buildCookieHeader([{ name: "safe", value: "value" }])).toBe("safe=value");
  });

  it("rejects an insecure redirect before sending destination cookies", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(null, { status: 302, headers: { Location: "http://insecure.example/video" } }));
    const cookies = vi.fn(async () => [{ name: "session", value: "secret" }]);
    await expect(fetchCandidateWithScopedCookies({
      url: "https://first.example/video",
      referer: "https://www.douyin.com/",
      signal: new AbortController().signal,
      cookies,
      fetchImpl,
    })).rejects.toThrow("media_url_must_use_https");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
