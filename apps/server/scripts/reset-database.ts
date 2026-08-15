import Database from "better-sqlite3";
import { mkdir, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { DATA_DIR, DATABASE_PATH, PROJECT_ROOT } from "../src/config.js";
import { DyCollectDatabase } from "../src/db.js";

const confirmed = process.argv.includes("--yes");

if (!confirmed) {
  console.error("此操作会永久清空整个 data 目录，包括数据库、Markdown 和媒体文件。");
  console.error("确认后请运行：npm run reset:database -- --yes");
  process.exitCode = 1;
} else {
  await resetDatabase();
}

async function resetDatabase(): Promise<void> {
  assertSafeDataDirectory();

  await rm(DATA_DIR, { recursive: true, force: true });
  await mkdir(DATA_DIR, { recursive: true });
  const database = new DyCollectDatabase(DATABASE_PATH);
  database.close();

  const verification = new Database(DATABASE_PATH, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const nonEmptyTables = (
      verification.prepare(`
        SELECT name
        FROM sqlite_master
        WHERE type='table'
          AND name NOT LIKE 'sqlite_%'
          AND name <> 'favorite_listener'
        ORDER BY name
      `).all() as Array<{ name: string }>
    ).filter(({ name }) => {
      const row = verification.prepare(`SELECT COUNT(*) AS total FROM "${name}"`).get() as {
        total: number;
      };
      return row.total !== 0;
    });
    const listener = verification.prepare(`
      SELECT enabled, status FROM favorite_listener WHERE id=1
    `).get() as { enabled: number; status: string } | undefined;
    const integrity = verification.pragma("integrity_check", { simple: true });
    const foreignKeyViolations = verification.pragma("foreign_key_check") as unknown[];

    if (
      nonEmptyTables.length > 0
      || listener?.enabled !== 0
      || listener.status !== "stopped"
      || integrity !== "ok"
      || foreignKeyViolations.length > 0
    ) {
      throw new Error("数据库重置后的完整性验证失败");
    }
  } finally {
    verification.close();
  }

  console.log(`数据库已重置：${DATABASE_PATH}`);
  console.log("人物、作品、收藏、任务、日志、飞书配置和同步映射均为空。");
  console.log("data 目录中的 Markdown、媒体文件和临时文件均已删除。");
}

function assertSafeDataDirectory(): void {
  const relativeDataPath = relative(PROJECT_ROOT, DATA_DIR);
  if (
    !relativeDataPath
    || relativeDataPath.startsWith("..")
    || isAbsolute(relativeDataPath)
    || DATA_DIR !== resolve(PROJECT_ROOT, relativeDataPath)
    || DATABASE_PATH !== resolve(DATA_DIR, "archive.sqlite3")
  ) {
    throw new Error(`拒绝重置非预期数据目录：${DATA_DIR}`);
  }
}
