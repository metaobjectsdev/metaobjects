import { type Kysely, sql } from "kysely";

/**
 * Default migration-history ledger table name. A single source of truth tracked
 * across postgres + sqlite so `meta migrate --apply` can skip already-applied
 * files (idempotency from the LEDGER, not from re-diffing).
 */
export const MIGRATIONS_TABLE = "_metaobjects_migrations";

/** Default Postgres schema holding the ledger (and, by default, the lock scope). */
export const DEFAULT_LEDGER_SCHEMA = "public";

/**
 * Safe SQL identifier pattern for caller-supplied `schema` / `table` names. These
 * are interpolated as SQL identifiers (one `sql.ref` per part), so they MUST be a
 * single, unquoted-style identifier — no dots, spaces, or quotes — otherwise
 * Kysely's `sql.ref` would split a value like `"v1.2_migrations"` on every `.`
 * into a wrong multi-part name. Validated at resolve time; a violation throws.
 */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Throw a clear, actionable error if a caller-supplied SQL-identifier option
 * (`schema` / `table`) is not a single safe identifier. Names the offending
 * option + value so the caller can fix the misconfiguration directly.
 */
function assertSafeIdentifier(option: string, value: string): void {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error(
      `LedgerOptions.${option} must be a single SQL identifier matching ` +
        `${SAFE_IDENTIFIER.source} (letters, digits, underscore; not starting with a digit). ` +
        `Got ${JSON.stringify(value)} — a dotted/quoted/spaced value would be mis-parsed as a ` +
        `multi-part identifier. Use a plain name (e.g. a per-tenant prefix) instead.`,
    );
  }
}

/** The dialect signal threaded through the ledger fns (schema-qualification only applies to pg). */
export type LedgerDialect = "postgres" | "sqlite";

/**
 * Multi-tenant ledger configuration. Generalizes the fixed
 * `public._metaobjects_migrations` ledger so multiple apps/tenants can track
 * independently in one physical database.
 *
 * Defaults preserve the original single-tenant behavior exactly: `schema`
 * defaults to `public`, `table` to `_metaobjects_migrations`. Postgres uses
 * `schema`; SQLite has no schemas and ignores it. `lockName` is consumed by the
 * advisory-lock path (apply/rollback) — see {@link applyPending}.
 */
export interface LedgerOptions {
  /** Postgres schema holding the ledger table. Default `public`. Ignored on SQLite. */
  schema?: string;
  /** Ledger table name. Default `_metaobjects_migrations`. */
  table?: string;
  /** Advisory-lock name. Default derived from `<schema>.<table>`. Postgres-only. */
  lockName?: string;
}

/** A single ledger row. */
export interface LedgerRow {
  /** Migration name = the `<timestamp>-<slug>` directory name (sort key + id). */
  name: string;
  /** sha-256 of the up.sql contents at apply time (tamper guard). */
  checksum: string;
}

/** Resolved ledger location: a dialect + a Kysely raw-SQL identifier reference. */
interface ResolvedLedger {
  dialect: LedgerDialect;
  schema: string;
  table: string;
  /**
   * A qualified-identifier SQL fragment built from SEPARATE `sql.ref` parts —
   * `"<schema>"."<table>"` on pg, the bare `"<table>"` on sqlite. Built part-wise
   * (not from a single dotted string) so a `.` inside a name can never be
   * misread as an identifier separator, independent of the resolve-time
   * validation.
   */
  ref: ReturnType<typeof sql>;
}

/**
 * Resolve a {@link LedgerOptions} (+ dialect) to a concrete ledger location.
 * On Postgres the table is schema-qualified (`"<schema>"."<table>"`); on SQLite
 * (no schema concept) the schema is ignored and the bare `"<table>"` is used.
 *
 * Caller-supplied `schema` / `table` are validated against {@link SAFE_IDENTIFIER}
 * (a violation throws here, naming the option + value), then assembled from two
 * separate `sql.ref` parts so identifier quoting stays dialect-portable AND no
 * `.` can be mis-parsed as a multi-part separator.
 */
function resolveLedger(
  dialect: LedgerDialect,
  opts: LedgerOptions | undefined,
): ResolvedLedger {
  const schema = opts?.schema ?? DEFAULT_LEDGER_SCHEMA;
  const table = opts?.table ?? MIGRATIONS_TABLE;
  assertSafeIdentifier("table", table);
  if (dialect === "postgres") {
    assertSafeIdentifier("schema", schema);
  }
  const ref =
    dialect === "postgres"
      ? sql`${sql.ref(schema)}.${sql.ref(table)}`
      : sql`${sql.ref(table)}`;
  return { dialect, schema, table, ref };
}

