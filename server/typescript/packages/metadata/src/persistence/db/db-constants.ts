// DB concern constants — physical DB column attr keys.

import {
  FIELD_SUBTYPE_STRING,
} from "../../core/field/field-constants.js";

/** Column name override on a field (maps to @column in metadata). */
export const FIELD_ATTR_COLUMN = "column";
/**
 * `@flattenedColumnPrefix` on a `field.object @storage "flattened"`: the text before each member's
 * column, verbatim (`""` allowed). Absent → the field's resolved column and `_`
 * ({@link resolveFlattenedColumnPrefix} in naming.ts).
 */
export const FIELD_ATTR_FLATTENED_COLUMN_PREFIX = "flattenedColumnPrefix";
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
/** identity.primary (@generation "increment"): the sequence's first value. Absent → 1. */
export const IDENTITY_ATTR_SEQUENCE_START = "sequenceStart";
/** identity.primary (@generation "increment"): the sequence's physical name. Absent → the database's default. */
export const IDENTITY_ATTR_SEQUENCE_NAME = "sequenceName";

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

/**
 * ADR-0036 Wave 2: `@localTime` — a boolean flag on `field.timestamp` marking the
 * rare naive / wall-clock case. When true the column is Postgres `timestamp
 * without time zone`; absent/false (the default) is an absolute instant →
 * `timestamptz`. This replaces the retired `@dbColumnType: timestamp_with_tz`
 * escape hatch — timezone-awareness now lives in the logical field type
 * (instant-by-default) + this opt-out, not in a physical column-type string.
 */
export const FIELD_ATTR_LOCAL_TIME = "localTime";

/** rc.21 part B (U2): the text column spellings `@dbColumnType` takes on a field.string. */
export const DB_COLUMN_TYPE_TEXT = "text";
export const DB_COLUMN_TYPE_VARCHAR = "varchar";
export const DB_COLUMN_TYPE_CHARACTER_VARYING = "character varying";

/**
 * The closed set of legal bare `@dbColumnType` values (raw-dialect passthrough deferred).
 * dbColumnType slim-and-derive (ADR-0036 Wave 1, decision 4): the native-array
 * overrides `uuid_array`/`text_array` are fully removed — native `uuid[]`/`text[]`
 * are DERIVED from a field subtype + `isArray`, never declared via an escape hatch.
 * Wave 2 (decision 1) retires `timestamp_with_tz` entirely — tz-awareness moves to
 * `field.timestamp` (instant by default) + `@localTime` (the naive opt-out).
 * rc.21 part B (U2) adds the text spellings: `text`, an unbounded `varchar` / `character
 * varying`, and the sized `varchar(n)`, `character varying(n)` and `character(n)`
 * ({@link parseDbColumnType}), all on field.string.
 */
export const DB_COLUMN_TYPE_VALUES = [
  DB_COLUMN_TYPE_UUID,
  DB_COLUMN_TYPE_JSONB,
  DB_COLUMN_TYPE_TEXT,
  DB_COLUMN_TYPE_VARCHAR,
  DB_COLUMN_TYPE_CHARACTER_VARYING,
] as const;
export type DbColumnTypeValue = (typeof DB_COLUMN_TYPE_VALUES)[number];

/** The sized spellings, as written in a message: `n` is a positive integer. */
export const DB_COLUMN_TYPE_SIZED_SPELLINGS = ["varchar(n)", "character varying(n)", "character(n)"] as const;

/**
 * Legal `@dbColumnType` value → the field subtypes it may be applied to (ADR-0013,
 * R6 Plan 2b). Any other (subtype × value) pairing — or an unrecognized value — is
 * an ERR_BAD_ATTR_VALUE. Keyed by value; the value-set is enforced by membership in
 * this map. Subtype names are the bare FIELD_SUBTYPE_* constants (string). The sized
 * spellings are field.string's too.
 */
export const DB_COLUMN_TYPE_LEGAL_SUBTYPES: Readonly<Record<DbColumnTypeValue, readonly string[]>> = {
  [DB_COLUMN_TYPE_UUID]: [FIELD_SUBTYPE_STRING],
  [DB_COLUMN_TYPE_JSONB]: [FIELD_SUBTYPE_STRING],
  [DB_COLUMN_TYPE_TEXT]: [FIELD_SUBTYPE_STRING],
  [DB_COLUMN_TYPE_VARCHAR]: [FIELD_SUBTYPE_STRING],
  [DB_COLUMN_TYPE_CHARACTER_VARYING]: [FIELD_SUBTYPE_STRING],
} as const;

/** A parsed `@dbColumnType`: what the column is, and its declared length for a sized spelling. */
export type ParsedDbColumnType =
  | { readonly kind: "uuid" }
  | { readonly kind: "jsonb" }
  | { readonly kind: "text" }
  | { readonly kind: "varchar"; readonly length?: number }
  | { readonly kind: "char"; readonly length: number };

/**
 * rc.21 part B (U2): parse a `@dbColumnType` value, or undefined for one that is not legal. The
 * spellings are Postgres's own, matched exactly (lowercase, one space): `varchar` and `character
 * varying` are the one unbounded varying type, `varchar(n)` and `character varying(n)` the sized
 * one, `character(n)` the fixed-length one. Every port parses them alike.
 */
export function parseDbColumnType(value: string): ParsedDbColumnType | undefined {
  if (value === DB_COLUMN_TYPE_UUID) return { kind: "uuid" };
  if (value === DB_COLUMN_TYPE_JSONB) return { kind: "jsonb" };
  if (value === DB_COLUMN_TYPE_TEXT) return { kind: "text" };
  if (value === DB_COLUMN_TYPE_VARCHAR || value === DB_COLUMN_TYPE_CHARACTER_VARYING) return { kind: "varchar" };
  const sized = /^(varchar|character varying|character)\(([1-9][0-9]{0,8})\)$/.exec(value);
  if (sized === null) return undefined;
  const length = Number(sized[2]);
  return sized[1] === "character" ? { kind: "char", length } : { kind: "varchar", length };
}

/** The field subtypes a `@dbColumnType` value is legal on, or undefined for a value that is not legal. */
export function dbColumnTypeLegalSubtypes(value: string): readonly string[] | undefined {
  return parseDbColumnType(value) === undefined ? undefined : [FIELD_SUBTYPE_STRING];
}
