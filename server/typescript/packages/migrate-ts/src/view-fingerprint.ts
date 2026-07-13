// view-fingerprint.ts — how Postgres decides whether a managed view is up to date.
//
// WHY THIS EXISTS
//
// Postgres does not store view SQL. It stores the parse tree (as the view's `_RETURN`
// rewrite rule), and `pg_get_viewdef()` DEPARSES that back into Postgres's own
// canonical style. For one of our generated projection views, live PG 16 returns:
//
//   we emit :  SELECT p.id AS "programId", COUNT(DISTINCT w.id) AS "weekCount"
//                FROM programs p LEFT OUTER JOIN weeks w ON w."programId" = p.id
//   PG says :  SELECT p.id AS "programId", count(DISTINCT w.id) AS "weekCount"
//                FROM (programs p LEFT JOIN weeks w ON ((w."programId" = p.id)))
//
// — lowercased functions, LEFT OUTER JOIN rewritten, FROM item and ON predicate
// parenthesized. No textual normalizer can bridge that without reimplementing the
// deparser, so comparing our text against PG's text ALWAYS reports a difference. That
// is what made `replace-view` fire on every migrate for every view, forever, and kept
// `verify --db` permanently red for any project with a projection.
//
// THE FIX: never compare against the deparser. Hash the body WE generate, stamp the
// hash into the view's COMMENT at emit time, and read the stamp back at introspect
// time. Both sides of the comparison then come from the same emitter, and the
// deparsed body is never an input.
//
// The deparsed body is still useful — it is valid SQL that reproduces the view — so it
// is carried as the RESTORE payload for down migrations.
//
// SQLite/D1 need none of this: `sqlite_master.sql` is the verbatim text we wrote, so
// the body comparator (view-sql-compare.ts) is exact there.

import { createHash } from "node:crypto";

/**
 * Marker format version. Bump ONLY if the normalization rules or the marker grammar
 * change — i.e. if the same body would hash differently. The algorithm is tagged
 * separately (`sha256:`), so swapping algorithms does not need a version bump.
 */
export const FINGERPRINT_FORMAT_VERSION = 1;

const MARKER_PREFIX = "metaobjects";

/** Trailing-line marker: any human comment text may sit ABOVE it. */
const MARKER_RE = /(?:^|\n)metaobjects:v(\d+):sha256:([0-9a-f]{64})\s*$/;

const CREATE_VIEW_PREFIX =
  /^\s*create\s+(?:or\s+replace\s+)?(?:temp(?:orary)?\s+)?view\s+(?:if\s+not\s+exists\s+)?[^\s(]+(?:\s*\([^)]*\))?\s+as\s+/i;

/**
 * Canonicalize a view body for hashing.
 *
 * Collapses whitespace (so reindenting the emitter does not re-stamp every deployed
 * view) and strips an optional CREATE VIEW wrapper and trailing semicolon — and
 * NOTHING else.
 *
 * Deliberately does NOT lowercase, unlike `normalizeViewSql`. That lowercasing exists
 * only to chase Postgres's deparser, and it masks drift inside case-sensitive string
 * literals — which `origin.aggregate @filter` predicates now carry (`status = 'Active'`
 * and `status = 'active'` are different views). We never chase the deparser here, so
 * there is nothing to buy and real drift to lose.
 */
export function normalizeForFingerprint(body: string): string {
  return body
    .replace(CREATE_VIEW_PREFIX, "")
    .replace(/\s+/g, " ")
    .replace(/;\s*$/, "")
    .trim();
}

/** sha256 of the normalized body, lowercase hex. */
export function viewFingerprint(body: string): string {
  return createHash("sha256").update(normalizeForFingerprint(body), "utf8").digest("hex");
}

/** The marker line stamped into `COMMENT ON VIEW`. */
export function renderFingerprintMarker(fingerprint: string): string {
  return `${MARKER_PREFIX}:v${FINGERPRINT_FORMAT_VERSION}:sha256:${fingerprint}`;
}

/**
 * Read a fingerprint marker out of a view's comment.
 *
 * Returns null when there is no marker — meaning the view carries no MetaObjects
 * stamp and is therefore either hand-written or older than fingerprinting. Callers
 * MUST fail closed on null: on Postgres those two cases are indistinguishable, and
 * overwriting the first destroys hand-written SQL nothing can restore.
 *
 * An unknown VERSION still parses (the view is ours, stamped by a different
 * toolchain) — the caller re-stamps it, which makes format migration self-healing.
 */
export function parseFingerprintMarker(
  comment: string | null | undefined,
): { version: number; fingerprint: string } | null {
  if (typeof comment !== "string" || comment.length === 0) return null;
  const m = MARKER_RE.exec(comment.trim());
  if (m === null) return null;
  return { version: parseInt(m[1]!, 10), fingerprint: m[2]! };
}
