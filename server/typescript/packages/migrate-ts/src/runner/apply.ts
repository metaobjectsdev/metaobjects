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
