// Source concern constants — subtypes and attr keys for the source.* type family.

import { SUBTYPE_BASE } from "../../shared/base-types.js";

// ---------------------------------------------------------------------------
// Source type — declares where an object's data lives (Project E).
// dbTable / dbView ship in v1. Multiple sources per object are allowed
// and meaningful (write-through CQRS: dbTable for writes + dbView for reads).
// ---------------------------------------------------------------------------

export const SOURCE_SUBTYPE_DB_TABLE = "dbTable";
export const SOURCE_SUBTYPE_DB_VIEW  = "dbView";

export const SOURCE_SUBTYPES = [
  SUBTYPE_BASE,
  SOURCE_SUBTYPE_DB_TABLE,
  SOURCE_SUBTYPE_DB_VIEW,
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
