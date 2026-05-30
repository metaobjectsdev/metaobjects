// src/runner/apply.ts
import { contentChecksum } from "./checksum.js";
import type { HistoryStore } from "./history-store.js";
import type { Migration } from "./migration-source.js";

/** Executes one migration's SQL in its own transaction; throws on error. */
export interface SqlExecutor {
  runInTransaction(sql: string): Promise<void>;
}

export interface ApplyResult {
  applied: string[];   // versions applied this run (or would-apply, for dryRun)
  skipped: string[];   // versions already applied
}

/** Versions already applied successfully. */
function appliedVersionSet(rows: { version: string; success: boolean }[]): Set<string> {
  return new Set(rows.filter((r) => r.success).map((r) => r.version));
}

export async function applyMigrations(
  migrations: Migration[],
  store: HistoryStore,
  executor: SqlExecutor,
  opts: { dryRun?: boolean } = {},
): Promise<ApplyResult> {
  await store.acquireLock();
  try {
    await store.ensure();
    const done = appliedVersionSet(await store.applied());
    const pending = migrations.filter((m) => !done.has(m.version));
    const result: ApplyResult = { applied: [], skipped: [...done] };
    for (const m of pending) {
      if (opts.dryRun) {
        result.applied.push(m.version);
        continue;
      }
      const start = Date.now();
      try {
        await executor.runInTransaction(m.upSql);
      } catch (e) {
        await store.record(failRow(m, start));
        throw e;
      }
      await store.record(successRow(m, start));
      result.applied.push(m.version);
    }
    return result;
  } finally {
    await store.releaseLock();
  }
}

function successRow(m: Migration, start: number) {
  return { version: m.version, name: m.name, checksum: contentChecksum(m.upSql), appliedAt: new Date().toISOString(), executionMs: Date.now() - start, success: true };
}
function failRow(m: Migration, start: number) {
  return { ...successRow(m, start), success: false };
}

export interface RollbackResult {
  rolledBack: string[];   // versions rolled back, in the order applied (reverse-chronological)
}

/**
 * Roll back every applied migration newer than `targetVersion` (or all, when
 * `targetVersion` is null), in reverse order, running each `down.sql` then
 * unrecording it. A migration's schema `down` is generated; a data migration's
 * `down` must be hand-authored — an empty `down.sql` throws rather than silently
 * skipping.
 */
export async function rollbackTo(
  targetVersion: string | null,
  migrations: Migration[],
  store: HistoryStore,
  executor: SqlExecutor,
): Promise<RollbackResult> {
  await store.acquireLock();
  try {
    const applied = (await store.applied()).filter((r) => r.success);
    const toRollback = applied
      .filter((r) => targetVersion === null || r.version > targetVersion)
      .sort((a, b) => b.version.localeCompare(a.version));
    const byVersion = new Map(migrations.map((m) => [m.version, m]));
    const rolledBack: string[] = [];
    for (const r of toRollback) {
      const m = byVersion.get(r.version);
      if (!m) throw new Error(`rollback ${r.version}: migration files missing`);
      if (!m.downSql.trim()) throw new Error(`rollback ${r.version}: down.sql is empty (data migrations need a hand-authored down)`);
      await executor.runInTransaction(m.downSql);
      await store.unrecord(r.version);
      rolledBack.push(r.version);
    }
    return { rolledBack };
  } finally {
    await store.releaseLock();
  }
}
