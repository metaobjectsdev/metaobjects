// src/runner/migration-source.ts
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface Migration {
  /** Leading 14-digit timestamp from the dir name; the sortable version. */
  version: string;
  /** Slug after the timestamp. */
  name: string;
  /** Absolute path to the migration directory. */
  dir: string;
  upSql: string;
  /** Empty string when no down.sql exists. */
  downSql: string;
}

/** Load timestamped append-only migration dirs (`<14-digits>-<slug>/up.sql`). */
export async function loadMigrations(dir: string): Promise<Migration[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const migs: Migration[] = [];
  for (const entry of entries) {
    const m = /^(\d{14})-(.+)$/.exec(entry);
    if (!m) continue;
    const migDir = join(dir, entry);
    const upSql = await readFile(join(migDir, "up.sql"), "utf8");
    let downSql = "";
    try {
      downSql = await readFile(join(migDir, "down.sql"), "utf8");
    } catch {
      /* down.sql optional */
    }
    migs.push({ version: m[1], name: m[2], dir: migDir, upSql, downSql });
  }
  return migs.sort((a, b) => a.version.localeCompare(b.version));
}
