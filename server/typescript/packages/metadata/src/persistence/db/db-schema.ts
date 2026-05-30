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
  FIELD_ATTR_DB_COLUMN_TYPE,
  DB_COLUMN_TYPE_VALUES,
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

/**
 * R6 Plan 2b: `@dbColumnType` — physical DB column-type override on every field
 * subtype. The legal value depends on the field's logical subtype, so the
 * subtype × value pairing is validated own-only by the loader
 * (validateAttrSchema → ERR_BAD_ATTR_VALUE), not by a flat `allowedValues` set.
 * The string valueType keeps the schema's type check intact.
 */
export const dbColumnTypeSchema: AttrSchema = {
  name: FIELD_ATTR_DB_COLUMN_TYPE,
  valueType: ATTR_SUBTYPE_STRING,
  required: false,
  description:
    "Physical DB column-type override (ADR-0013 escape hatch). Legal values are " +
    `${DB_COLUMN_TYPE_VALUES.join(" | ")}, each legal only on a specific logical ` +
    "field subtype (uuid/jsonb on field.string, timestamp_with_tz on field.timestamp). " +
    "The logical field type and its native binding are unchanged.",
};
