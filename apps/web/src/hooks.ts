import { useCallback, useEffect, useRef, useState } from "react";
import type { DashboardSnapshot } from "@dycollect/shared";
import { getDashboard } from "./api";

export function shouldApplyDashboardRefresh(
  pushRevisionAtStart: number,
  currentPushRevision: number,
  requestId: number,
  latestRequestId: number,
): boolean {
  return pushRevisionAtStart === currentPushRevision && requestId === latestRequestId;
}

export function shouldPollDashboard(snapshot: DashboardSnapshot | null): boolean {
  return Boolean(snapshot?.activeJob || snapshot?.favoriteListener.enabled);
}

export function useDashboard(): {
  snapshot: DashboardSnapshot | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pushRevision = useRef(0);
  const latestRequestId = useRef(0);
  const refresh = useCallback(async () => {
    const pushRevisionAtStart = pushRevision.current;
    const requestId = latestRequestId.current + 1;
    latestRequestId.current = requestId;
    try {
      const nextSnapshot = await getDashboard();
      if (shouldApplyDashboardRefresh(
        pushRevisionAtStart,
        pushRevision.current,
        requestId,
        latestRequestId.current,
      )) {
        setSnapshot(nextSnapshot);
      }
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法读取任务状态");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const stream = new EventSource("/events");
    stream.addEventListener("snapshot", (event) => {
      try {
        const nextSnapshot = JSON.parse((event as MessageEvent<string>).data) as DashboardSnapshot;
        pushRevision.current += 1;
        setSnapshot(nextSnapshot);
        setError(null);
        setLoading(false);
      } catch {
        // A later event or refresh will recover malformed transient data.
      }
    });
    stream.onerror = () => setError("实时连接正在重试，页面数据可能稍有延迟");
    return () => stream.close();
  }, [refresh]);

  useEffect(() => {
    if (!shouldPollDashboard(snapshot)) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [refresh, snapshot?.activeJob?.id, snapshot?.favoriteListener.enabled]);

  return { snapshot, loading, error, refresh };
}
