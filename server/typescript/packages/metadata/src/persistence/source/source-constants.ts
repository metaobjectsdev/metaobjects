// Source concern constants — subtypes and attr keys for the source.* type family.

import { SUBTYPE_BASE } from "../../shared/base-types.js";

// ---------------------------------------------------------------------------
// Source type — declares where an object's data lives (Project E).
// source.rdb (ADR-0007): paradigm subtype + @table/@kind/@role/@schema attrs.
// Multiple sources per object are allowed and meaningful (write-through CQRS:
// writable rdb[table] for writes + read-only rdb[view] for reads).
// ---------------------------------------------------------------------------

// --- Source v2 (ADR-0007): paradigm subtype "rdb"; physical name @table; @kind + @role. ---
export const SOURCE_SUBTYPE_RDB = "rdb";

export const SOURCE_SUBTYPES = [
  SUBTYPE_BASE,
  SOURCE_SUBTYPE_RDB,
] as const;
export type SourceSubType = (typeof SOURCE_SUBTYPES)[number];

/** Optional DB schema attr on source.rdb. Postgres uses this to namespace
 *  tables/views. SQLite has no schema concept and rejects any non-default
 *  value. Default for Postgres: "public". */
export const SOURCE_ATTR_SCHEMA = "schema";

/** Default Postgres schema when @schema is omitted from a source. */
export const DEFAULT_DB_SCHEMA_POSTGRES = "public";

// ---------------------------------------------------------------------------
// Source v2 (ADR-0007) — rdb paradigm: kind, role, physical table name.
// ---------------------------------------------------------------------------

// FR-016 / ADR-0007 point 2: the source's "logical name" is the structural
// `name` field every MetaData node already carries — accessed via `source.name`,
// NOT an @-attr. (An @-attr would conflict with the ERR_RESERVED_ATTR rule for
// the reserved structural key `name`.) See the four-step physical-name
// resolution rule on MetaSource.physicalName.

// --- Per-kind physical-name aliases (FR-016 / ADR-0018) -----------------------
// One canonical attr key per rdb @kind. The single internal physical-name
// "slot" on the source is filled by whichever alias matches @kind; the
// canonical serializer emits the kind-matching alias regardless of which
// spelling was on input.
/** Physical SQL table name. Canonical attr for @kind: "table" (default). */
export const SOURCE_ATTR_TABLE = "table";
/** Physical SQL view name. Canonical attr for @kind: "view". */
export const SOURCE_ATTR_VIEW = "view";
/** Physical SQL materialized-view name. Canonical attr for @kind: "materializedView". */
export const SOURCE_ATTR_MATERIALIZED_VIEW = "materializedView";
/** Physical SQL stored-procedure name. Canonical attr for @kind: "storedProc". */
export const SOURCE_ATTR_PROC = "proc";
/** Physical SQL table-function name. Canonical attr for @kind: "tableFunction". */
export const SOURCE_ATTR_FUNCTION = "function";

/** Object kind within the rdb paradigm; read-only-ness is derived from it. */
export const SOURCE_ATTR_KIND = "kind";
/** Multi-source role; exactly one primary per object. */
export const SOURCE_ATTR_ROLE = "role";

/** FR-015: reference to an object.value describing the input shape of a callable
 *  source. Required for @kind: "storedProc" | "tableFunction" that take args;
 *  ignored for non-callable kinds. Wire-format symmetric with template.@payloadRef
 *  (FR-004) — the typed-input pattern reuses object.value rather than minting a
 *  new parameter.* node type. */
export const SOURCE_ATTR_PARAMETER_REF = "parameterRef";

export const SOURCE_KIND_TABLE              = "table";
export const SOURCE_KIND_VIEW               = "view";
export const SOURCE_KIND_MATERIALIZED_VIEW  = "materializedView";
export const SOURCE_KIND_STORED_PROC        = "storedProc";
export const SOURCE_KIND_TABLE_FUNCTION     = "tableFunction";

export const SOURCE_RDB_KINDS = [
  SOURCE_KIND_TABLE,
  SOURCE_KIND_VIEW,
  SOURCE_KIND_MATERIALIZED_VIEW,
  SOURCE_KIND_STORED_PROC,
  SOURCE_KIND_TABLE_FUNCTION,
] as const;
export type SourceRdbKind = (typeof SOURCE_RDB_KINDS)[number];

/** Map @kind → canonical kind-aware physical-name attr key (FR-016 / ADR-0018).
 *  Drives the four-step physical-name resolution rule and the canonical-serializer
 *  per-kind rewrite. The single internal physical-name "slot" on a source is the
 *  value of whichever alias matches the source's @kind. */
export const PHYSICAL_NAME_ATTR_BY_KIND: ReadonlyMap<string, string> = new Map([
  [SOURCE_KIND_TABLE,             SOURCE_ATTR_TABLE],
  [SOURCE_KIND_VIEW,              SOURCE_ATTR_VIEW],
  [SOURCE_KIND_MATERIALIZED_VIEW, SOURCE_ATTR_MATERIALIZED_VIEW],
  [SOURCE_KIND_STORED_PROC,       SOURCE_ATTR_PROC],
  [SOURCE_KIND_TABLE_FUNCTION,    SOURCE_ATTR_FUNCTION],
]);

/** rdb @kind default when omitted (writable table). */
export const DEFAULT_SOURCE_KIND = SOURCE_KIND_TABLE;

/** Kinds whose source is read-only (codegen emits read-only model/queries/routes). */
export const SOURCE_READ_ONLY_KINDS: ReadonlySet<string> = new Set([
  SOURCE_KIND_VIEW,
  SOURCE_KIND_MATERIALIZED_VIEW,
  SOURCE_KIND_STORED_PROC,
  SOURCE_KIND_TABLE_FUNCTION,
]);

export const SOURCE_ROLE_PRIMARY = "primary";
export const SOURCE_ROLE_REPLICA = "replica";
export const SOURCE_ROLE_INDEX   = "index";
export const SOURCE_ROLE_CACHE   = "cache";
export const SOURCE_ROLE_PUBLISH = "publish";
export const SOURCE_ROLE_MIRROR  = "mirror";

export const SOURCE_ROLES = [
  SOURCE_ROLE_PRIMARY,
  SOURCE_ROLE_REPLICA,
  SOURCE_ROLE_INDEX,
  SOURCE_ROLE_CACHE,
  SOURCE_ROLE_PUBLISH,
  SOURCE_ROLE_MIRROR,
] as const;
export type SourceRole = (typeof SOURCE_ROLES)[number];

/** Role when @role is omitted (system of record). */
export const DEFAULT_SOURCE_ROLE = SOURCE_ROLE_PRIMARY;
