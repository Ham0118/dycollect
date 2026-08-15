import type {
  ArticleDetail,
  AsrDevice,
  AsrSettingsView,
  ClearJobLogsResult,
  ClearTerminalJobsResult,
  Creator,
  CrawlJob,
  DashboardSnapshot,
  DebugBrowserState,
  DeleteCreatorResult,
  DeleteFavoriteVideoResult,
  DeleteJobResult,
  DeleteVideoResult,
  FeishuSettingsView,
  FeishuSpace,
  FeishuSyncRequest,
  FeishuSyncResult,
  FavoriteArticleDetail,
  FavoriteListenerState,
  PaginatedJobs,
  PaginatedFavorites,
  PaginatedVideos,
  ModelAvailability,
  UpdateFavoriteFeishuAutoSyncRequest,
} from "@dycollect/shared";

export class ApiRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const method = (options?.method ?? "GET").toUpperCase();
  const response = await fetch(`/api${path}`, {
    ...options,
    cache: options?.cache ?? (method === "GET" ? "no-store" : undefined),
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ message: "请求失败" })) as { error?: string; message?: string };
    throw new ApiRequestError(body.message ?? `请求失败：${response.status}`, response.status, body.error ?? null);
  }
  return response.json() as Promise<T>;
}

export const getDashboard = () => api<DashboardSnapshot>("/dashboard");
export const getModelAvailability = () => api<ModelAvailability>("/system/model");
export const createJob = (input: { profileUrl: string; targetCount: number; retryPermanent: boolean }) =>
  api<CrawlJob>("/jobs", { method: "POST", body: JSON.stringify(input) });
export const getJobs = (page: number) => api<PaginatedJobs>(`/jobs?page=${page}`);
export const deleteJob = (id: number) => api<DeleteJobResult>(`/jobs/${id}`, { method: "DELETE" });
export const cancelJob = (id: number) => api<CrawlJob>(`/jobs/${id}/cancel`, { method: "POST" });
export const resumeJob = (id: number) => api<CrawlJob>(`/jobs/${id}/resume`, { method: "POST" });
export const openDebugBrowser = () =>
  api<DebugBrowserState>("/browser/debug/open", { method: "POST" });
export const getCreators = () => api<Creator[]>("/creators");
export const getCreator = (secUid: string) => api<Creator>(`/creators/${encodeURIComponent(secUid)}`);
export const deleteCreator = (secUid: string) =>
  api<DeleteCreatorResult>(`/creators/${encodeURIComponent(secUid)}`, { method: "DELETE" });
export const getVideos = (secUid: string, page: number) =>
  api<PaginatedVideos>(`/creators/${encodeURIComponent(secUid)}/videos?page=${page}`);
export const deleteVideo = (awemeId: string) =>
  api<DeleteVideoResult>(`/videos/${encodeURIComponent(awemeId)}`, { method: "DELETE" });
export const getArticle = (awemeId: string) => api<ArticleDetail>(`/articles/${encodeURIComponent(awemeId)}`);
export const getFavorites = (page: number) => api<PaginatedFavorites>(`/favorites?page=${page}`);
export const getFavoriteArticle = (awemeId: string) =>
  api<FavoriteArticleDetail>(`/favorites/${encodeURIComponent(awemeId)}`);
export const deleteFavoriteVideo = (awemeId: string) =>
  api<DeleteFavoriteVideoResult>(`/favorites/${encodeURIComponent(awemeId)}`, { method: "DELETE" });
export const getFavoriteListener = () => api<FavoriteListenerState>("/favorites/listener");
export const startFavoriteListener = () =>
  api<FavoriteListenerState>("/favorites/listener/start", { method: "POST" });
export const stopFavoriteListener = () =>
  api<FavoriteListenerState>("/favorites/listener/stop", { method: "POST" });
export const resumeFavoriteListener = () =>
  api<FavoriteListenerState>("/favorites/listener/resume", { method: "POST" });
export const getFeishuSettings = () => api<FeishuSettingsView>("/settings/feishu");
export const getAsrSettings = () => api<AsrSettingsView>("/settings/asr");
export const saveAsrSettings = (device: AsrDevice) =>
  api<AsrSettingsView>("/settings/asr", { method: "PUT", body: JSON.stringify({ device }) });
export const saveFeishuSettings = (input: { appId: string; appSecret?: string }) =>
  api<FeishuSettingsView>("/settings/feishu", { method: "PUT", body: JSON.stringify(input) });
export const saveFavoriteFeishuAutoSyncSettings = (input: UpdateFavoriteFeishuAutoSyncRequest) =>
  api<FeishuSettingsView>("/settings/feishu/favorites", {
    method: "PUT",
    body: JSON.stringify(input),
  });
export const clearJobLogs = () =>
  api<ClearJobLogsResult>("/maintenance/job-logs", { method: "DELETE" });
export const clearTerminalJobs = () =>
  api<ClearTerminalJobsResult>("/maintenance/terminal-jobs", { method: "DELETE" });
export const getFeishuSpaces = () => api<FeishuSpace[]>("/feishu/spaces");
export const syncFeishuArticles = (input: FeishuSyncRequest) =>
  api<FeishuSyncResult>("/feishu/sync", { method: "POST", body: JSON.stringify(input) });
