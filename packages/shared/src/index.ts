export type JobStatus =
  | "queued"
  | "running"
  | "waiting_verification"
  | "completed"
  | "completed_partial"
  | "cancelled"
  | "failed";

export type VideoStatus =
  | "discovered"
  | "downloading"
  | "downloaded"
  | "transcribing"
  | "completed"
  | "failed";

export type JobStage = "waiting" | "discovering" | "downloading" | "transcribing" | "finalizing";
export type JobMode = "creator" | "favorite";

export type JobLogLevel = "info" | "success" | "warning" | "error";

export type JobLogStage =
  | "task"
  | "discovering"
  | "waiting"
  | "downloading"
  | "extracting_audio"
  | "transcribing"
  | "skipped"
  | "verification"
  | "completed";

export interface JobLog {
  id: number;
  jobId: number;
  awemeId: string | null;
  level: JobLogLevel;
  stage: JobLogStage;
  message: string;
  createdAt: string;
}

export interface DownloadProgress {
  jobId: number;
  awemeId: string;
  title: string;
  receivedBytes: number;
  totalBytes: number | null;
  percent: number | null;
  updatedAt: string;
}

export interface CrawlJobBase {
  id: number;
  targetCount: number;
  retryPermanent: boolean;
  status: JobStatus;
  stage: JobStage;
  discoveredCount: number;
  duplicateCount: number;
  completedCount: number;
  failedCount: number;
  processedCount: number;
  currentAwemeId: string | null;
  errorCategory: string | null;
  errorMessage: string | null;
  cancelRequested: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface CreatorCrawlJob extends CrawlJobBase {
  mode: "creator";
  sourceAwemeId: null;
  profileUrl: string;
  secUid: string;
  creatorNickname: string | null;
}

export interface FavoriteCrawlJob extends CrawlJobBase {
  mode: "favorite";
  sourceAwemeId: string;
  profileUrl: null;
  secUid: null;
  creatorNickname: null;
}

export type CrawlJob = CreatorCrawlJob | FavoriteCrawlJob;

export interface Creator {
  secUid: string;
  profileUrl: string;
  nickname: string;
  displayedPostCount: number | null;
  completedCount: number;
  firstSeenAt: string;
  lastCrawledAt: string | null;
  updatedAt: string;
}

export interface BaseVideoRecord {
  awemeId: string;
  title: string;
  author: string;
  sourceUrl: string;
  publishedAt: string | null;
  publishedAtSource: "aweme_id" | "media" | "unknown";
  status: VideoStatus;
  failureCategory: string | null;
  failureReason: string | null;
  attempts: number;
  markdownPath: string | null;
  mediaPath: string | null;
  feishuSynced: boolean;
  discoveredAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface VideoRecord extends BaseVideoRecord {
  secUid: string;
}

export interface ArticleDetail extends VideoRecord {
  markdown: string | null;
  articleAvailable: boolean;
}

export interface PaginatedVideos {
  items: VideoRecord[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export type FavoriteVideoRecord = BaseVideoRecord;

export interface FavoriteArticleDetail extends FavoriteVideoRecord {
  markdown: string | null;
  articleAvailable: boolean;
}

export interface PaginatedFavorites {
  items: FavoriteVideoRecord[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export type FavoriteListenerStatus =
  | "stopped"
  | "initializing"
  | "listening"
  | "waiting_verification"
  | "error"
  | "stopping";

export interface FavoriteListenerState {
  enabled: boolean;
  status: FavoriteListenerStatus;
  baselineAwemeId: string | null;
  cursorAwemeId: string | null;
  lastCheckedAt: string | null;
  errorCategory: string | null;
  errorMessage: string | null;
  updatedAt: string;
}

export interface PaginatedJobs {
  items: CrawlJob[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface DeleteJobResult {
  deleted: true;
  jobId: number;
}

export interface ClearJobLogsResult {
  deletedLogs: number;
}

export interface ClearTerminalJobsResult {
  deletedJobs: number;
}

export interface DeleteCreatorResult {
  deleted: true;
  secUid: string;
  deletedVideos: number;
}

export interface DeleteVideoResult {
  deleted: true;
  awemeId: string;
  secUid: string;
}

export interface DeleteFavoriteVideoResult {
  deleted: true;
  awemeId: string;
}

export interface FeishuSettingsView {
  appId: string;
  appSecretConfigured: boolean;
  favoriteAutoSync: FavoriteFeishuAutoSyncSettings;
  updatedAt: string | null;
}

export interface FavoriteFeishuAutoSyncSettings {
  enabled: boolean;
  spaceId: string | null;
}

export interface UpdateFavoriteFeishuAutoSyncRequest {
  enabled: boolean;
  spaceId: string | null;
}

export interface FeishuSpace {
  spaceId: string;
  name: string;
  description: string | null;
}

export type FeishuSyncSource = "creator" | "favorite";

export interface FeishuSyncRequest {
  source: FeishuSyncSource;
  spaceId: string;
  awemeIds: string[];
}

export type FeishuSyncItemStatus = "synced" | "skipped" | "failed";

export interface FeishuSyncItemResult {
  awemeId: string;
  title: string;
  status: FeishuSyncItemStatus;
  message: string;
}

export interface FeishuSyncResult {
  spaceId: string;
  total: number;
  synced: number;
  skipped: number;
  failed: number;
  items: FeishuSyncItemResult[];
}

export type DebugBrowserStatus = "closed" | "opening" | "open";

export interface DebugBrowserState {
  status: DebugBrowserStatus;
}

export interface DashboardSnapshot {
  activeJob: CrawlJob | null;
  queuedJobs: CrawlJob[];
  recentJobs: CrawlJob[];
  logJobId: number | null;
  jobLogs: JobLog[];
  downloadProgress: DownloadProgress | null;
  debugBrowser: DebugBrowserState;
  favoriteListener: FavoriteListenerState;
}

export interface ApiErrorBody {
  error: string;
  message: string;
}

export type ModelAvailabilityState = "ready" | "missing" | "incomplete";

export interface ModelAvailability {
  state: ModelAvailabilityState;
  modelId: string;
  missingFiles: string[];
  setupCommand: string;
}

export type AsrDevice = "auto" | "cpu" | "cuda" | "mps";
export type AsrConcreteDevice = Exclude<AsrDevice, "auto">;

export interface AsrSettingsView {
  selectedDevice: AsrDevice;
  resolvedDevice: AsrConcreteDevice | null;
  availableDevices: AsrConcreteDevice[];
  diagnostic: string | null;
}

export interface UpdateAsrSettingsRequest {
  device: AsrDevice;
}
