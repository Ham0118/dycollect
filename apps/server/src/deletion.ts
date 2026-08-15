import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type {
  DeleteCreatorResult,
  DeleteFavoriteVideoResult,
  DeleteVideoResult,
  FavoriteVideoRecord,
  VideoRecord,
} from "@dycollect/shared";
import { DATA_DIR } from "./config.js";
import { DyCollectDatabase } from "./db.js";
import { AppError } from "./errors.js";
import { resolveWithin } from "./utils.js";

interface StagedFile {
  source: string;
  staged: string;
}

export class DeletionService {
  private readonly trashRoot: string;

  constructor(
    private readonly database: DyCollectDatabase,
    private readonly dataRoot = DATA_DIR,
  ) {
    this.trashRoot = resolve(dataRoot, ".trash");
  }

  async cleanupTrash(): Promise<void> {
    await rm(this.trashRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  async deleteCreator(secUid: string): Promise<DeleteCreatorResult> {
    const creator = this.database.getCreator(secUid);
    if (!creator) throw new AppError("parse_error", "人物不存在");

    const creatorDirectory = resolveWithin(this.dataRoot, secUid);
    if (!creatorDirectory || creatorDirectory === this.dataRoot) {
      throw new AppError("database_error", "人物数据目录无效，已停止删除");
    }

    const stageDirectory = resolve(this.trashRoot, `creator-${randomUUID()}`);
    let stagedFiles: StagedFile[] = [];
    try {
      const files = this.creatorFiles(creatorDirectory);
      stagedFiles = this.stageFiles(files, stageDirectory);
      const deletedVideos = this.database.deleteCreator(secUid);
      if (!this.database.getCreator(secUid) && creator) {
        await Promise.all([
          this.purge(stageDirectory, stagedFiles.length > 0),
          this.removeCreatorDirectory(creatorDirectory),
        ]);
        return { deleted: true, secUid, deletedVideos };
      }
      throw new AppError("database_error", "人物记录删除失败");
    } catch (error) {
      this.restoreFiles(stagedFiles);
      throw error;
    }
  }

  async deleteVideo(video: VideoRecord): Promise<DeleteVideoResult> {
    const stageDirectory = resolve(this.trashRoot, `video-${randomUUID()}`);
    let stagedFiles: StagedFile[] = [];
    try {
      const files = this.videoFiles(video);
      stagedFiles = this.stageFiles(files, stageDirectory);
      if (!this.database.deleteVideo(video.awemeId)) {
        throw new AppError("database_error", "作品记录删除失败");
      }
      await this.purge(stageDirectory, files.length > 0);
      return { deleted: true, awemeId: video.awemeId, secUid: video.secUid };
    } catch (error) {
      this.restoreFiles(stagedFiles);
      throw error;
    }
  }

  async deleteFavoriteVideo(video: FavoriteVideoRecord): Promise<DeleteFavoriteVideoResult> {
    const stageDirectory = resolve(this.trashRoot, `favorite-${randomUUID()}`);
    let stagedFiles: StagedFile[] = [];
    try {
      const files = this.favoriteVideoFiles(video);
      stagedFiles = this.stageFiles(files, stageDirectory);
      if (!this.database.deleteFavoriteVideo(video.awemeId)) {
        throw new AppError("database_error", "收藏作品记录删除失败");
      }
      await this.purge(stageDirectory, files.length > 0);
      return { deleted: true, awemeId: video.awemeId };
    } catch (error) {
      this.restoreFiles(stagedFiles);
      throw error;
    }
  }

  private creatorFiles(creatorDirectory: string): string[] {
    if (!existsSync(creatorDirectory)) return [];
    const files: string[] = [];
    const directories = [creatorDirectory];
    while (directories.length) {
      const directory = directories.pop()!;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const candidate = resolveWithin(creatorDirectory, resolve(directory, entry.name));
        if (!candidate) {
          throw new AppError("database_error", "人物文件路径超出受控目录，已停止删除");
        }
        if (entry.isSymbolicLink()) {
          throw new AppError("database_error", "人物目录包含不受支持的链接，已停止删除");
        }
        if (entry.isDirectory()) directories.push(candidate);
        else if (entry.isFile()) files.push(candidate);
        else throw new AppError("database_error", "人物目录包含不受支持的文件类型，已停止删除");
      }
    }
    return files;
  }

  private stageFiles(files: string[], stageDirectory: string): StagedFile[] {
    if (!files.length) return [];
    mkdirSync(stageDirectory, { recursive: true });
    const stagedFiles: StagedFile[] = [];
    try {
      files.forEach((source, index) => {
        const staged = resolve(stageDirectory, `${index}-${basename(source)}`);
        renameSync(source, staged);
        stagedFiles.push({ source, staged });
      });
      return stagedFiles;
    } catch (error) {
      this.restoreFiles(stagedFiles);
      throw error;
    }
  }

  private videoFiles(video: VideoRecord): string[] {
    const creatorRoot = resolveWithin(this.dataRoot, video.secUid);
    if (!creatorRoot || creatorRoot === this.dataRoot) {
      throw new AppError("database_error", "人物数据目录无效，已停止删除");
    }

    const candidates = new Set<string>();
    for (const storedPath of [video.markdownPath, video.mediaPath]) {
      if (!storedPath) continue;
      const file = resolveWithin(this.dataRoot, storedPath);
      if (!file || !resolveWithin(creatorRoot, file)) {
        throw new AppError("database_error", "作品文件路径超出受控目录，已停止删除");
      }
      candidates.add(file);
    }

    const workDirectory = resolve(creatorRoot, "work");
    if (existsSync(workDirectory)) {
      const prefix = `aweme_${video.awemeId}.mp4`;
      for (const entry of readdirSync(workDirectory)) {
        if (entry === prefix || entry.startsWith(`${prefix}.tmp-`)) {
          candidates.add(resolve(workDirectory, entry));
        }
      }
    }

    return [...candidates].filter((file) => {
      if (!existsSync(file)) return false;
      if (!lstatSync(file).isFile()) {
        throw new AppError("database_error", "作品关联路径不是文件，已停止删除");
      }
      return true;
    });
  }

  private favoriteVideoFiles(video: FavoriteVideoRecord): string[] {
    const favoritesRoot = resolveWithin(this.dataRoot, "favorites");
    if (!favoritesRoot || favoritesRoot === this.dataRoot) {
      throw new AppError("database_error", "收藏数据目录无效，已停止删除");
    }

    const candidates = new Set<string>();
    for (const storedPath of [video.markdownPath, video.mediaPath]) {
      if (!storedPath) continue;
      const file = resolveWithin(this.dataRoot, storedPath);
      if (!file || !resolveWithin(favoritesRoot, file)) {
        throw new AppError("database_error", "收藏作品文件路径超出受控目录，已停止删除");
      }
      candidates.add(file);
    }

    const workDirectory = resolve(favoritesRoot, "work");
    if (existsSync(workDirectory)) {
      const prefix = `aweme_${video.awemeId}.mp4`;
      for (const entry of readdirSync(workDirectory)) {
        if (entry === prefix || entry.startsWith(`${prefix}.tmp-`)) {
          candidates.add(resolve(workDirectory, entry));
        }
      }
    }

    return [...candidates].filter((file) => {
      if (!existsSync(file)) return false;
      if (!lstatSync(file).isFile()) {
        throw new AppError("database_error", "收藏作品关联路径不是文件，已停止删除");
      }
      return true;
    });
  }

  private restoreFiles(files: StagedFile[]): void {
    for (const file of [...files].reverse()) {
      if (!existsSync(file.staged) || existsSync(file.source)) continue;
      mkdirSync(dirname(file.source), { recursive: true });
      renameSync(file.staged, file.source);
    }
  }

  private async purge(path: string, exists: boolean): Promise<void> {
    if (!exists) return;
    await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch((error) => {
      console.error(`[删除清理] 隔离文件将在下次启动时重试：${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private async removeCreatorDirectory(path: string): Promise<void> {
    if (!existsSync(path)) return;
    await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch((error) => {
      console.error(`[删除清理] 人物空目录未能移除，不影响删除结果：${error instanceof Error ? error.message : String(error)}`);
    });
  }
}
