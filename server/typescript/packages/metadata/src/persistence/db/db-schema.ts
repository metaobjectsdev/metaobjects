// DB-domain attribute schemas — registered by dbProvider (db-provider.ts),
// not the core metamodel.

import type { AttrSchema } from "../../registry.js";
import {
  ATTR_SUBTYPE_STRING,
  ATTR_SUBTYPE_BOOLEAN,
} from "../../core/attr/attr-constants.js";
import {
  FIELD_ATTR_COLUMN,
  FIELD_ATTR_DB_INDEXED,
} from "./db-constants.js";

/** `@column` — column-name override on every field subtype (source.rdb). */
export const columnSchema: AttrSchema = {
  name: FIELD_ATTR_COLUMN,
  valueType: ATTR_SUBTYPE_STRING,
  required: false,
  description:
    "Physical column name for this field on an rdb source. Defaults to the field name via columnNamingStrategy.",
};

/** `@db.indexed` — suppress the @filterable-without-index warning; on every field subtype. */
export const dbIndexedSchema: AttrSchema = {
  name: FIELD_ATTR_DB_INDEXED,
  valueType: ATTR_SUBTYPE_BOOLEAN,
  required: false,
  description:
    "When true, suppress the @filterable-without-index Loader warning (the field is indexed by other means).",
};
