// src/runner/history-store.ts

/** One row of applied-migration history. */
export interface AppliedRow {
  version: string;
  name: string;
  checksum: string;
  appliedAt: string;   // ISO 8601
  executionMs: number;
  success: boolean;    // false = a failed (dirty) apply
}

/**
 * Pluggable migration-history tracking. The override point that makes multi-app /
 * multi-tenant possible: a per-tenant store instance (its own schema/table/lock)
 * gives each app an independent lineage in one physical database.
 */
export interface HistoryStore {
  ensure(): Promise<void>;
  applied(): Promise<AppliedRow[]>;            // ordered by version ASC
  record(row: AppliedRow): Promise<void>;      // upsert by version
  unrecord(version: string): Promise<void>;
  acquireLock(): Promise<void>;
  releaseLock(): Promise<void>;
}

/** In-memory store for unit-testing the apply/rollback loop without a database. */
export class InMemoryHistoryStore implements HistoryStore {
  private rows: AppliedRow[] = [];
  private locked = false;
  async ensure(): Promise<void> {}
  async applied(): Promise<AppliedRow[]> {
    return [...this.rows].sort((a, b) => a.version.localeCompare(b.version));
  }
  async record(row: AppliedRow): Promise<void> {
    this.rows = this.rows.filter((r) => r.version !== row.version);
    this.rows.push(row);
  }
  async unrecord(version: string): Promise<void> {
    this.rows = this.rows.filter((r) => r.version !== version);
  }
  async acquireLock(): Promise<void> {
    if (this.locked) throw new Error("InMemoryHistoryStore: already locked");
    this.locked = true;
  }
  async releaseLock(): Promise<void> {
    this.locked = false;
  }
}
