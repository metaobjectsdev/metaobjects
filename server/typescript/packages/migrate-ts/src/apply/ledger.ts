import type { Kysely } from "kysely";

/**
 * Migration-history ledger table name. A single source of truth tracked across
 * postgres + sqlite so `meta migrate --apply` can skip already-applied files
 * (idempotency from the LEDGER, not from re-diffing).
 */
export const MIGRATIONS_TABLE = "_metaobjects_migrations";

/** A single ledger row. */
export interface LedgerRow {
  /** Migration name = the `<timestamp>-<slug>` directory name (sort key + id). */
  name: string;
  /** sha-256 of the up.sql contents at apply time (tamper guard). */
  checksum: string;
}

/**
 * Create the migration-history table if it does not already exist. Idempotent:
 * re-running is a no-op and preserves existing rows. Dialect-portable DDL
 * (TEXT columns work on both sqlite and postgres; `applied_at` is stored as
 * text so we don't depend on a dialect-specific timestamp type).
 */
export async function ensureLedger(
  db: Kysely<Record<string, unknown>>,
): Promise<void> {
  await db.schema
    .createTable(MIGRATIONS_TABLE)
    .ifNotExists()
    .addColumn("name", "text", (col) => col.primaryKey())
    .addColumn("applied_at", "text", (col) => col.notNull())
    .addColumn("checksum", "text", (col) => col.notNull())
    .execute();
}

/**
 * Record a migration as applied. Inserts a row with the current UTC timestamp.
 * Intended to run inside the SAME transaction that applied the migration SQL.
 */
export async function recordApplied(
  db: Kysely<Record<string, unknown>>,
  name: string,
  checksum: string,
): Promise<void> {
  await db
    .insertInto(MIGRATIONS_TABLE)
    .values({ name, checksum, applied_at: new Date().toISOString() })
    .execute();
}

/** Return the set of applied migration names. */
export async function appliedNames(
  db: Kysely<Record<string, unknown>>,
): Promise<Set<string>> {
  const rows = await db
    .selectFrom(MIGRATIONS_TABLE)
    .select("name")
    .execute();
  return new Set(rows.map((r) => (r as { name: string }).name));
}

/** Return a name→checksum map for all applied migrations (tamper-guard input). */
export async function appliedRecords(
  db: Kysely<Record<string, unknown>>,
): Promise<Map<string, string>> {
  const rows = await db
    .selectFrom(MIGRATIONS_TABLE)
    .select(["name", "checksum"])
    .execute();
  const map = new Map<string, string>();
  for (const r of rows) {
    const row = r as { name: string; checksum: string };
    map.set(row.name, row.checksum);
  }
  return map;
}
