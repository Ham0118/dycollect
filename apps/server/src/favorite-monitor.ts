import type { FavoriteListenerState } from "@dycollect/shared";
import { BROWSER_PROFILE_DIR } from "./config.js";
import { FAVORITES_URL, DyCollectDatabase } from "./db.js";
import { DouyinSession, type ProfileWork } from "./douyin.js";
import { AppError, toAppError } from "./errors.js";

export function selectNewFavoriteWorks(
  works: readonly ProfileWork[],
  knownFavoriteIds: ReadonlySet<string>,
  existingFavoriteIds: ReadonlySet<string>,
  allowAllWithoutBoundary = false,
): ProfileWork[] {
  if (works.length === 0) return [];
  const boundary = works.findIndex((work) =>
    knownFavoriteIds.has(work.awemeId) || existingFavoriteIds.has(work.awemeId));
  if (boundary < 0) {
    if (allowAllWithoutBoundary) return [...works];
    throw new AppError("interface_error", "无法确认收藏列表的新增边界，监听已安全暂停");
  }
  return works.slice(0, boundary);
}

export class FavoriteMonitor {
  private loopPromise: Promise<void> | null = null;
  private abortController: AbortController | null = null;
  private ownerSession: DouyinSession | null = null;
  private sessionPromise: Promise<DouyinSession> | null = null;
  private leases = 0;
  private initializationPending = false;
  private knownFavoriteIds = new Set<string>();
  private initializedWithEmptyBaseline = false;

  constructor(private readonly database: DyCollectDatabase) {}

  startFromPersistedState(): void {
    if (!this.database.getFavoriteListenerState().enabled) return;
    this.resetKnownFavorites();
    this.database.updateFavoriteListener({
      status: "initializing",
      baselineAwemeId: null,
      cursorAwemeId: null,
      lastCheckedAt: null,
      errorCategory: null,
      errorMessage: null,
    });
    this.begin(true);
  }

  start(): FavoriteListenerState {
    this.resetKnownFavorites();
    const state = this.database.updateFavoriteListener({
      enabled: true,
      status: "initializing",
      baselineAwemeId: null,
      cursorAwemeId: null,
      lastCheckedAt: null,
      errorCategory: null,
      errorMessage: null,
    });
    this.begin(true);
    return state;
  }

  async resume(): Promise<FavoriteListenerState> {
    const current = this.database.getFavoriteListenerState();
    if (!current.enabled) throw new AppError("interface_error", "收藏监听尚未启动");
    await this.loopPromise?.catch(() => undefined);
    const state = this.database.updateFavoriteListener({
      status: this.initializationPending ? "initializing" : "listening",
      errorCategory: null,
      errorMessage: null,
    });
    this.begin(this.initializationPending);
    return state;
  }

  async stop(): Promise<FavoriteListenerState> {
    this.database.updateFavoriteListener({ enabled: false, status: "stopping" });
    this.abortController?.abort();
    await this.loopPromise?.catch(() => undefined);
    await this.closeOwnerIfUnused();
    return this.database.updateFavoriteListener({
      status: "stopped",
      errorCategory: null,
      errorMessage: null,
    });
  }

  async shutdown(): Promise<void> {
    this.abortController?.abort();
    await this.loopPromise?.catch(() => undefined);
    if (this.ownerSession) await this.ownerSession.close();
    this.ownerSession = null;
    this.sessionPromise = null;
  }

  async acquireProcessingSession(): Promise<DouyinSession> {
    const owner = await this.ensureOwnerSession();
    this.leases += 1;
    try {
      const sibling = await owner.createSibling(true);
      await sibling.openUtilityPage();
      await owner.bringToFront();
      return sibling;
    } catch (error) {
      this.leases = Math.max(0, this.leases - 1);
      await this.closeOwnerIfUnused();
      throw error;
    }
  }

