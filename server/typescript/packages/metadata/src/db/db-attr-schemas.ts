// DB-domain attribute schemas — registered by dbProvider (db-provider.ts),
// not the core metamodel.
// See docs/superpowers/specs/2026-05-18-phase4b-db-provider-design.md.

import type { AttrSchema } from "../registry.js";
import {
  ATTR_SUBTYPE_STRING,
  ATTR_SUBTYPE_BOOLEAN,
} from "../core/attr/attr-constants.js";
import {
  FIELD_ATTR_DB_COLUMN,
  FIELD_ATTR_DB_INDEXED,
} from "../persistence/db/db-constants.js";
import { SOURCE_ATTR_NAME } from "../persistence/source/source-constants.js";

/** `@dbColumn` — column-name override; on every field subtype. */
export const dbColumnSchema: AttrSchema = {
  name: FIELD_ATTR_DB_COLUMN,
  valueType: ATTR_SUBTYPE_STRING,
  required: false,
  description:
    "Override the generated SQL column name for this field. Defaults to the field name run through the project's columnNamingStrategy.",
};

/** `@db.indexed` — suppress the @filterable-without-index warning; on every field subtype. */
export const dbIndexedSchema: AttrSchema = {
  name: FIELD_ATTR_DB_INDEXED,
  valueType: ATTR_SUBTYPE_BOOLEAN,
  required: false,
  description:
    "When true, suppress the @filterable-without-index Loader warning (the field is indexed by other means).",
};

/** `@name` — the SQL table/view identifier; on source.dbTable and source.dbView. */
export const sourceNameSchema: AttrSchema = {
  name: SOURCE_ATTR_NAME,
  valueType: ATTR_SUBTYPE_STRING,
  required: false,
  description:
    "The SQL table or view name for this source. Defaults to the object name run through the columnNamingStrategy when omitted.",
};
