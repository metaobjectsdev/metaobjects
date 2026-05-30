// view-sql-compare.ts — the single shared comparator for view definition SQL.
//
// View definition SQL arrives in two shapes across the pipeline:
//   - EXPECTED (buildExpectedViews): the body only — `SELECT ... FROM ...`.
//   - ACTUAL (introspect): sqlite's sqlite_master.sql is the full
//     `CREATE VIEW <name> AS <body>`; Postgres' view_definition is body-only.
//   - The CLI's readExistingViewSql synthesizes `CREATE VIEW <name> AS <body>`
//     for Postgres so it matches what emitViewDdl produces.
//
// normalizeViewSql reduces any of these to a comparable canonical form so the
// diff (expected vs introspected) and the CLI (emitted DDL vs existing DDL) use
// ONE comparison. It strips a leading `CREATE [OR REPLACE] VIEW <name> AS`,
// collapses runs of whitespace to a single space, drops a trailing `;`, and
// lower-cases — view-body drift should be classified by structure, not by
// incidental whitespace/case/wrapper differences.
//
// CAVEAT (accepted tradeoff): lower-casing makes keyword/identifier comparison
// case-insensitive but can mask a difference that lives ONLY in a case-sensitive
// string literal in the body (e.g. `WHERE status = 'Active'` vs `'active'`) —
// such a change would NOT be flagged as drift. Acceptable for generated
// aggregate/passthrough projections (no literals); revisit if hand-authored
// views with case-sensitive literals become a drift concern. The name regex
// matches one whitespace/`(`-free token, so a quoted view name containing a
// space would not strip cleanly — also a non-issue for generated identifiers.

const CREATE_VIEW_PREFIX =
  /^\s*create\s+(?:or\s+replace\s+)?(?:temp(?:orary)?\s+)?view\s+(?:if\s+not\s+exists\s+)?[^\s(]+(?:\s*\([^)]*\))?\s+as\s+/i;

/**
 * Collapse a view definition (full `CREATE VIEW ... AS body` OR a bare body)
 * to a canonical, comparable string. Whitespace-, case-, and wrapper-insensitive.
 */
export function normalizeViewSql(sql: string): string {
  return sql
    .replace(CREATE_VIEW_PREFIX, "")
    .replace(/\s+/g, " ")
    .replace(/;\s*$/, "")
    .trim()
    .toLowerCase();
}

/** True when two view definitions are equivalent after normalization. */
export function viewSqlEquals(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  return normalizeViewSql(a) === normalizeViewSql(b);
}
