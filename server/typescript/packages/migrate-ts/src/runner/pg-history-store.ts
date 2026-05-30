// src/runner/pg-history-store.ts
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { AppliedRow, HistoryStore } from "./history-store.js";

export interface PgHistoryStoreOptions {
  /** Schema holding the history table + (by default) the lock scope. Default "public". */
  schema?: string;
  /** History table name. Default "metaobjects_migrations". */
  table?: string;
  /** Advisory-lock name. Default `${schema}.${table}`. Override to share/separate lock scope. */
  lockName?: string;
}

/**
 * Postgres history store. Per-tenant isolation = a per-tenant instance with its own
 * {schema, table, lockName} — independent lineage + lock scope in one physical DB.
 */
export class PgHistoryStore implements HistoryStore {
  private readonly schema: string;
  private readonly table: string;
  private readonly lockKey: string; // 64-bit signed, as a decimal string for $1::bigint
  private lockClient: PoolClient | null = null;

  constructor(private readonly pool: Pool, opts: PgHistoryStoreOptions = {}) {
    this.schema = opts.schema ?? "public";
    this.table = opts.table ?? "metaobjects_migrations";
    this.lockKey = advisoryKey(opts.lockName ?? `${this.schema}.${this.table}`);
  }

  private q(): string {
    return `"${this.schema}"."${this.table}"`;
  }

  async ensure(): Promise<void> {
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS "${this.schema}"`);
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS ${this.q()} (
         version TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         checksum TEXT NOT NULL,
         applied_at TIMESTAMPTZ NOT NULL,
         execution_ms INTEGER NOT NULL,
         success BOOLEAN NOT NULL
       )`,
    );
  }

  async applied(): Promise<AppliedRow[]> {
    const r = await this.pool.query(
      `SELECT version, name, checksum, applied_at, execution_ms, success
         FROM ${this.q()} ORDER BY version ASC`,
    );
    return r.rows.map((row: Record<string, unknown>) => ({
      version: String(row["version"]),
      name: String(row["name"]),
      checksum: String(row["checksum"]),
      appliedAt: new Date(row["applied_at"] as string).toISOString(),
      executionMs: Number(row["execution_ms"]),
      success: Boolean(row["success"]),
    }));
  }

  async record(row: AppliedRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.q()} (version, name, checksum, applied_at, execution_ms, success)
         VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (version) DO UPDATE SET
         name = EXCLUDED.name, checksum = EXCLUDED.checksum,
         applied_at = EXCLUDED.applied_at, execution_ms = EXCLUDED.execution_ms,
         success = EXCLUDED.success`,
      [row.version, row.name, row.checksum, row.appliedAt, row.executionMs, row.success],
    );
  }

  async unrecord(version: string): Promise<void> {
    await this.pool.query(`DELETE FROM ${this.q()} WHERE version = $1`, [version]);
  }

  async acquireLock(): Promise<void> {
    this.lockClient = await this.pool.connect();
    // Session-level advisory lock (not transaction-level) so CREATE INDEX
    // CONCURRENTLY in a migration does not deadlock against the lock.
    await this.lockClient.query("SELECT pg_advisory_lock($1::bigint)", [this.lockKey]);
  }

  async releaseLock(): Promise<void> {
    if (!this.lockClient) return;
    try {
      await this.lockClient.query("SELECT pg_advisory_unlock($1::bigint)", [this.lockKey]);
    } finally {
      this.lockClient.release();
      this.lockClient = null;
    }
  }
}

/** Stable 64-bit signed advisory-lock key (decimal string) from a lock name. */
function advisoryKey(name: string): string {
  const hash = createHash("sha256").update(name).digest();
  return hash.readBigInt64BE(0).toString();
}
