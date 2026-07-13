// view-sql-compare.ts — the SQLITE/D1 comparator for view definition SQL.
//
// SCOPE — read this before reusing it. This comparator is sound ONLY on engines that
// store view SQL VERBATIM. SQLite and D1 do: `sqlite_master.sql` hands back the exact
// `CREATE VIEW <name> AS <body>` text we wrote, so normalizing away whitespace and the
// CREATE wrapper leaves two strings that genuinely can be equal.
//
// It is NOT usable on Postgres, and used to be. Postgres does not store view SQL — it
// stores the parse tree, and `pg_get_viewdef()` DEPARSES it back in Postgres's own
// style (lowercased functions, `LEFT OUTER JOIN` rewritten to `LEFT JOIN`,
// parenthesized FROM items and ON predicates, redundant aliases dropped). The text we
// emitted therefore NEVER comes back, this comparator returned false every single
// time, and `replace-view` fired on every migrate for every view, forever — while
// `verify --db` stayed permanently red for any project with a projection. Postgres now
// compares FINGERPRINTS instead (see view-fingerprint.ts), which never consults the
// deparser at all. Do not point this function at Postgres again.
//
// normalizeViewSql strips a leading `CREATE [OR REPLACE] VIEW <name> AS`, collapses
// whitespace runs, drops a trailing `;`, and lower-cases.
//
// CAVEAT (accepted tradeoff): lower-casing can mask a difference living ONLY in a
// case-sensitive string literal (e.g. `WHERE status = 'Active'` vs `'active'`), which
// an `origin.aggregate @filter` predicate can now carry. The fingerprint path
// deliberately does NOT lowercase for exactly this reason; this SQLite path keeps it
// for backwards-compatible behavior. The name regex matches one whitespace/`(`-free
// token, so a quoted view name containing a space would not strip cleanly — a non-issue
// for generated identifiers.

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
