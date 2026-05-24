// Source concern constants — subtypes and attr keys for the source.* type family.

import { SUBTYPE_BASE } from "../../shared/base-types.js";

// ---------------------------------------------------------------------------
// Source type — declares where an object's data lives (Project E).
// dbTable / dbView ship in v1. Multiple sources per object are allowed
// and meaningful (write-through CQRS: dbTable for writes + dbView for reads).
// ---------------------------------------------------------------------------

export const SOURCE_SUBTYPE_DB_TABLE = "dbTable";
export const SOURCE_SUBTYPE_DB_VIEW  = "dbView";

// --- Source v2 (ADR-0007): paradigm subtype "rdb"; physical name @table; @kind + @role. ---
export const SOURCE_SUBTYPE_RDB = "rdb";

export const SOURCE_SUBTYPES = [
  SUBTYPE_BASE,
  SOURCE_SUBTYPE_DB_TABLE,
  SOURCE_SUBTYPE_DB_VIEW,
  SOURCE_SUBTYPE_RDB,
] as const;
export type SourceSubType = (typeof SOURCE_SUBTYPES)[number];

// Source attrs — both dbTable and dbView use @name for the SQL identifier
// (table name and view name respectively). Same key for ergonomic consistency.
export const SOURCE_DB_TABLE_ATTR_NAME = "name";
export const SOURCE_DB_VIEW_ATTR_NAME  = "name";
/** Shared @name attr key for MetaSource (covers both dbTable and dbView). Use this
 *  in generic source accessors instead of the subtype-specific aliases above. */
export const SOURCE_ATTR_NAME          = "name";

/** Optional DB schema attr on source[dbTable] / source[dbView]. Postgres uses
 *  this to namespace tables/views. SQLite has no schema concept and rejects
 *  any non-default value. Default for Postgres: "public". */
export const SOURCE_ATTR_SCHEMA = "schema";

/** Default Postgres schema when @schema is omitted from a source. */
export const DEFAULT_DB_SCHEMA_POSTGRES = "public";

// ---------------------------------------------------------------------------
// Source v2 (ADR-0007) — rdb paradigm: kind, role, physical table name.
// All constants below are ADDITIVE; v1 constants above remain until the v2
// rollout removes them.
// ---------------------------------------------------------------------------

/** Physical table/view name on source.rdb (replaces the v1 @name). */
export const SOURCE_ATTR_TABLE = "table";
/** Object kind within the rdb paradigm; read-only-ness is derived from it. */
export const SOURCE_ATTR_KIND = "kind";
/** Multi-source role; exactly one primary per object. */
export const SOURCE_ATTR_ROLE = "role";

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
