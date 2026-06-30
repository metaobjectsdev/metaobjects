// DB concern constants — physical DB column attr keys.

import {
  FIELD_SUBTYPE_STRING,
  FIELD_SUBTYPE_TIMESTAMP,
} from "../../core/field/field-constants.js";

/** Column name override on a field (maps to @column in metadata). */
export const FIELD_ATTR_COLUMN = "column";
/** When true, suppress the @filterable-without-index Loader warning (Project D drift check). */
export const FIELD_ATTR_DB_INDEXED = "db.indexed";

// --- Physical RDB index/constraint attrs the db provider adds to identity.* ---
// These EXTEND core identity subtypes (via registry.extend) rather than living on
// core, because they are pure physical-storage concerns (index ordering, partial-
// index predicate, FK constraint naming) with no logical-model meaning.

/** identity.secondary: per-field index-key sort direction array ('asc' | 'desc'), positional to @fields. Drives DESC-ordered index keys. */
export const IDENTITY_ATTR_ORDERS = "orders";
/** identity.secondary: a partial-index predicate (raw SQL). When set, the index covers only matching rows. */
export const IDENTITY_ATTR_WHERE = "where";
/** identity.secondary: a raw key EXPRESSION for a functional/expression index (e.g. "lower(email)"); used instead of @fields. */
export const IDENTITY_ATTR_EXPR = "expr";
/** identity.secondary: index access method (e.g. "gin", "gist"); default "btree", which is not rendered. */
export const IDENTITY_ATTR_USING = "using";
/** identity.reference: physical FK constraint-name override. Absent → the auto-derived `<table>_<firstFkColumn>_fk`. */
export const IDENTITY_ATTR_CONSTRAINT_NAME = "constraintName";

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
/**
 * `@dbColumnType: uuid_array` — RETIRED (dbColumnType slim-and-derive Phase 1).
 * Native `uuid[]` is now DERIVED from `field.uuid` + `isArray`, not declared via an
 * escape hatch. The constant is retained (so any remaining reference still resolves)
 * but is no longer a legal value — the loader rejects it (ERR_BAD_ATTR_VALUE).
 */
export const DB_COLUMN_TYPE_UUID_ARRAY = "uuid_array";
/**
 * `@dbColumnType: text_array` — RETIRED (dbColumnType slim-and-derive Phase 1).
 * Native `text[]` is now DERIVED from `field.string` + `isArray`. Retained constant,
 * no longer a legal value (loader rejects → ERR_BAD_ATTR_VALUE).
 */
export const DB_COLUMN_TYPE_TEXT_ARRAY = "text_array";

/**
 * The closed set of legal `@dbColumnType` values (raw-dialect passthrough deferred).
 * dbColumnType slim-and-derive Phase 1: `uuid_array`/`text_array` are removed — native
 * arrays are derived from `isArray`. `timestamp_with_tz` stays in Phase 1 (its default
 * flip is Phase 2).
 */
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
