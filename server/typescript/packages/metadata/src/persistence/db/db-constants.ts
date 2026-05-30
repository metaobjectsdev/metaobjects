// DB concern constants — physical DB column attr keys.

import {
  FIELD_SUBTYPE_STRING,
  FIELD_SUBTYPE_TIMESTAMP,
} from "../../core/field/field-constants.js";

/** Column name override on a field (maps to @column in metadata). */
export const FIELD_ATTR_COLUMN = "column";
/** When true, suppress the @filterable-without-index Loader warning (Project D drift check). */
export const FIELD_ATTR_DB_INDEXED = "db.indexed";

/**
 * R6 Plan 2b: `@dbColumnType` — physical DB column-type override on a field.
 * Selects the DB column type WITHOUT changing the logical field type or its
 * native binding (ADR-0013 — the canonical physical escape hatch). Registered
 * by the dbProvider, validated as a (logical subtype × value) pairing.
 */
export const FIELD_ATTR_DB_COLUMN_TYPE = "dbColumnType";

/** `@dbColumnType: uuid` — native Postgres `uuid` column (legal on field.string). */
export const DB_COLUMN_TYPE_UUID = "uuid";
/** `@dbColumnType: jsonb` — genuinely-open `jsonb` column (legal on field.string). */
export const DB_COLUMN_TYPE_JSONB = "jsonb";
/** `@dbColumnType: timestamp_with_tz` — `timestamp with time zone` (legal on field.timestamp). */
export const DB_COLUMN_TYPE_TIMESTAMP_WITH_TZ = "timestamp_with_tz";

/** The closed set of legal `@dbColumnType` values (raw-dialect passthrough deferred). */
export const DB_COLUMN_TYPE_VALUES = [
  DB_COLUMN_TYPE_UUID,
  DB_COLUMN_TYPE_JSONB,
  DB_COLUMN_TYPE_TIMESTAMP_WITH_TZ,
] as const;
export type DbColumnTypeValue = (typeof DB_COLUMN_TYPE_VALUES)[number];

/**
 * Legal `@dbColumnType` value → the field subtypes it may be applied to (ADR-0013,
 * R6 Plan 2b). Any other (subtype × value) pairing — or an unrecognized value — is
 * an ERR_BAD_ATTR_VALUE. Keyed by value; the value-set is enforced by membership in
 * this map. Subtype names are the bare FIELD_SUBTYPE_* constants (string / timestamp).
 */
export const DB_COLUMN_TYPE_LEGAL_SUBTYPES: Readonly<Record<DbColumnTypeValue, readonly string[]>> = {
  [DB_COLUMN_TYPE_UUID]: [FIELD_SUBTYPE_STRING],
  [DB_COLUMN_TYPE_JSONB]: [FIELD_SUBTYPE_STRING],
  [DB_COLUMN_TYPE_TIMESTAMP_WITH_TZ]: [FIELD_SUBTYPE_TIMESTAMP],
} as const;
