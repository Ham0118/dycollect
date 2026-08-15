import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ModelAvailability } from "@dycollect/shared";
import { getModelAvailability } from "./api";

interface ModelStatusContextValue {
  status: ModelAvailability | null;
  checking: boolean;
  error: string | null;
  unavailable: boolean;
  refresh: () => Promise<void>;
}

const defaultValue: ModelStatusContextValue = {
  status: null,
  checking: false,
  error: null,
  unavailable: false,
  refresh: async () => undefined,
};

const ModelStatusContext = createContext<ModelStatusContextValue>(defaultValue);

export function ModelStatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<ModelAvailability | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      setStatus(await getModelAvailability());
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法检查模型状态");
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  const unavailable = Boolean(status && status.state !== "ready");
  useEffect(() => {
    if (!unavailable) return;
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [refresh, unavailable]);

  const value = useMemo(() => ({ status, checking, error, unavailable, refresh }), [status, checking, error, unavailable, refresh]);
  return <ModelStatusContext.Provider value={value}>{children}</ModelStatusContext.Provider>;
}

export function useModelStatus(): ModelStatusContextValue {
  return useContext(ModelStatusContext);
}
