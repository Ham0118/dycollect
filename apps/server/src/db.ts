import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  ClearJobLogsResult,
  ClearTerminalJobsResult,
  Creator,
  CrawlJob,
  DashboardSnapshot,
  AsrDevice,
  FavoriteFeishuAutoSyncSettings,
  FavoriteListenerState,
  FavoriteVideoRecord,
  JobLog,
  JobLogLevel,
  JobLogStage,
  JobStage,
  JobStatus,
  PaginatedJobs,
  PaginatedFavorites,
  PaginatedVideos,
  VideoRecord,
  VideoStatus,
} from "@dycollect/shared";

export interface FeishuCredentials {
  appId: string;
  appSecret: string;
  updatedAt: string;
}

export type FeishuSyncStatus = "pending" | "synced" | "failed";

export interface FeishuSyncRecord {
  awemeId: string;
  spaceId: string;
  nodeToken: string;
  documentId: string;
  status: FeishuSyncStatus;
  writtenBlocks: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

type SqlValue = string | number | bigint | null;

const nowIso = () => new Date().toISOString();
const CURRENT_SCHEMA_VERSION = 2;
const JOB_WITH_STATS_SELECT = `
  SELECT j.*,
    (SELECT COUNT(*) FROM job_videos completed
      WHERE completed.job_id=j.id AND completed.outcome='completed') AS completed_count,
    (SELECT COUNT(*) FROM job_videos failed
      WHERE failed.job_id=j.id AND failed.outcome='failed') AS failed_count,
    (SELECT COUNT(*) FROM job_videos skipped
      WHERE skipped.job_id=j.id AND skipped.outcome='skipped') AS duplicate_count
  FROM crawl_jobs j
`;
export const FAVORITES_URL =
  "https://www.douyin.com/user/self?from_tab_name=main&showSubTab=video&showTab=favorite_collection";

export class DyCollectDatabase {
  private readonly db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const version = Number(this.db.pragma("user_version", { simple: true }));
    if (version > CURRENT_SCHEMA_VERSION) {
      throw new Error(`Database schema version ${version} is newer than supported version ${CURRENT_SCHEMA_VERSION}`);
    }
    if (version === 0) {
      const hasLegacySchema = [
        "creators",
        "videos",
        "crawl_jobs",
        "favorite_videos",
        "feishu_settings",
      ].some((table) => this.tableExists(table));
      if (hasLegacySchema) {
        this.migrateUnversionedDatabase();
      } else {
        this.db.transaction(() => this.createFinalSchema())();
      }
      this.db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
    } else if (version < 2) {
      this.createAsrSettingsSchema();
      this.db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
    }
    this.initializeSingletonRows();
  }