/**
 * Create the migration-history table if it does not already exist. Idempotent:
 * re-running is a no-op and preserves existing rows. Dialect-portable DDL
 * (TEXT columns work on both sqlite and postgres; `applied_at` is stored as
 * text so we don't depend on a dialect-specific timestamp type).
 *
 * On Postgres a multi-tenant `schema` is created first (`CREATE SCHEMA IF NOT
 * EXISTS`) so the ledger can live outside `public`.
 */
export async function ensureLedger(
  db: Kysely<Record<string, unknown>>,
  dialect: LedgerDialect = "sqlite",
  opts?: LedgerOptions,
): Promise<void> {
  const ledger = resolveLedger(dialect, opts);
  if (ledger.dialect === "postgres") {
    await sql`CREATE SCHEMA IF NOT EXISTS ${sql.ref(ledger.schema)}`.execute(db);
  }
  await sql`
    CREATE TABLE IF NOT EXISTS ${ledger.ref} (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL,
      checksum TEXT NOT NULL
    )
  `.execute(db);
}

/**
 * Record a migration as applied. Inserts a row with the current UTC timestamp.
 * Intended to run inside the SAME transaction that applied the migration SQL.
 */
export async function recordApplied(
  db: Kysely<Record<string, unknown>>,
  name: string,
  checksum: string,
  dialect: LedgerDialect = "sqlite",
  opts?: LedgerOptions,
): Promise<void> {
  const ledger = resolveLedger(dialect, opts);
  const appliedAt = new Date().toISOString();
  await sql`
    INSERT INTO ${ledger.ref} (name, applied_at, checksum)
    VALUES (${name}, ${appliedAt}, ${checksum})
  `.execute(db);
}

/** Delete a migration's ledger row (rollback unrecord). */
export async function deleteApplied(
  db: Kysely<Record<string, unknown>>,
  name: string,
  dialect: LedgerDialect = "sqlite",
  opts?: LedgerOptions,
): Promise<void> {
  const ledger = resolveLedger(dialect, opts);
  await sql`
    DELETE FROM ${ledger.ref} WHERE name = ${name}
  `.execute(db);
}

/** Return the set of applied migration names. */
export async function appliedNames(
  db: Kysely<Record<string, unknown>>,
  dialect: LedgerDialect = "sqlite",
  opts?: LedgerOptions,
): Promise<Set<string>> {
  return new Set((await appliedRecords(db, dialect, opts)).keys());
}

/** Return a name→checksum map for all applied migrations (tamper-guard input). */
export async function appliedRecords(
  db: Kysely<Record<string, unknown>>,
  dialect: LedgerDialect = "sqlite",
  opts?: LedgerOptions,
): Promise<Map<string, string>> {
  const ledger = resolveLedger(dialect, opts);
  // Raw select keeps this dialect-portable and sidesteps typing the dynamic
  // table name against the untyped Kysely<Record<string, unknown>> schema.
  const result = await sql<{ name: string; checksum: string }>`
    SELECT name, checksum FROM ${ledger.ref}
  `.execute(db);
  const map = new Map<string, string>();
  for (const row of result.rows) {
    map.set(row.name, row.checksum);
  }
  return map;
}

/** Reserved ledger name for the baseline marker (sorts before any timestamped migration). */
export const BASELINE_NAME = "0000-baseline";

/**
 * Record (or overwrite) the baseline marker — the snapshot checksum captured when
 * `migrate baseline` seeded the reference snapshot. Lets a later check detect a
 * snapshot that was hand-edited out of sync with the migration chain.
 */
export async function recordBaseline(
  db: Kysely<Record<string, unknown>>,
  dialect: LedgerDialect = "sqlite",
  checksum: string,
  opts?: LedgerOptions,
): Promise<void> {
  const ledger = resolveLedger(dialect, opts);
  await ensureLedger(db, dialect, opts);
  const appliedAt = new Date().toISOString();
  // Upsert: delete any prior baseline, then insert (portable across sqlite/pg).
  await sql`DELETE FROM ${ledger.ref} WHERE name = ${BASELINE_NAME}`.execute(db);
  await sql`
    INSERT INTO ${ledger.ref} (name, applied_at, checksum)
    VALUES (${BASELINE_NAME}, ${appliedAt}, ${checksum})
  `.execute(db);
}

/** Read the baseline marker, or null if none recorded. */
export async function baselineRecord(
  db: Kysely<Record<string, unknown>>,
  dialect: LedgerDialect = "sqlite",
  opts?: LedgerOptions,
): Promise<{ name: string; checksum: string } | null> {
  const ledger = resolveLedger(dialect, opts);
  const result = await sql<{ name: string; checksum: string }>`
    SELECT name, checksum FROM ${ledger.ref} WHERE name = ${BASELINE_NAME}
  `.execute(db);
  const row = result.rows[0];
  return row ? { name: row.name, checksum: row.checksum } : null;
}