  async releaseProcessingSession(session: DouyinSession): Promise<void> {
    await session.close();
    this.leases = Math.max(0, this.leases - 1);
    await this.closeOwnerIfUnused();
  }

  private begin(initialize: boolean): void {
    if (this.loopPromise) return;
    this.initializationPending = initialize;
    this.abortController = new AbortController();
    this.loopPromise = this.run(initialize, this.abortController.signal)
      .finally(() => {
        this.loopPromise = null;
        this.abortController = null;
      });
  }

  private async run(initialize: boolean, signal: AbortSignal): Promise<void> {
    try {
      const session = await this.ensureOwnerSession();
      if (initialize) {
        const snapshot = await session.openFavorites(FAVORITES_URL);
        if (signal.aborted) return;
        this.knownFavoriteIds = new Set(snapshot.works.map((work) => work.awemeId));
        this.initializedWithEmptyBaseline = snapshot.works.length === 0;
        const baseline = snapshot.works[0]?.awemeId ?? null;
        this.database.updateFavoriteListener({
          status: "listening",
          baselineAwemeId: baseline,
          cursorAwemeId: baseline,
          lastCheckedAt: new Date().toISOString(),
          errorCategory: null,
          errorMessage: null,
        });
        this.initializationPending = false;
      } else {
        await session.openFavorites(FAVORITES_URL);
        if (signal.aborted) return;
        this.database.updateFavoriteListener({
          status: "listening",
          lastCheckedAt: new Date().toISOString(),
          errorCategory: null,
          errorMessage: null,
        });
      }

      while (!signal.aborted && this.database.getFavoriteListenerState().enabled) {
        const snapshot = await session.refreshFavorites(signal);
        if (signal.aborted) break;
        await this.processSnapshot(snapshot.works);
      }
    } catch (error) {
      if (signal.aborted) return;
      const appError = toAppError(error);
      this.database.updateFavoriteListener({
        status: appError.category === "risk_verify" ? "waiting_verification" : "error",
        errorCategory: appError.category,
        errorMessage: appError.message,
      });
    }
  }

  private async processSnapshot(works: ProfileWork[]): Promise<void> {
    const checkedAt = new Date().toISOString();
    if (works.length === 0) {
      this.database.updateFavoriteListener({ lastCheckedAt: checkedAt });
      return;
    }
    const existingFavoriteIds = this.database.findExistingFavoriteIds(
      works.map((work) => work.awemeId),
    );
    const newWorks = selectNewFavoriteWorks(
      works,
      this.knownFavoriteIds,
      existingFavoriteIds,
      this.initializedWithEmptyBaseline && this.knownFavoriteIds.size === 0,
    );
    for (const work of works) this.knownFavoriteIds.add(work.awemeId);
    this.initializedWithEmptyBaseline = false;
    const newestId = works[0]!.awemeId;
    if (newWorks.length === 0) {
      this.database.updateFavoriteListener({
        cursorAwemeId: newestId,
        lastCheckedAt: checkedAt,
      });
      return;
    }
    this.database.enqueueFavoriteWorks([...newWorks].reverse(), newestId);
  }

  private resetKnownFavorites(): void {
    this.knownFavoriteIds.clear();
    this.initializedWithEmptyBaseline = false;
  }

  private async ensureOwnerSession(): Promise<DouyinSession> {
    if (this.ownerSession) return this.ownerSession;
    if (!this.sessionPromise) {
      this.sessionPromise = (async () => {
        const session = new DouyinSession(BROWSER_PROFILE_DIR);
        await session.openUtilityPage();
        this.ownerSession = session;
        return session;
      })().finally(() => {
        this.sessionPromise = null;
      });
    }
    return this.sessionPromise;
  }

  private async closeOwnerIfUnused(): Promise<void> {
    if (this.leases > 0 || this.database.getFavoriteListenerState().enabled || !this.ownerSession) return;
    await this.ownerSession.close();
    this.ownerSession = null;
  }
}