  private createFinalSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS creators (
        sec_uid TEXT PRIMARY KEY,
        profile_url TEXT NOT NULL UNIQUE,
        nickname TEXT NOT NULL DEFAULT '',
        displayed_post_count INTEGER,
        first_seen_at TEXT NOT NULL,
        last_crawled_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS videos (
        aweme_id TEXT PRIMARY KEY,
        sec_uid TEXT NOT NULL REFERENCES creators(sec_uid) ON DELETE CASCADE,
        title TEXT NOT NULL DEFAULT '',
        author TEXT NOT NULL DEFAULT '',
        source_url TEXT NOT NULL,
        published_at TEXT,
        published_at_source TEXT NOT NULL DEFAULT 'unknown'
          CHECK (published_at_source IN ('aweme_id', 'media', 'unknown')),
        status TEXT NOT NULL DEFAULT 'discovered'
          CHECK (status IN ('discovered','downloading','downloaded','transcribing','completed','failed')),
        failure_category TEXT,
        failure_reason TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        markdown_path TEXT,
        media_path TEXT,
        feishu_synced INTEGER NOT NULL DEFAULT 0 CHECK (feishu_synced IN (0, 1)),
        discovered_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_videos_creator_published
        ON videos(sec_uid, published_at DESC, aweme_id DESC);

      CREATE TABLE IF NOT EXISTS crawl_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mode TEXT NOT NULL DEFAULT 'creator'
          CHECK (mode IN ('creator','favorite')),
        source_aweme_id TEXT,
        profile_url TEXT,
        sec_uid TEXT,
        creator_nickname TEXT,
        target_count INTEGER NOT NULL,
        retry_permanent INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'queued'
          CHECK (status IN ('queued','running','waiting_verification','completed','completed_partial','cancelled','failed')),
        stage TEXT NOT NULL DEFAULT 'waiting'
          CHECK (stage IN ('waiting','discovering','downloading','transcribing','finalizing')),
        discovered_count INTEGER NOT NULL DEFAULT 0,
        current_aweme_id TEXT,
        error_category TEXT,
        error_message TEXT,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        updated_at TEXT NOT NULL,
        CHECK (
          (
            mode = 'creator'
            AND profile_url IS NOT NULL AND length(trim(profile_url)) > 0
            AND sec_uid IS NOT NULL AND length(trim(sec_uid)) > 0
            AND source_aweme_id IS NULL
          )
          OR
          (
            mode = 'favorite'
            AND source_aweme_id IS NOT NULL AND length(trim(source_aweme_id)) > 0
            AND profile_url IS NULL
            AND sec_uid IS NULL
            AND creator_nickname IS NULL
            AND target_count = 1
            AND retry_permanent = 0
          )
        )
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON crawl_jobs(status, created_at);

      CREATE TABLE IF NOT EXISTS job_videos (
        job_id INTEGER NOT NULL REFERENCES crawl_jobs(id) ON DELETE CASCADE,
        aweme_id TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('completed','skipped','failed')),
        error_category TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (job_id, aweme_id)
      );

      CREATE TABLE IF NOT EXISTS job_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER NOT NULL REFERENCES crawl_jobs(id) ON DELETE CASCADE,
        aweme_id TEXT,
        level TEXT NOT NULL
          CHECK (level IN ('info','success','warning','error')),
        stage TEXT NOT NULL
          CHECK (stage IN (
            'task','discovering','waiting','downloading','extracting_audio',
            'transcribing','skipped','verification','completed'
          )),
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_job_logs_job_id_id
        ON job_logs(job_id, id);

      CREATE TABLE IF NOT EXISTS feishu_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        app_id TEXT NOT NULL,
        app_secret TEXT NOT NULL,
        favorite_auto_sync_enabled INTEGER NOT NULL DEFAULT 0,
        favorite_auto_sync_space_id TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS feishu_syncs (
        aweme_id TEXT NOT NULL REFERENCES videos(aweme_id) ON DELETE CASCADE,
        space_id TEXT NOT NULL,
        node_token TEXT NOT NULL,
        document_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','synced','failed')),
        written_blocks INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (aweme_id, space_id)
      );

      CREATE TABLE IF NOT EXISTS favorite_listener (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        enabled INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'stopped'
          CHECK (status IN ('stopped','initializing','listening','waiting_verification','error','stopping')),
        baseline_aweme_id TEXT,
        cursor_aweme_id TEXT,
        last_checked_at TEXT,
        error_category TEXT,
        error_message TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS favorite_videos (
        aweme_id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        author TEXT NOT NULL DEFAULT '',
        source_url TEXT NOT NULL,
        published_at TEXT,
        published_at_source TEXT NOT NULL DEFAULT 'unknown'
          CHECK (published_at_source IN ('aweme_id', 'media', 'unknown')),
        status TEXT NOT NULL DEFAULT 'discovered'
          CHECK (status IN ('discovered','downloading','downloaded','transcribing','completed','failed')),
        failure_category TEXT,
        failure_reason TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        markdown_path TEXT,
        media_path TEXT,
        feishu_synced INTEGER NOT NULL DEFAULT 0 CHECK (feishu_synced IN (0, 1)),
        discovered_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_favorite_videos_discovered
        ON favorite_videos(discovered_at DESC, aweme_id DESC);

      CREATE TABLE IF NOT EXISTS favorite_feishu_syncs (
        aweme_id TEXT NOT NULL REFERENCES favorite_videos(aweme_id) ON DELETE CASCADE,
        space_id TEXT NOT NULL,
        node_token TEXT NOT NULL,
        document_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','synced','failed')),
        written_blocks INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (aweme_id, space_id)
      );
    `);
    this.createAsrSettingsSchema();
  }

  private createAsrSettingsSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS asr_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        device TEXT NOT NULL DEFAULT 'auto'
          CHECK (device IN ('auto','cpu','cuda','mps')),
        updated_at TEXT NOT NULL
      );
    `);
  }

  private migrateUnversionedDatabase(): void {
    this.db.transaction(() => {
      if (this.tableExists("videos") && !this.columnExists("videos", "feishu_synced")) {
        this.db.exec(`ALTER TABLE videos ADD COLUMN feishu_synced INTEGER NOT NULL DEFAULT 0 CHECK (feishu_synced IN (0, 1))`);
      }
      if (this.tableExists("favorite_videos") && !this.columnExists("favorite_videos", "feishu_synced")) {
        this.db.exec(`ALTER TABLE favorite_videos ADD COLUMN feishu_synced INTEGER NOT NULL DEFAULT 0 CHECK (feishu_synced IN (0, 1))`);
      }
      if (this.tableExists("feishu_settings") && !this.columnExists("feishu_settings", "favorite_auto_sync_enabled")) {
        this.db.exec(`ALTER TABLE feishu_settings ADD COLUMN favorite_auto_sync_enabled INTEGER NOT NULL DEFAULT 0`);
      }
      if (this.tableExists("feishu_settings") && !this.columnExists("feishu_settings", "favorite_auto_sync_space_id")) {
        this.db.exec(`ALTER TABLE feishu_settings ADD COLUMN favorite_auto_sync_space_id TEXT`);
      }

      this.db.exec(`
        DROP TABLE IF EXISTS job_logs;
        DROP TABLE IF EXISTS job_videos;
        DROP TABLE IF EXISTS crawl_jobs;
      `);
      this.createFinalSchema();
      this.db.prepare(`
        UPDATE favorite_listener
        SET enabled=0, status='stopped', error_category=NULL, error_message=NULL, updated_at=?
        WHERE id=1
      `).run(nowIso());
    })();
  }

  private initializeSingletonRows(): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO favorite_listener(
        id, enabled, status, updated_at
      ) VALUES (1, 0, 'stopped', ?)
    `).run(nowIso());
    this.db.prepare(`
      INSERT OR IGNORE INTO asr_settings(id, device, updated_at)
      VALUES (1, 'auto', ?)
    `).run(nowIso());
  }

  private tableExists(table: string): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM sqlite_master WHERE type='table' AND name=?
    `).get(table));
  }

  private columnExists(table: string, column: string): boolean {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return columns.some((item) => item.name === column);
  }

  getAsrDevice(): AsrDevice {
    const row = this.db.prepare(`SELECT device FROM asr_settings WHERE id=1`).get() as { device: AsrDevice } | undefined;
    return row?.device ?? "auto";
  }

  saveAsrDevice(device: AsrDevice): AsrDevice {
    this.db.prepare(`UPDATE asr_settings SET device=?, updated_at=? WHERE id=1`).run(device, nowIso());
    return this.getAsrDevice();
  }

  getFeishuCredentials(): FeishuCredentials | null {
    const row = this.db.prepare(`SELECT app_id, app_secret, updated_at FROM feishu_settings WHERE id=1`).get() as Record<string, unknown> | undefined;
    return row ? {
      appId: String(row.app_id),
      appSecret: String(row.app_secret),
      updatedAt: String(row.updated_at),
    } : null;
  }

  saveFeishuCredentials(appId: string, appSecret: string): FeishuCredentials {
    const updatedAt = nowIso();
    this.db.prepare(`
      INSERT INTO feishu_settings(id, app_id, app_secret, updated_at)
      VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        app_id=excluded.app_id,
        app_secret=excluded.app_secret,
        updated_at=excluded.updated_at
    `).run(appId, appSecret, updatedAt);
    return this.getFeishuCredentials()!;
  }

  getFavoriteFeishuAutoSyncSettings(): FavoriteFeishuAutoSyncSettings {
    const row = this.db.prepare(`
      SELECT favorite_auto_sync_enabled, favorite_auto_sync_space_id
      FROM feishu_settings WHERE id=1
    `).get() as Record<string, unknown> | undefined;
    return {
      enabled: Boolean(row?.favorite_auto_sync_enabled),
      spaceId: row?.favorite_auto_sync_space_id
        ? String(row.favorite_auto_sync_space_id)
        : null,
    };
  }

  saveFavoriteFeishuAutoSyncSettings(
    enabled: boolean,
    spaceId: string | null,
  ): FavoriteFeishuAutoSyncSettings {
    const result = this.db.prepare(`
      UPDATE feishu_settings
      SET favorite_auto_sync_enabled=?, favorite_auto_sync_space_id=?, updated_at=?
      WHERE id=1
    `).run(enabled ? 1 : 0, spaceId, nowIso());
    if (result.changes === 0) {
      throw new Error("Feishu credentials must be configured before favorite auto sync");
    }
    return this.getFavoriteFeishuAutoSyncSettings();
  }

  getFeishuSync(awemeId: string, spaceId: string): FeishuSyncRecord | null {
    const row = this.db.prepare(`SELECT * FROM feishu_syncs WHERE aweme_id=? AND space_id=?`).get(awemeId, spaceId) as Record<string, unknown> | undefined;
    return row ? mapFeishuSync(row) : null;
  }

  createFeishuSync(input: {
    awemeId: string;
    spaceId: string;
    nodeToken: string;
    documentId: string;
  }): FeishuSyncRecord {
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO feishu_syncs(
        aweme_id, space_id, node_token, document_id, status,
        written_blocks, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', 0, NULL, ?, ?)
    `).run(input.awemeId, input.spaceId, input.nodeToken, input.documentId, now, now);
    return this.getFeishuSync(input.awemeId, input.spaceId)!;
  }

  updateFeishuSyncProgress(awemeId: string, spaceId: string, writtenBlocks: number): void {
    this.db.prepare(`
      UPDATE feishu_syncs
      SET status='pending', written_blocks=?, last_error=NULL, updated_at=?
      WHERE aweme_id=? AND space_id=?
    `).run(writtenBlocks, nowIso(), awemeId, spaceId);
  }

  completeFeishuSync(awemeId: string, spaceId: string, writtenBlocks: number): void {
    this.db.transaction(() => {
      const now = nowIso();
      const syncResult = this.db.prepare(`
        UPDATE feishu_syncs
        SET status='synced', written_blocks=?, last_error=NULL, updated_at=?
        WHERE aweme_id=? AND space_id=?
      `).run(writtenBlocks, now, awemeId, spaceId);
      const videoResult = this.db.prepare(`
        UPDATE videos SET feishu_synced=1, updated_at=? WHERE aweme_id=?
      `).run(now, awemeId);
      if (syncResult.changes !== 1 || videoResult.changes !== 1) {
        throw new Error("Cannot complete missing creator Feishu sync");
      }
    })();
  }

  failFeishuSync(awemeId: string, spaceId: string, message: string): void {
    this.db.prepare(`
      UPDATE feishu_syncs
      SET status='failed', last_error=?, updated_at=?
      WHERE aweme_id=? AND space_id=?
    `).run(message, nowIso(), awemeId, spaceId);
  }

  getFavoriteFeishuSync(awemeId: string, spaceId: string): FeishuSyncRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM favorite_feishu_syncs WHERE aweme_id=? AND space_id=?
    `).get(awemeId, spaceId) as Record<string, unknown> | undefined;
    return row ? mapFeishuSync(row) : null;
  }

  createFavoriteFeishuSync(input: {
    awemeId: string;
    spaceId: string;
    nodeToken: string;
    documentId: string;
  }): FeishuSyncRecord {
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO favorite_feishu_syncs(
        aweme_id, space_id, node_token, document_id, status,
        written_blocks, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', 0, NULL, ?, ?)
    `).run(input.awemeId, input.spaceId, input.nodeToken, input.documentId, now, now);
    return this.getFavoriteFeishuSync(input.awemeId, input.spaceId)!;
  }

  updateFavoriteFeishuSyncProgress(awemeId: string, spaceId: string, writtenBlocks: number): void {
    this.db.prepare(`
      UPDATE favorite_feishu_syncs
      SET status='pending', written_blocks=?, last_error=NULL, updated_at=?
      WHERE aweme_id=? AND space_id=?
    `).run(writtenBlocks, nowIso(), awemeId, spaceId);
  }

  completeFavoriteFeishuSync(awemeId: string, spaceId: string, writtenBlocks: number): void {
    this.db.transaction(() => {
      const now = nowIso();
      const syncResult = this.db.prepare(`
        UPDATE favorite_feishu_syncs
        SET status='synced', written_blocks=?, last_error=NULL, updated_at=?
        WHERE aweme_id=? AND space_id=?
      `).run(writtenBlocks, now, awemeId, spaceId);
      const videoResult = this.db.prepare(`
        UPDATE favorite_videos SET feishu_synced=1, updated_at=? WHERE aweme_id=?
      `).run(now, awemeId);
      if (syncResult.changes !== 1 || videoResult.changes !== 1) {
        throw new Error("Cannot complete missing favorite Feishu sync");
      }
    })();
  }

  failFavoriteFeishuSync(awemeId: string, spaceId: string, message: string): void {
    this.db.prepare(`
      UPDATE favorite_feishu_syncs
      SET status='failed', last_error=?, updated_at=?
      WHERE aweme_id=? AND space_id=?
    `).run(message, nowIso(), awemeId, spaceId);
  }

  recoverInterruptedJobs(): void {
    const now = nowIso();
    this.db.prepare(`
      UPDATE crawl_jobs
      SET status = 'queued', stage = 'waiting', current_aweme_id = NULL,
          cancel_requested = 0, updated_at = ?
      WHERE status IN ('running', 'waiting_verification')
    `).run(now);
  }

  createJob(profileUrl: string, secUid: string, targetCount: number, retryPermanent: boolean): CrawlJob {
    const now = nowIso();
    const result = this.db.prepare(`
      INSERT INTO crawl_jobs (
        mode, source_aweme_id, profile_url, sec_uid, creator_nickname,
        target_count, retry_permanent, status, stage, created_at, updated_at
      ) VALUES ('creator', NULL, ?, ?, NULL, ?, ?, 'queued', 'waiting', ?, ?)
    `).run(profileUrl, secUid, targetCount, retryPermanent ? 1 : 0, now, now);
    return this.getJob(Number(result.lastInsertRowid))!;
  }

  getFavoriteListenerState(): FavoriteListenerState {
    const row = this.db.prepare(`SELECT * FROM favorite_listener WHERE id=1`).get() as Record<string, unknown>;
    return mapFavoriteListener(row);
  }

  updateFavoriteListener(fields: Partial<{
    enabled: boolean;
    status: FavoriteListenerState["status"];
    baselineAwemeId: string | null;
    cursorAwemeId: string | null;
    lastCheckedAt: string | null;
    errorCategory: string | null;
    errorMessage: string | null;
  }>): FavoriteListenerState {
    const columns: Record<string, string> = {
      enabled: "enabled",
      status: "status",
      baselineAwemeId: "baseline_aweme_id",
      cursorAwemeId: "cursor_aweme_id",
      lastCheckedAt: "last_checked_at",
      errorCategory: "error_category",
      errorMessage: "error_message",
    };
    const entries = Object.entries(fields);
    if (entries.length) {
      const values = entries.map(([key, value]) => key === "enabled" ? (value ? 1 : 0) : value as SqlValue);
      values.push(nowIso());
      this.db.prepare(`
        UPDATE favorite_listener
        SET ${entries.map(([key]) => `${columns[key]}=?`).join(", ")}, updated_at=?
        WHERE id=1
      `).run(...values);
    }
    return this.getFavoriteListenerState();
  }

  hasPendingJobs(mode?: "creator" | "favorite"): boolean {
    const row = mode
      ? this.db.prepare(`
          SELECT 1 FROM crawl_jobs
          WHERE mode=? AND status IN ('queued','running','waiting_verification')
          LIMIT 1
        `).get(mode)
      : this.db.prepare(`
          SELECT 1 FROM crawl_jobs
          WHERE status IN ('queued','running','waiting_verification')
          LIMIT 1
        `).get();
    return Boolean(row);
  }

  enqueueFavoriteWorks(
    works: Array<{ awemeId: string; title: string; url: string }>,
    cursorAwemeId: string,
  ): CrawlJob[] {
    return this.db.transaction(() => {
      const jobs: CrawlJob[] = [];
      for (const work of works) {
        const now = nowIso();
        const inserted = this.db.prepare(`
          INSERT OR IGNORE INTO favorite_videos(
            aweme_id, title, author, source_url, published_at, published_at_source,
            status, discovered_at, updated_at
          ) VALUES (?, ?, '', ?, NULL, 'unknown', 'discovered', ?, ?)
        `).run(work.awemeId, work.title, work.url, now, now);
        if (inserted.changes === 0) continue;
        const result = this.db.prepare(`
          INSERT INTO crawl_jobs(
            mode, source_aweme_id, profile_url, sec_uid, creator_nickname,
            target_count, retry_permanent, status, stage,
            discovered_count, created_at, updated_at
          ) VALUES ('favorite', ?, NULL, NULL, NULL, 1, 0, 'queued', 'waiting', 1, ?, ?)
        `).run(work.awemeId, now, now);
        const job = this.getJob(Number(result.lastInsertRowid));
        if (job) jobs.push(job);
      }
      this.db.prepare(`
        UPDATE favorite_listener
        SET cursor_aweme_id=?, last_checked_at=?, error_category=NULL,
            error_message=NULL, updated_at=?
        WHERE id=1
      `).run(cursorAwemeId, nowIso(), nowIso());
      return jobs;
    })();
  }

  getFavoriteVideo(awemeId: string): FavoriteVideoRecord | null {
    const row = this.db.prepare(`SELECT * FROM favorite_videos WHERE aweme_id=?`).get(awemeId) as Record<string, unknown> | undefined;
    return row ? mapFavoriteVideo(row) : null;
  }

  deleteFavoriteVideo(awemeId: string): boolean {
    return this.db.prepare(`DELETE FROM favorite_videos WHERE aweme_id=?`).run(awemeId).changes > 0;
  }

  hasPendingFavoriteJob(awemeId: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 FROM crawl_jobs
      WHERE mode='favorite' AND source_aweme_id=?
        AND status IN ('queued','running','waiting_verification')
      LIMIT 1
    `).get(awemeId);
    return Boolean(row);
  }

  findExistingFavoriteIds(awemeIds: readonly string[]): Set<string> {
    const uniqueIds = [...new Set(awemeIds.filter(Boolean))];
    if (uniqueIds.length === 0) return new Set();
    const placeholders = uniqueIds.map(() => "?").join(",");
    const rows = this.db.prepare(`
      SELECT aweme_id FROM favorite_videos
      WHERE aweme_id IN (${placeholders})
    `).all(...uniqueIds) as Array<{ aweme_id: string }>;
    return new Set(rows.map((row) => String(row.aweme_id)));
  }

  listFavoriteVideos(page: number, pageSize = 50): PaginatedFavorites {
    const total = (this.db.prepare(`SELECT COUNT(*) AS total FROM favorite_videos`).get() as { total: number }).total;
    const rows = this.db.prepare(`
      SELECT * FROM favorite_videos
      ORDER BY discovered_at DESC, aweme_id DESC LIMIT ? OFFSET ?
    `).all(pageSize, (page - 1) * pageSize) as Record<string, unknown>[];
    return {
      items: rows.map(mapFavoriteVideo),
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  upsertDiscoveredFavorite(input: {
    awemeId: string;
    title: string;
    author: string;
    sourceUrl: string;
    publishedAt: string | null;
    publishedAtSource: "aweme_id" | "media" | "unknown";
  }): FavoriteVideoRecord {
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO favorite_videos(
        aweme_id, title, author, source_url, published_at, published_at_source,
        status, discovered_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'discovered', ?, ?)
      ON CONFLICT(aweme_id) DO UPDATE SET
        title=CASE WHEN favorite_videos.title='' THEN excluded.title ELSE favorite_videos.title END,
        author=CASE WHEN excluded.author<>'' THEN excluded.author ELSE favorite_videos.author END,
        source_url=excluded.source_url,
        published_at=COALESCE(favorite_videos.published_at, excluded.published_at),
        published_at_source=CASE WHEN favorite_videos.published_at IS NULL THEN excluded.published_at_source ELSE favorite_videos.published_at_source END,
        updated_at=excluded.updated_at
    `).run(
      input.awemeId,
      input.title,
      input.author,
      input.sourceUrl,
      input.publishedAt,
      input.publishedAtSource,
      now,
      now,
    );
    return this.getFavoriteVideo(input.awemeId)!;
  }

  updateFavoriteVideo(awemeId: string, fields: Partial<{
    title: string;
    author: string;
    publishedAt: string | null;
    publishedAtSource: "aweme_id" | "media" | "unknown";
    status: VideoStatus;
    failureCategory: string | null;
    failureReason: string | null;
    markdownPath: string | null;
    mediaPath: string | null;
    completedAt: string | null;
  }>, incrementAttempts = false): void {
    const columns: Record<string, string> = {
      title: "title",
      author: "author",
      publishedAt: "published_at",
      publishedAtSource: "published_at_source",
      status: "status",
      failureCategory: "failure_category",
      failureReason: "failure_reason",
      markdownPath: "markdown_path",
      mediaPath: "media_path",
      completedAt: "completed_at",
    };
    const entries = Object.entries(fields);
    const sets = entries.map(([key]) => `${columns[key]}=?`);
    const values = entries.map(([, value]) => value as SqlValue);
    if (incrementAttempts) sets.push("attempts=attempts+1");
    sets.push("updated_at=?");
    values.push(nowIso(), awemeId);
    this.db.prepare(`UPDATE favorite_videos SET ${sets.join(", ")} WHERE aweme_id=?`).run(...values);
  }

  claimNextJob(): CrawlJob | null {
    return this.db.transaction(() => {
      const row = this.db.prepare(`SELECT id FROM crawl_jobs WHERE status = 'queued' ORDER BY id LIMIT 1`).get() as { id: number } | undefined;
      if (!row) return null;
      const now = nowIso();
      this.db.prepare(`
        UPDATE crawl_jobs SET status = 'running', stage = 'discovering',
          started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ? AND status = 'queued'
      `).run(now, now, row.id);
      return this.getJob(row.id);
    })();
  }

  getJob(id: number): CrawlJob | null {
    const row = this.db.prepare(`
      ${JOB_WITH_STATS_SELECT} WHERE j.id = ?
    `).get(id) as Record<string, unknown> | undefined;
    return row ? mapJob(row) : null;
  }

  listJobs(page: number, pageSize = 5): PaginatedJobs {
    const total = (this.db.prepare(`SELECT COUNT(*) AS total FROM crawl_jobs`).get() as { total: number }).total;
    const rows = this.db.prepare(`
      ${JOB_WITH_STATS_SELECT} ORDER BY j.id DESC LIMIT ? OFFSET ?
    `).all(pageSize, (page - 1) * pageSize) as Record<string, unknown>[];
    return {
      items: rows.map(mapJob), page, pageSize, total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  deleteJob(id: number): boolean {
    return this.db.prepare(`
      DELETE FROM crawl_jobs
      WHERE id = ? AND status IN ('completed','completed_partial','cancelled','failed')
    `).run(id).changes > 0;
  }

  clearJobLogs(): ClearJobLogsResult | null {
    return this.db.transaction(() => {
      const active = this.db.prepare(`
        SELECT 1 FROM crawl_jobs
        WHERE status IN ('running','waiting_verification')
        LIMIT 1
      `).get();
      if (active) return null;
      const result = this.db.prepare(`DELETE FROM job_logs`).run();
      return { deletedLogs: result.changes };
    })();
  }

  clearTerminalJobs(): ClearTerminalJobsResult {
    return this.db.transaction(() => {
      const result = this.db.prepare(`
        DELETE FROM crawl_jobs
        WHERE status IN ('completed','completed_partial','cancelled','failed')
      `).run();
      return { deletedJobs: result.changes };
    })();
  }

  getDashboard(): Omit<DashboardSnapshot, "debugBrowser" | "downloadProgress"> {
    const active = this.db.prepare(`
      ${JOB_WITH_STATS_SELECT}
      WHERE j.status IN ('running','waiting_verification') ORDER BY j.id LIMIT 1
    `).get() as Record<string, unknown> | undefined;
    const queued = this.db.prepare(`
      ${JOB_WITH_STATS_SELECT} WHERE j.status = 'queued' ORDER BY j.id LIMIT 20
    `).all() as Record<string, unknown>[];
    const recent = this.db.prepare(`
      ${JOB_WITH_STATS_SELECT}
      WHERE j.status IN ('completed','completed_partial','cancelled','failed')
      ORDER BY j.updated_at DESC LIMIT 5
    `).all() as Record<string, unknown>[];
    const logJobId = active ? Number(active.id) : recent[0] ? Number(recent[0].id) : null;
    return {
      activeJob: active ? mapJob(active) : null,
      queuedJobs: queued.map(mapJob),
      recentJobs: recent.map(mapJob),
      logJobId,
      jobLogs: logJobId === null ? [] : this.listJobLogs(logJobId),
      favoriteListener: this.getFavoriteListenerState(),
    };
  }

  updateJob(id: number, fields: Partial<{
    creatorNickname: string | null;
    status: JobStatus;
    stage: JobStage;
    currentAwemeId: string | null;
    errorCategory: string | null;
    errorMessage: string | null;
    finishedAt: string | null;
    cancelRequested: boolean;
  }>): void {
    const columns: Record<string, string> = {
      creatorNickname: "creator_nickname",
      status: "status",
      stage: "stage",
      currentAwemeId: "current_aweme_id",
      errorCategory: "error_category",
      errorMessage: "error_message",
      finishedAt: "finished_at",
      cancelRequested: "cancel_requested",
    };
    const entries = Object.entries(fields);
    if (!entries.length) return;
    const sets = entries.map(([key]) => `${columns[key]} = ?`);
    const values: SqlValue[] = entries.map(([key, value]) => key === "cancelRequested" ? (value ? 1 : 0) : (value as SqlValue));
    values.push(nowIso(), id);
    this.db.prepare(`UPDATE crawl_jobs SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(...values);
  }

  incrementDiscoveredCount(id: number, amount = 1): void {
    this.db.prepare(`
      UPDATE crawl_jobs SET discovered_count = discovered_count + ?, updated_at = ? WHERE id = ?
    `).run(amount, nowIso(), id);
  }

  cancelJob(id: number): CrawlJob | null {
    const job = this.getJob(id);
    if (!job) return null;
    const now = nowIso();
    if (job.status === "queued") {
      this.db.prepare(`UPDATE crawl_jobs SET status='cancelled', finished_at=?, updated_at=? WHERE id=?`).run(now, now, id);
    } else if (job.status === "running" || job.status === "waiting_verification") {
      this.db.prepare(`UPDATE crawl_jobs SET cancel_requested=1, updated_at=? WHERE id=?`).run(now, id);
    }
    return this.getJob(id);
  }

  resumeJob(id: number): CrawlJob | null {
    this.db.prepare(`
      UPDATE crawl_jobs SET status='running', stage='discovering', error_category=NULL,
        error_message=NULL, updated_at=? WHERE id=? AND status='waiting_verification'
    `).run(nowIso(), id);
    return this.getJob(id);
  }

  isCancelRequested(id: number): boolean {
    const row = this.db.prepare(`SELECT cancel_requested FROM crawl_jobs WHERE id=?`).get(id) as { cancel_requested: number } | undefined;
    return row?.cancel_requested === 1;
  }

  upsertCreator(secUid: string, profileUrl: string, nickname: string, displayedPostCount: number | null): void {
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO creators (sec_uid, profile_url, nickname, displayed_post_count, first_seen_at, last_crawled_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sec_uid) DO UPDATE SET profile_url=excluded.profile_url,
        nickname=CASE WHEN excluded.nickname <> '' THEN excluded.nickname ELSE creators.nickname END,
        displayed_post_count=excluded.displayed_post_count,
        last_crawled_at=excluded.last_crawled_at, updated_at=excluded.updated_at
    `).run(secUid, profileUrl, nickname, displayedPostCount, now, now, now);
  }

  listCreators(): Creator[] {
    const rows = this.db.prepare(`
      SELECT c.*, COUNT(CASE WHEN v.status='completed' THEN 1 END) AS completed_count
      FROM creators c LEFT JOIN videos v ON v.sec_uid=c.sec_uid
      GROUP BY c.sec_uid ORDER BY c.last_crawled_at DESC, c.nickname
    `).all() as Record<string, unknown>[];
    return rows.map(mapCreator);
  }

  getCreator(secUid: string): Creator | null {
    const row = this.db.prepare(`
      SELECT c.*, COUNT(CASE WHEN v.status='completed' THEN 1 END) AS completed_count
      FROM creators c LEFT JOIN videos v ON v.sec_uid=c.sec_uid WHERE c.sec_uid=? GROUP BY c.sec_uid
    `).get(secUid) as Record<string, unknown> | undefined;
    return row ? mapCreator(row) : null;
  }

  hasPendingJobForCreator(secUid: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 FROM crawl_jobs
      WHERE sec_uid=? AND status IN ('queued','running','waiting_verification')
      LIMIT 1
    `).get(secUid);
    return Boolean(row);
  }

  deleteCreator(secUid: string): number {
    return this.db.transaction(() => {
      const row = this.db.prepare(`SELECT COUNT(*) AS total FROM videos WHERE sec_uid=?`).get(secUid) as { total: number };
      const result = this.db.prepare(`DELETE FROM creators WHERE sec_uid=?`).run(secUid);
      return result.changes ? Number(row.total) : 0;
    })();
  }

  upsertDiscoveredVideo(input: {
    awemeId: string; secUid: string; title: string; author: string; sourceUrl: string;
    publishedAt: string | null; publishedAtSource: "aweme_id" | "media" | "unknown";
  }): VideoRecord {
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO videos (
        aweme_id, sec_uid, title, author, source_url, published_at, published_at_source,
        status, discovered_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'discovered', ?, ?)
      ON CONFLICT(aweme_id) DO UPDATE SET
        title=CASE WHEN videos.title='' THEN excluded.title ELSE videos.title END,
        author=CASE WHEN excluded.author<>'' THEN excluded.author ELSE videos.author END,
        source_url=excluded.source_url,
        published_at=COALESCE(videos.published_at, excluded.published_at),
        published_at_source=CASE WHEN videos.published_at IS NULL THEN excluded.published_at_source ELSE videos.published_at_source END,
        updated_at=excluded.updated_at
    `).run(
      input.awemeId, input.secUid, input.title, input.author, input.sourceUrl,
      input.publishedAt, input.publishedAtSource, now, now,
    );
    return this.getVideo(input.awemeId)!;
  }

  getVideo(awemeId: string): VideoRecord | null {
    const row = this.db.prepare(`SELECT * FROM videos WHERE aweme_id=?`).get(awemeId) as Record<string, unknown> | undefined;
    return row ? mapVideo(row) : null;
  }

  deleteVideo(awemeId: string): boolean {
    return this.db.prepare(`DELETE FROM videos WHERE aweme_id=?`).run(awemeId).changes > 0;
  }

  updateVideo(awemeId: string, fields: Partial<{
    title: string; author: string; publishedAt: string | null;
    publishedAtSource: "aweme_id" | "media" | "unknown"; status: VideoStatus;
    failureCategory: string | null; failureReason: string | null;
    markdownPath: string | null; mediaPath: string | null; completedAt: string | null;
  }>, incrementAttempts = false): void {
    const columns: Record<string, string> = {
      title: "title", author: "author", publishedAt: "published_at",
      publishedAtSource: "published_at_source", status: "status",
      failureCategory: "failure_category", failureReason: "failure_reason",
      markdownPath: "markdown_path", mediaPath: "media_path", completedAt: "completed_at",
    };
    const entries = Object.entries(fields);
    const sets = entries.map(([key]) => `${columns[key]}=?`);
    const values = entries.map(([, value]) => value as SqlValue);
    if (incrementAttempts) sets.push("attempts=attempts+1");
    sets.push("updated_at=?");
    values.push(nowIso(), awemeId);
    this.db.prepare(`UPDATE videos SET ${sets.join(", ")} WHERE aweme_id=?`).run(...values);
  }

  listVideos(secUid: string, page: number, pageSize = 50): PaginatedVideos {
    const total = (this.db.prepare(`SELECT COUNT(*) AS total FROM videos WHERE sec_uid=?`).get(secUid) as { total: number }).total;
    const rows = this.db.prepare(`
      SELECT * FROM videos WHERE sec_uid=?
      ORDER BY published_at IS NULL, published_at DESC, aweme_id DESC LIMIT ? OFFSET ?
    `).all(secUid, pageSize, (page - 1) * pageSize) as Record<string, unknown>[];
    return {
      items: rows.map(mapVideo), page, pageSize, total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  completeVideoForJob(input: {
    jobId: number;
    awemeId: string;
    source: "creator" | "favorite";
    markdownPath: string;
    mediaPath: string | null;
    completedAt: string;
  }): void {
    this.db.transaction(() => {
      const table = input.source === "favorite" ? "favorite_videos" : "videos";
      const result = this.db.prepare(`
        UPDATE ${table}
        SET status='completed', markdown_path=?, media_path=?,
            failure_category=NULL, failure_reason=NULL, completed_at=?, updated_at=?
        WHERE aweme_id=?
      `).run(
        input.markdownPath,
        input.mediaPath,
        input.completedAt,
        nowIso(),
        input.awemeId,
      );
      if (result.changes !== 1) {
        throw new Error(`Cannot complete missing ${input.source} video ${input.awemeId}`);
      }
      this.recordJobVideo(input.jobId, input.awemeId, "completed");
    })();
  }

  failVideoForJob(input: {
    jobId: number;
    awemeId: string;
    source: "creator" | "favorite";
    errorCategory: string;
    errorMessage: string;
  }): void {
    this.db.transaction(() => {
      const table = input.source === "favorite" ? "favorite_videos" : "videos";
      const result = this.db.prepare(`
        UPDATE ${table}
        SET status='failed', failure_category=?, failure_reason=?, updated_at=?
        WHERE aweme_id=?
      `).run(input.errorCategory, input.errorMessage, nowIso(), input.awemeId);
      if (result.changes !== 1) {
        throw new Error(`Cannot fail missing ${input.source} video ${input.awemeId}`);
      }
      this.recordJobVideo(input.jobId, input.awemeId, "failed", input.errorCategory);
    })();
  }

  recordJobVideo(jobId: number, awemeId: string, outcome: "completed" | "skipped" | "failed", errorCategory: string | null = null): void {
    this.db.prepare(`
      INSERT INTO job_videos(job_id, aweme_id, outcome, error_category, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(job_id, aweme_id) DO UPDATE SET outcome=excluded.outcome, error_category=excluded.error_category
    `).run(jobId, awemeId, outcome, errorCategory, nowIso());
  }

  listJobVideoIds(jobId: number): string[] {
    const rows = this.db.prepare(`SELECT aweme_id FROM job_videos WHERE job_id=? ORDER BY created_at, aweme_id`).all(jobId) as Array<{ aweme_id: string }>;
    return rows.map((row) => String(row.aweme_id));
  }

  addJobLog(input: {
    jobId: number;
    awemeId?: string | null;
    level: JobLogLevel;
    stage: JobLogStage;
    message: string;
  }): JobLog {
    return this.db.transaction(() => {
      const result = this.db.prepare(`
        INSERT INTO job_logs(job_id, aweme_id, level, stage, message, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        input.jobId,
        input.awemeId?.slice(0, 128) || null,
        input.level,
        input.stage,
        input.message.slice(0, 1_000),
        nowIso(),
      );
      this.db.prepare(`
        DELETE FROM job_logs
        WHERE job_id = ? AND id NOT IN (
          SELECT id FROM job_logs WHERE job_id = ? ORDER BY id DESC LIMIT 300
        )
      `).run(input.jobId, input.jobId);
      const row = this.db.prepare(`SELECT * FROM job_logs WHERE id=?`).get(result.lastInsertRowid) as Record<string, unknown>;
      return mapJobLog(row);
    })();
  }

  updateJobLogMessage(jobId: number, logId: number, message: string): JobLog | null {
    const result = this.db.prepare(`
      UPDATE job_logs SET message=? WHERE job_id=? AND id=?
    `).run(message.slice(0, 1_000), jobId, logId);
    if (result.changes === 0) return null;
    const row = this.db.prepare(`
      SELECT * FROM job_logs WHERE job_id=? AND id=?
    `).get(jobId, logId) as Record<string, unknown> | undefined;
    return row ? mapJobLog(row) : null;
  }

  listJobLogs(jobId: number): JobLog[] {
    const rows = this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM job_logs WHERE job_id=? ORDER BY id DESC LIMIT 300
      ) ORDER BY id
    `).all(jobId) as Record<string, unknown>[];
    return rows.map(mapJobLog);
  }
}

function mapJob(row: Record<string, unknown>): CrawlJob {
  const base = {
    id: Number(row.id),
    targetCount: Number(row.target_count), retryPermanent: Boolean(row.retry_permanent),
    status: row.status as JobStatus, stage: row.stage as JobStage,
    discoveredCount: Number(row.discovered_count), duplicateCount: Number(row.duplicate_count),
    completedCount: Number(row.completed_count), failedCount: Number(row.failed_count),
    processedCount: Number(row.completed_count) + Number(row.failed_count),
    currentAwemeId: row.current_aweme_id ? String(row.current_aweme_id) : null,
    errorCategory: row.error_category ? String(row.error_category) : null,
    errorMessage: row.error_message ? String(row.error_message) : null,
    cancelRequested: Boolean(row.cancel_requested), createdAt: String(row.created_at),
    startedAt: row.started_at ? String(row.started_at) : null,
    finishedAt: row.finished_at ? String(row.finished_at) : null, updatedAt: String(row.updated_at),
  };
  if (row.mode === "favorite") {
    return {
      ...base,
      mode: "favorite",
      sourceAwemeId: String(row.source_aweme_id),
      profileUrl: null,
      secUid: null,
      creatorNickname: null,
    };
  }
  return {
    ...base,
    mode: "creator",
    sourceAwemeId: null,
    profileUrl: String(row.profile_url),
    secUid: String(row.sec_uid),
    creatorNickname: row.creator_nickname ? String(row.creator_nickname) : null,
  };
}

function mapFavoriteListener(row: Record<string, unknown>): FavoriteListenerState {
  return {
    enabled: Boolean(row.enabled),
    status: row.status as FavoriteListenerState["status"],
    baselineAwemeId: row.baseline_aweme_id ? String(row.baseline_aweme_id) : null,
    cursorAwemeId: row.cursor_aweme_id ? String(row.cursor_aweme_id) : null,
    lastCheckedAt: row.last_checked_at ? String(row.last_checked_at) : null,
    errorCategory: row.error_category ? String(row.error_category) : null,
    errorMessage: row.error_message ? String(row.error_message) : null,
    updatedAt: String(row.updated_at),
  };
}

function mapFavoriteVideo(row: Record<string, unknown>): FavoriteVideoRecord {
  return mapBaseVideo(row);
}

function mapBaseVideo(row: Record<string, unknown>): FavoriteVideoRecord {
  return {
    awemeId: String(row.aweme_id),
    title: String(row.title),
    author: String(row.author),
    sourceUrl: String(row.source_url),
    publishedAt: row.published_at ? String(row.published_at) : null,
    publishedAtSource: row.published_at_source as FavoriteVideoRecord["publishedAtSource"],
    status: row.status as VideoStatus,
    failureCategory: row.failure_category ? String(row.failure_category) : null,
    failureReason: row.failure_reason ? String(row.failure_reason) : null,
    attempts: Number(row.attempts),
    markdownPath: row.markdown_path ? String(row.markdown_path) : null,
    mediaPath: row.media_path ? String(row.media_path) : null,
    feishuSynced: Boolean(row.feishu_synced),
    discoveredAt: String(row.discovered_at),
    updatedAt: String(row.updated_at),
    completedAt: row.completed_at ? String(row.completed_at) : null,
  };
}

function mapCreator(row: Record<string, unknown>): Creator {
  return {
    secUid: String(row.sec_uid), profileUrl: String(row.profile_url), nickname: String(row.nickname),
    displayedPostCount: row.displayed_post_count == null ? null : Number(row.displayed_post_count),
    completedCount: Number(row.completed_count), firstSeenAt: String(row.first_seen_at),
    lastCrawledAt: row.last_crawled_at ? String(row.last_crawled_at) : null,
    updatedAt: String(row.updated_at),
  };
}

function mapVideo(row: Record<string, unknown>): VideoRecord {
  return {
    ...mapBaseVideo(row),
    secUid: String(row.sec_uid),
  };
}

function mapJobLog(row: Record<string, unknown>): JobLog {
  return {
    id: Number(row.id),
    jobId: Number(row.job_id),
    awemeId: row.aweme_id ? String(row.aweme_id) : null,
    level: row.level as JobLogLevel,
    stage: row.stage as JobLogStage,
    message: String(row.message),
    createdAt: String(row.created_at),
  };
}

function mapFeishuSync(row: Record<string, unknown>): FeishuSyncRecord {
  return {
    awemeId: String(row.aweme_id),
    spaceId: String(row.space_id),
    nodeToken: String(row.node_token),
    documentId: String(row.document_id),
    status: row.status as FeishuSyncStatus,
    writtenBlocks: Number(row.written_blocks),
    lastError: row.last_error ? String(row.last_error) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
