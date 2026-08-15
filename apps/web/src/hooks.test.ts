import { describe, expect, it } from "vitest";
import type { DashboardSnapshot } from "@dycollect/shared";
import { shouldApplyDashboardRefresh, shouldPollDashboard } from "./hooks";

function snapshot(input: {
  listenerEnabled?: boolean;
  activeJob?: DashboardSnapshot["activeJob"];
} = {}): DashboardSnapshot {
  return {
    activeJob: input.activeJob ?? null,
    queuedJobs: [],
    recentJobs: [],
    logJobId: null,
    jobLogs: [],
    favoriteListener: {
      enabled: input.listenerEnabled ?? false,
      status: input.listenerEnabled ? "listening" : "stopped",
      baselineAwemeId: null,
      cursorAwemeId: null,
      lastCheckedAt: null,
      errorCategory: null,
      errorMessage: null,
      updatedAt: new Date(0).toISOString(),
    },
    downloadProgress: null,
    debugBrowser: { status: "closed" },
  };
}

describe("dashboard snapshot ordering", () => {
  it("rejects an HTTP snapshot when a newer SSE snapshot arrived", () => {
    expect(shouldApplyDashboardRefresh(2, 3, 1, 1)).toBe(false);
  });

  it("rejects an older concurrent HTTP response", () => {
    expect(shouldApplyDashboardRefresh(2, 2, 1, 2)).toBe(false);
    expect(shouldApplyDashboardRefresh(2, 2, 2, 2)).toBe(true);
  });
});

describe("dashboard fallback polling", () => {
  it("keeps polling while a listener is enabled without an active job", () => {
    expect(shouldPollDashboard(snapshot({ listenerEnabled: true }))).toBe(true);
  });

  it("does not poll an idle dashboard", () => {
    expect(shouldPollDashboard(snapshot())).toBe(false);
  });
});
