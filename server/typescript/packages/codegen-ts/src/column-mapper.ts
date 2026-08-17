// Field-type → Drizzle column type mapping. Per design §6.
// Uses the typed MetaField.validators() accessor (effective — includes inherited) for all validator checks.

import type { MetaField } from "@metaobjectsdev/metadata";
import {
  FIELD_SUBTYPE_STRING,
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_LONG,
  FIELD_SUBTYPE_CURRENCY,
  FIELD_SUBTYPE_DOUBLE,
  FIELD_SUBTYPE_FLOAT,
  FIELD_SUBTYPE_DECIMAL,
  FIELD_SUBTYPE_BOOLEAN,
  FIELD_SUBTYPE_DATE,
  FIELD_SUBTYPE_TIME,
  FIELD_SUBTYPE_TIMESTAMP,
  FIELD_SUBTYPE_OBJECT,
  FIELD_SUBTYPE_MAP,
  FIELD_SUBTYPE_ENUM,
  FIELD_SUBTYPE_UUID,
  FIELD_SUBTYPE_URI,
  FIELD_SUBTYPE_INET,
  VALIDATOR_SUBTYPE_REQUIRED,
  VALIDATOR_SUBTYPE_LENGTH,
  FIELD_ATTR_MAX_LENGTH,
  FIELD_ATTR_PRECISION,
  FIELD_ATTR_SCALE,
  FIELD_ATTR_REQUIRED,
  FIELD_ATTR_UNIQUE,
  FIELD_ATTR_DEFAULT,
  FIELD_ATTR_OBJECT_REF,
  FIELD_ATTR_VALUE_TYPE,
  FIELD_ATTR_STORAGE,
  STORAGE_JSONB,
  VALIDATOR_ATTR_MAX,
  FIELD_ATTR_DB_COLUMN_TYPE,
  DB_COLUMN_TYPE_UUID,
  DB_COLUMN_TYPE_JSONB,
  FIELD_ATTR_LOCAL_TIME,
  FIELD_ATTR_LENIENT,
  TYPE_ORIGIN,
  ORIGIN_SUBTYPE_AGGREGATE,
  ORIGIN_AGGREGATE_ATTR_AGG,
  AGG_ANY,
  AGG_ALL,
  AGG_COLLECT,
} from "@metaobjectsdev/metadata";
import { columnNameFromField } from "./naming.js";
import { enumValues, intValueMapOf, intValueForMember } from "./enum-meta.js";
import { DEFAULT_COLUMN_NAMING_STRATEGY, stripPackage } from "@metaobjectsdev/metadata";
import type { Dialect, ColumnNamingStrategy } from "./metaobjects-config.js";

export type { Dialect };

/**
 * Discriminated union describing how a column default should be emitted.
 * - { kind: "now" }              — dialect-aware: sql`CURRENT_TIMESTAMP` (sqlite) or .defaultNow() (postgres)
 * - { kind: "sqlExpr"; raw }     — raw SQL expression wrapped in sql`...` (CURRENT_DATE, CURRENT_TIME, function calls)
 * - { kind: "literal"; value }   — .default(JSON.stringify(value))
 * - { kind: "arrayLiteral"; elements } — .default([...]) for an isArray field. Drizzle's
 *   `.array().default(x)` (postgres) and `.$type<E[]>().default(x)` (sqlite json)
 *   both want a JS array, NOT the raw metadata string ("{}" / "[]" / "{a,b}"),
 *   which would fail `tsc` (TS2345). The metadata @default MUST be a string (the
 *   Java loader rejects a JSON array default), so the array literal is parsed out
 *   of that string here and emitted as a real JS array. Elements are pre-rendered
 *   TS literal source (numbers/booleans bare, strings quoted).
 */
export type DefaultExpr =
  | { kind: "now" }
  | { kind: "sqlExpr"; raw: string }
  | { kind: "literal"; value: unknown }
  | { kind: "arrayLiteral"; elements: string[] };

/**
 * Parse a string @default for an isArray field into the element source-literals
 * that go inside a JS `[...]` array literal, or return undefined when the shape
 * is ambiguous/unsupported (caller then falls back to a raw sql`...` cast so the
 * output ALWAYS typechecks — never a bare string).
 *
 * Recognized input shapes (the metadata @default is always a string — an array
 * default is authored as "[]" / "{}" / "{a,b}", never a JSON array, because the
 * Java loader requires @default to be a string):
 *   - "{}"            → []           (Postgres empty-array literal)
 *   - "[]"            → []           (JSON empty array)
 *   - "{a,b}"         → elements a,b (Postgres array literal, comma-separated)
 *   - '["a","b"]'     → elements a,b (JSON array)
 *
 * `numericElements` controls quoting: numeric/boolean element subtypes emit bare
 * literals (1, true), everything else is quoted as a string literal. A parse that
 * can't be represented safely (nested quotes/commas we don't fully model, mixed
 * shapes) returns undefined.
 */
function parseArrayDefault(
  raw: string,
  numericElements: boolean,
): string[] | undefined {
  const trimmed = raw.trim();

  // JSON array form: '[]' or '["a","b"]' or '[1,2]'.
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return undefined;
    }
    if (!Array.isArray(parsed)) return undefined;
    const out: string[] = [];
    for (const el of parsed) {
      if (numericElements) {
        if (typeof el === "number" || typeof el === "boolean") {
          out.push(String(el));
        } else if (typeof el === "string" && el.trim() !== "" && !Number.isNaN(Number(el))) {
          out.push(String(Number(el)));
        } else {
          return undefined; // numeric column but a non-numeric element — bail to raw SQL
        }
      } else {
        if (typeof el === "string") {
          out.push(JSON.stringify(el));
        } else if (typeof el === "number" || typeof el === "boolean") {
          out.push(JSON.stringify(String(el)));
        } else {
          return undefined;
        }
      }
    }
    return out;
  }

  // Postgres array-literal form: '{}' or '{a,b}'.
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner === "") return []; // '{}' → empty array
    // A quote or nested brace means an escaping shape we don't fully model — bail
    // to a raw sql`...` cast rather than mis-split it.
    if (/["{}]/.test(inner)) return undefined;
    const parts = inner.split(",").map((p) => p.trim());
    const out: string[] = [];
    for (const p of parts) {
      if (numericElements) {
        if (p === "" || Number.isNaN(Number(p))) return undefined;
        out.push(String(Number(p)));
      } else {
        out.push(JSON.stringify(p));
      }
    }
    return out;
  }

  return undefined;
}

/**
 * Patterns recognized as SQL expressions in a default value. Anything matching
 * these is treated as a SQL expression, not a string literal. Mirrors
 * migrate-ts/src/expected-schema.ts's EXPR_DEFAULT_PATTERNS so both sides
 * agree on what's an expression.
 */
const SQL_EXPR_PATTERNS: RegExp[] = [
  /^now$/i,
  /^now\(\)$/i,
  /^current_timestamp$/i,
  /^current_date$/i,
  /^current_time$/i,
  /\(\)$/,                // anything function-like
];

/** True iff the value should be emitted as a SQL expression. */
function isSqlExprDefault(value: string): boolean {
  return SQL_EXPR_PATTERNS.some((re) => re.test(value));
}

/**
 * For an isArray:true field stored in SQLite as text(...,{mode:"json"}), return
 * the TS element type used in the emitted .$type<E[]>() chain. Returns undefined
 * when the field's subType doesn't have a stable scalar TS mapping (e.g.,
 * field.object — leave the inferred `unknown[]` so the consumer can layer a
 * richer schema on top).
 */
function sqliteJsonArrayElementTsType(subType: string): string | undefined {
  switch (subType) {
    case FIELD_SUBTYPE_STRING:
    case FIELD_SUBTYPE_ENUM:
    case FIELD_SUBTYPE_UUID:
    case FIELD_SUBTYPE_DATE:
    case FIELD_SUBTYPE_TIME:
    case FIELD_SUBTYPE_TIMESTAMP:
    case FIELD_SUBTYPE_DECIMAL:
      return "string";
    case FIELD_SUBTYPE_INT:
    case FIELD_SUBTYPE_LONG:
    case FIELD_SUBTYPE_CURRENCY:
    case FIELD_SUBTYPE_DOUBLE:
    case FIELD_SUBTYPE_FLOAT:
      return "number";
    case FIELD_SUBTYPE_BOOLEAN:
      return "boolean";
    default:
      return undefined;
  }
}

/** Map a recognized SQL expression to its canonical raw form (uppercase keywords). */
function canonicalizeSqlExpr(value: string): string {
  const lower = value.toLowerCase();
  if (lower === "now" || lower === "now()" || lower === "current_timestamp") {
    return "CURRENT_TIMESTAMP";
  }
  if (lower === "current_date") return "CURRENT_DATE";
  if (lower === "current_time") return "CURRENT_TIME";
  return value; // unrecognized — pass through (function calls etc.)
}

/**
 * An int-backed `field.enum` column: a generated Drizzle `customType` whose
 * `toDriver`/`fromDriver` translate member symbol <-> stored integer, so the
 * codec lives in the COLUMN definition rather than in the query layer.
 *
 * This is the TS analogue of what every other port already does at its own
 * `MetaField` codec seam (EF Core `HasConversion`, OMDB `JdbcFieldCodec`, Exposed
 * `customEnumeration`, Python `ObjectManager` coercion) — which is why it was
 * chosen over a Zod write-transform plus a bespoke read-decode: TS's generated
 * queries hand back raw Drizzle rows and have no decode seam at all, so a
 * query-layer codec would have meant inventing one and wrapping every generated
 * read. Binding through the column type also makes filter values encode for free.
 */
export interface EnumIntCustomType {
  /** Local const name for the customType column helper, e.g. `orderStatusEnumCol`. */
  fnConstName: string;
  /** Local const name for the symbol->int map, e.g. `ORDER_STATUS_TO_INT`. */
  toIntConstName: string;
  /** Local const name for the int->symbol map, e.g. `ORDER_STATUS_FROM_INT`. */
  fromIntConstName: string;
  /** Physical column type for `dataType()` — always integer for an int-backed enum. */
  dataType: string;
  /** Member symbols, in `@values` order (the TS union and the map key order). */
  members: string[];
  /** Member symbol -> stored integer. */
  intByMember: Record<string, number>;
}

export interface ColumnSpec {
  /** Drizzle function name, e.g., "text", "integer", "varchar". */
  fnName: string;
  /**
   * When set, `fnName` names a LOCAL generated const (this spec's customType
   * helper) rather than a Drizzle export — the renderer must NOT `imp()` it.
   */
  enumIntCustomType?: EnumIntCustomType;
  /** DB column name (snake_case from field name, or @column override). */
  dbName: string;
  /** Positional args after dbName (currently always empty; reserved). */
  fnArgs: unknown[];
  /** Object passed as second arg if non-empty (e.g., { length: 200 }, { mode: 'boolean' }). */
  fnOptions?: Record<string, unknown>;
  /** Method chain modifiers, e.g., [".notNull()", ".unique()"]. */
  modifiers: string[];
  /** Default expression for the column — dialect-specific emission handled by the template. */
  defaultExpr?: DefaultExpr;
  /** Drizzle import module: "drizzle-orm/sqlite-core" or "drizzle-orm/pg-core". */
  importModule: string;
  /** Optional leading line-comment for the generated column (e.g., type-fallback notice). */
  leadingComment?: string;
  /** Optional CHECK constraint expression for the column (e.g., `status IN ('A', 'B')`). */
  checkConstraint?: string;
  /**
   * Optional `.$type<...>()` chain target. Renderer (drizzle-schema.ts) emits
   * it ahead of the modifiers chain, using ts-poet `imp()` for objectRef
   * variants so the cross-module type import auto-hoists. `array` controls the
   * `[]` suffix: a single value (`VO`) vs a collection (`VO[]`).
   * `kind: "scalar"` covers string[]/number[]/boolean[] — no import needed.
   * `kind: "objectRef"` covers SourceLens/Dissent/etc. — only the bare VO `name`
   * is carried; the renderer resolves the import MODULE via the shared
   * `valueObjectModuleSpecifier` (layout/package/extStyle-aware, identical to the
   * field's TS type + Zod schema). A single Postgres jsonb object column
   * (`array: false`) gets `.$type<VO>()`; an array of VOs held in one jsonb
   * column gets `.$type<VO[]>()`.
   */
  dollarTypeRef?:
    | { kind: "scalar"; tsType: "string" | "number" | "boolean"; array: boolean }
    | { kind: "objectRef"; name: string; array: boolean }
    // field.map → Record<string, V>: value is a scalar or a (hoisted) value-object.
    | { kind: "map"; value: { scalar: "string" | "number" | "boolean" } | { objectRef: string } };
}

/**
 * R6 Plan 2b: a physical @dbColumnType override selects the Drizzle COLUMN type
 * instead of the subtype default — mirroring the override-precedence shape in
 * migrate-ts/src/expected-schema.ts (override checked first, wins over the
 * subtype default), so codegen and DDL agree.
 *
 * Postgres-only: uuid/jsonb are Postgres physical column types with no native
 * SQLite analogue, so on SQLite the attribute is ignored (the caller falls
 * through to the subtype default). The native TS binding is keyed on
 * field.subType elsewhere and is unaffected — a `field.string @dbColumnType:uuid`
 * field stays a TS `string`; only the Drizzle column function changes.
 *
 * ADR-0036 Wave 2: the `timestamp_with_tz` value is retired — `field.timestamp`
 * is now instant/tz-aware BY DEFAULT (handled in the subtype switch below), and
 * the naive opt-out is the `@localTime` boolean, not a physical override.
 *
 * The loader has already validated the (subtype × value) pairing, so an
 * unrecognized value never reaches here; an unknown value returns undefined
 * (fall through to subtype default).
 */
function pgColumnTypeOverride(
  field: MetaField,
): { fnName: string; fnOptions?: Record<string, unknown> } | undefined {
  const dbColumnType = field.attr(FIELD_ATTR_DB_COLUMN_TYPE);
  if (typeof dbColumnType !== "string") return undefined;
  switch (dbColumnType) {
    case DB_COLUMN_TYPE_UUID:
      return { fnName: "uuid" };
    case DB_COLUMN_TYPE_JSONB:
      return { fnName: "jsonb" };
    default:
      return undefined;
  }
}

/** Resolve max length from validator.length child or @maxLength attr.
 *  Uses field.validators() (effective) so inherited validators are seen. */
function getMaxLength(field: MetaField): number | undefined {
  const lenAttr = field.attr(FIELD_ATTR_MAX_LENGTH);
  if (typeof lenAttr === "number") return lenAttr;
  for (const child of field.validators()) {
    if (child.subType === VALIDATOR_SUBTYPE_LENGTH) {
      // ADR-0039: resolving — a validator may inherit @max via extends.
      const max = child.attr(VALIDATOR_ATTR_MAX);
      if (typeof max === "number") return max;
    }
  }
  return undefined;
}

/** Check for validator.required child OR @required attr.
 *  Uses field.validators() (effective) so inherited validators are seen.
 *
 *  Exported because it is load-bearing for FR-035: this predicate drives the
 *  Drizzle column's `.notNull()` (below), and the SAME predicate must drive the
 *  Zod UpdateSchema's `.nullable()` exclusion (zod-validators.ts) — a non-required
 *  column is nullable in BOTH or the two disagree and `.set({field:null})` fails
 *  the typecheck / NOT NULL. Sharing one function keeps them aligned by construction. */
export function isRequired(field: MetaField): boolean {
  if (field.attr(FIELD_ATTR_REQUIRED) === true) return true;
  return field.validators().some((child) => child.subType === VALIDATOR_SUBTYPE_REQUIRED);
}

/**
 * #195 — a field whose value is derived by an origin.aggregate `@agg:any|all|collect`
 * is COALESCE-guaranteed non-null in the synthesized view (any→false, all→true,
 * collect→[]), so its read type is non-null even when the field is not `@required`.
 * Drives `.notNull()` below so the Drizzle view column AND the Zod read schema agree
 * (projection-decl derives its `.nullable()` from these modifiers). origin.first is
 * deliberately NOT here — an empty related set selects no row (→ null); origin.computed
 * nullability is expression-dependent, so it stays the conservative nullable default.
 */
export function originGuaranteedNonNull(field: MetaField): boolean {
  // ADR-0039: own — origin.* never inherits (ADR-0029), so own is correct.
  const origin = field
    .ownChildren()
    .find((c) => c.type === TYPE_ORIGIN && c.subType === ORIGIN_SUBTYPE_AGGREGATE);
  if (origin === undefined) return false;
  const agg = origin.ownAttr(ORIGIN_AGGREGATE_ATTR_AGG);
  return agg === AGG_ANY || agg === AGG_ALL || agg === AGG_COLLECT;
}

/** The bare (package-stripped) @objectRef name on a field.object, or undefined
 *  when unset. Used as the `.$type<VO>()` target + its sibling-module import.
 *  A fully-qualified ref (acme::ai::SourceLens) strips to the short name. */
function objectRefBaseName(field: MetaField): string | undefined {
  const ref = field.attr(FIELD_ATTR_OBJECT_REF);
  if (typeof ref === "string" && ref.length > 0) return stripPackage(ref);
  return undefined;
}

/** SCREAMING_SNAKE_CASE for a generated map const name. */
function screamingSnake(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toUpperCase();
}

/**
 * Build the customType descriptor for an int-backed `field.enum`, or undefined
 * when `@values` is missing (the field then degrades to a plain integer column
 * rather than emitting a codec over an unknown member set).
 *
 * Names are derived from the FIELD name, so the consts are per-entity-file and
 * self-contained. A shared enum consumed by N entities therefore emits N small
 * identical helpers rather than requiring a cross-module import — the same
 * self-contained tradeoff the per-entity enum union already makes.
 */
function buildEnumIntCustomType(
  field: MetaField,
  intByMember: Record<string, number>,
): EnumIntCustomType | undefined {
  const members = enumValues(field);
  if (members === undefined || members.length === 0) return undefined;
  // Every member must map — the loader pins key-set-equals-@values (Check 5b), so a
  // miss is unreachable; throwing beats emitting a codec with a hole in it.
  for (const m of members) {
    intValueForMember(intByMember, m, `customType codec for field '${field.name}'`);
  }
  const base = field.name.replace(/[^A-Za-z0-9]/g, "");
  const camel = base.charAt(0).toLowerCase() + base.slice(1);
  const screaming = screamingSnake(base);
  return {
    fnConstName: `${camel}IntEnum`,
    toIntConstName: `${screaming}_TO_INT`,
    fromIntConstName: `${screaming}_FROM_INT`,
    dataType: "integer",
    members,
    intByMember,
  };
}

export function mapColumnType(
  field: MetaField,
  dialect: Dialect,
  strategy: ColumnNamingStrategy = DEFAULT_COLUMN_NAMING_STRATEGY,
  timestampMode: "date" | "string" = "string",
): ColumnSpec {
  const dbName = field.column ?? columnNameFromField(field.name, strategy);
  const importModule = dialect === "sqlite" ? "drizzle-orm/sqlite-core" : "drizzle-orm/pg-core";
  const subType = field.subType;
  const isArray = field.resolvedIsArray();

  let fnName: string;
  let fnOptions: Record<string, unknown> | undefined;
  // Set only for an int-backed field.enum — see EnumIntCustomType.
  let enumIntCustomType: EnumIntCustomType | undefined;

  let leadingComment: string | undefined;
  if (dialect === "sqlite") {
    if (isArray) {
      // SQLite has no native array type; serialize as JSON in a text column.
      fnName = "text";
      fnOptions = { mode: "json" };
    } else {
      switch (subType) {
        case FIELD_SUBTYPE_BOOLEAN:
          fnName = "integer";
          fnOptions = { mode: "boolean" };
          break;
        case FIELD_SUBTYPE_INT:
        case FIELD_SUBTYPE_CURRENCY:
        case FIELD_SUBTYPE_LONG:
          fnName = "integer";
          break;
        case FIELD_SUBTYPE_DOUBLE:
        case FIELD_SUBTYPE_FLOAT:
          fnName = "real";
          break;
        case FIELD_SUBTYPE_DECIMAL:
          fnName = "text";
          // SQLite has no decimal type; the user must do precision math at the app
          // layer or migrate to Postgres. Surface this in the generated file so it
          // isn't a silent rounding hazard.
          leadingComment = "TODO: SQLite has no decimal type; stored as text. Convert at the application boundary or migrate to Postgres for native numeric.";
          break;
        case FIELD_SUBTYPE_OBJECT:
        case FIELD_SUBTYPE_MAP:
          // A nested object OR an open-keyed map is stored as a single JSON column.
          // SQLite has no native jsonb, so the idiomatic Drizzle form is
          // text(..., { mode: "json" }) — agreeing with migrate-ts/expected-schema
          // (field.object / field.map → { kind: "json" } → JSON on SQLite).
          fnName = "text";
          fnOptions = { mode: "json" };
          break;
        case FIELD_SUBTYPE_DATE:
        case FIELD_SUBTYPE_TIME:
        case FIELD_SUBTYPE_TIMESTAMP:
          // FIELD_SUBTYPE_TIMESTAMP deliberately ignores `timestampMode` here —
          // Drizzle's sqlite-core `text()` has no Date-typed column mode (only
          // pg-core's `timestamp()` does), so a bare string column is the only
          // correct output. Safe: `timestampMode` is normalized to "string" for
          // dialect === "sqlite" upstream, at the config choke points
          // (normalizeConfig / makeRenderContext) — this parameter is always
          // "string" by the time it reaches here for this dialect.
          fnName = "text";
          break;
        case FIELD_SUBTYPE_ENUM:
          // An INT-BACKED enum stores the mapped integer on SQLite too — SQLite has
          // one integer storage class, so this matches migrate-ts's integer{32}.
          {
            const im = intValueMapOf(field);
            if (im !== undefined) {
              enumIntCustomType = buildEnumIntCustomType(field, im);
              fnName = enumIntCustomType?.fnConstName ?? "integer";
            } else {
              fnName = "text";
            }
          }
          break;
        case FIELD_SUBTYPE_STRING:
        case FIELD_SUBTYPE_UUID:
        case FIELD_SUBTYPE_URI:
        case FIELD_SUBTYPE_INET:
          // SQLite has no native uuid/inet type; store as TEXT (string native binding).
          fnName = "text";
          break;
        default:
          fnName = "text";
          break;
      }
    }
  } else {
    // A physical @dbColumnType override wins over the subtype default (Postgres
    // only; SQLite has no native analogue and falls through above). Resolved
    // first so the override-precedence matches migrate-ts's expected-schema.
    const override = pgColumnTypeOverride(field);
    if (override !== undefined) {
      // Override fully determines the physical type; skip the subtype switch.
      fnName = override.fnName;
      fnOptions = override.fnOptions;
    } else {
      switch (subType) {
        case FIELD_SUBTYPE_BOOLEAN:
          fnName = "boolean";
          break;
        case FIELD_SUBTYPE_INT:
          fnName = "integer";
          break;
        case FIELD_SUBTYPE_CURRENCY:
        case FIELD_SUBTYPE_LONG:
          fnName = "bigint";
          fnOptions = { mode: "number" };
          break;
        case FIELD_SUBTYPE_DOUBLE:
          fnName = "doublePrecision";
          break;
        case FIELD_SUBTYPE_FLOAT:
          fnName = "real";
          break;
        case FIELD_SUBTYPE_DATE:
          fnName = "date";
          break;
        case FIELD_SUBTYPE_TIME:
          fnName = "time";
          break;
        case FIELD_SUBTYPE_TIMESTAMP:
          // ADR-0036 Wave 2: field.timestamp is instant / tz-aware BY DEFAULT →
          // timestamp({ withTimezone: true }) = timestamptz. A naive wall-clock
          // value opts out with @localTime:true → timestamp({ withTimezone:
          // false }) = `timestamp without time zone`.
          //
          // mode:"string" so the column round-trips ISO-8601 strings — the
          // generated Zod schema validates timestamp fields as z.string() and
          // the cross-port wire format carries timestamps as JSON strings.
          // Drizzle's default timestamp mode is "date" (expects/returns a JS
          // Date and calls value.toISOString() on write), which is internally
          // inconsistent with the string-typed schema + wire contract and
          // throws on a string write. See SP-B api-contract-generated lane.
          fnName = "timestamp";
          fnOptions = {
            mode: timestampMode,
            withTimezone: field.attr(FIELD_ATTR_LOCAL_TIME) !== true,
          };
          break;
        case FIELD_SUBTYPE_UUID:
          // Postgres native uuid column; native TS binding stays `string`.
          fnName = "uuid";
          break;
        case FIELD_SUBTYPE_URI:
          // ADR-0036/0037 Wave 3: Postgres has no uri type → text. Native TS
          // binding stays `string` (validated as a URL via Zod .url()).
          fnName = "text";
          break;
        case FIELD_SUBTYPE_INET:
          // ADR-0036/0037 Wave 3: Postgres-native `inet` column (Drizzle's
          // pg-core `inet()` infers as `string`). Native TS binding stays
          // `string` (validated as an IP via the Zod IP regex). #234: a
          // @lenient field.inet stores as `text` — the native `inet` column
          // would itself reject a not-strictly-valid value at INSERT, defeating
          // the opt-out.
          fnName = field.attr(FIELD_ATTR_LENIENT) === true ? "text" : "inet";
          break;
        case FIELD_SUBTYPE_DECIMAL: {
          // Drizzle pg `numeric` infers as a TS `string` (precision-exact); the
          // native TS binding for field.decimal is `string` to match. Read the
          // declared @precision/@scale (mirroring migrate-ts/expected-schema so
          // codegen and the DDL agree), falling back to a sane default.
          fnName = "numeric";
          const precision = field.attr(FIELD_ATTR_PRECISION);
          const scale = field.attr(FIELD_ATTR_SCALE);
          if (typeof precision === "number" && typeof scale === "number") {
            fnOptions = { precision, scale };
          } else if (typeof precision === "number") {
            fnOptions = { precision };
          } else {
            fnOptions = { precision: 19, scale: 4 };
          }
          break;
        }
        case FIELD_SUBTYPE_STRING: {
          const maxLen = getMaxLength(field);
          if (maxLen !== undefined) {
            fnName = "varchar";
            fnOptions = { length: maxLen };
          } else {
            fnName = "text";
          }
          break;
        }
        case FIELD_SUBTYPE_OBJECT:
        case FIELD_SUBTYPE_MAP:
          // A nested object OR an open-keyed map is stored as a single jsonb
          // column (field.object / field.map → JSONB), matching
          // migrate-ts/expected-schema. A map never gets native .array().
          fnName = "jsonb";
          break;
        case FIELD_SUBTYPE_ENUM:
          // An INT-BACKED enum (@intValueMap, design D5) stores the mapped integer,
          // so the Drizzle column is integer — matching migrate-ts's expected-schema.
          // The TS-facing type stays the member-string union; the symbol<->int
          // translation happens at the write/read boundary. Scalar only: D7 makes
          // @intValueMap + isArray ERR_ENUM_INT_VALUE_MAP_ARRAY at load, so an array
          // enum reaching here is always string-backed.
          {
            const im = intValueMapOf(field);
            if (im !== undefined) {
              enumIntCustomType = buildEnumIntCustomType(field, im);
              fnName = enumIntCustomType?.fnConstName ?? "integer";
            } else {
              fnName = "text";
            }
          }
          break;
        default:
          fnName = "text";
          break;
      }
    }
  }

  // Enum literal types: pass the values as `{ enum: [...] as const }` to
  // Drizzle's text(...) so the inferred column type is a literal union
  // ("a" | "b" | ...) instead of bare `string`. Skip when isArray — JSON
  // arrays use { mode: "json" }, and the enum members go through Zod
  // validation at the Insert/Update layer instead. Mirrors the Zod
  // emission, which already uses z.enum([...]).
  if (subType === FIELD_SUBTYPE_ENUM && !isArray && fnName === "text") {
    const values = enumValues(field);
    if (values !== undefined && values.length > 0) {
      fnOptions = { ...(fnOptions ?? {}), enum: values };
    }
  }

  const modifiers: string[] = [];

  // Postgres native arrays (text[]/integer[]/…) apply to SCALAR array fields
  // only. An object-typed field is stored as a single jsonb column holding the
  // JSON array (storage jsonb/subdocument), so it gets NO native .array() — the
  // array-ness is carried by the .$type<VO[]>() annotation computed below.
  if (dialect === "postgres" && isArray && subType !== FIELD_SUBTYPE_OBJECT && subType !== FIELD_SUBTYPE_MAP) {
    modifiers.push(".array()");
  }

  // SQLite stores arrays as JSON in a text column; Drizzle's text(...,{mode:"json"})
  // infers the column as `unknown` without a $type<T>() annotation. Emit the
  // chain via spec.dollarTypeRef so the renderer can hoist a type-only import
  // for object refs (SourceLens[], Dissent[], etc.). Scalars (string/number/
  // boolean) need no import. Postgres uses .array() above which is already
  // element-typed by Drizzle.
  // Determined ABOVE the modifiers chain so the renderer can position
  // `.$type<>()` ahead of `.notNull()` etc.
  // Note: dollarTypeRef is read alongside (and rendered ahead of) `modifiers`
  // by `renderColumn` — see drizzle-schema.ts.

  if (isRequired(field) || originGuaranteedNonNull(field)) {
    modifiers.push(".notNull()");
  }

  if (field.attr(FIELD_ATTR_UNIQUE) === true) {
    modifiers.push(".unique()");
  }

  let defaultExpr: DefaultExpr | undefined;
  const defaultAttr = field.attr(FIELD_ATTR_DEFAULT);
  if (defaultAttr !== undefined) {
    // SQL-expression detection runs on the raw string value — a string like
    // "CURRENT_TIMESTAMP" or "now" must be emitted as sql`...`, not a literal.
    if (typeof defaultAttr === "string" && isSqlExprDefault(defaultAttr)) {
      const canonical = canonicalizeSqlExpr(defaultAttr);
      // "now"/"CURRENT_TIMESTAMP" gets the dialect-aware emit path (defaultNow for postgres);
      // other SQL keywords go through the generic sqlExpr emit.
      if (canonical === "CURRENT_TIMESTAMP") {
        defaultExpr = { kind: "now" };
      } else {
        defaultExpr = { kind: "sqlExpr", raw: canonical };
      }
    } else if (
      isArray &&
      subType !== FIELD_SUBTYPE_OBJECT &&
      subType !== FIELD_SUBTYPE_MAP &&
      typeof defaultAttr === "string"
    ) {
      // Array branch (scalar element arrays only). The column is a native
      // Postgres array (.array()) or a sqlite json-mode text column typed
      // .$type<E[]>() — BOTH want a JS array default, not the raw @default
      // string ("{}" / "[]" / "{a,b}"), which fails `tsc` (TS2345). Parse the
      // string into element literals; on an unsupported shape, fall back to a
      // raw sql`...` cast so the emitted default ALWAYS typechecks.
      const numericElements = sqliteJsonArrayElementTsType(subType) === "number"
        || sqliteJsonArrayElementTsType(subType) === "boolean";
      const elements = parseArrayDefault(defaultAttr, numericElements);
      if (elements !== undefined) {
        defaultExpr = { kind: "arrayLiteral", elements };
      } else {
        // Unparseable — emit the raw metadata string as a typed SQL cast. The
        // dialect-specific SQL is resolved in the template (postgres needs a
        // ::type[] cast; sqlite json takes the raw string).
        defaultExpr = { kind: "sqlExpr", raw: defaultAttr };
      }
    } else {
      // Literal branch: use the field-type-converted value so booleans/numbers
      // are real JS booleans/numbers (not strings). field.defaultValue() applies
      // convertToDataType(field.dataType, raw) — Java parity with getDefaultValue().
      // JSON.stringify(false) → "false", JSON.stringify(0) → "0" (unquoted) in templates.
      const typedValue = field.defaultValue() ?? defaultAttr;
      defaultExpr = { kind: "literal", value: typedValue };
    }
  }

  // jsonb / JSON-in-text columns infer as `unknown` in Drizzle without a
  // .$type<>() annotation. Carry the logical TS type so the column is typed:
  //  - SQLite isArray: arrays serialize as JSON-in-text → .$type<E[]>() (scalar
  //    element type, or the @objectRef VO for object arrays).
  //  - Postgres field.object: a single jsonb column → .$type<VO>(), or
  //    .$type<VO[]>() when isArray (the JSON array lives in the one column; no
  //    native .array() is emitted for object storage — see modifiers above).
  //    Scalar Postgres arrays use native .array() (already element-typed by
  //    Drizzle) so they need no $type.
  let dollarTypeRef: ColumnSpec["dollarTypeRef"];
  if (subType === FIELD_SUBTYPE_MAP) {
    // Open-keyed map → Record<string, V> on both dialects. The value type is a
    // VO (@objectRef) or a scalar (@valueType, defaulting to string).
    const vo = objectRefBaseName(field);
    if (vo !== undefined) {
      dollarTypeRef = { kind: "map", value: { objectRef: vo } };
    } else {
      const vt = field.attr(FIELD_ATTR_VALUE_TYPE);
      const scalar = typeof vt === "string" ? sqliteJsonArrayElementTsType(vt) : undefined;
      dollarTypeRef = { kind: "map", value: { scalar: (scalar ?? "string") as "string" | "number" | "boolean" } };
    }
  } else if (dialect === "sqlite" && isArray) {
    if (subType === FIELD_SUBTYPE_OBJECT) {
      const base = objectRefBaseName(field);
      if (base !== undefined) {
        dollarTypeRef = { kind: "objectRef", name: base, array: true };
      }
    } else {
      const scalar = sqliteJsonArrayElementTsType(subType);
      if (scalar !== undefined) {
        dollarTypeRef = { kind: "scalar", tsType: scalar as "string" | "number" | "boolean", array: true };
      }
    }
  } else if (dialect === "postgres" && subType === FIELD_SUBTYPE_OBJECT) {
    const base = objectRefBaseName(field);
    if (base !== undefined) {
      dollarTypeRef = { kind: "objectRef", name: base, array: isArray };
    }
  }

  const result: ColumnSpec = {
    fnName,
    dbName,
    fnArgs: [],
    modifiers,
    importModule,
  };
  if (fnOptions !== undefined) result.fnOptions = fnOptions;
  if (defaultExpr !== undefined) result.defaultExpr = defaultExpr;
  if (enumIntCustomType !== undefined) result.enumIntCustomType = enumIntCustomType;
  if (dollarTypeRef !== undefined) result.dollarTypeRef = dollarTypeRef;
  if (leadingComment !== undefined) result.leadingComment = leadingComment;

  // Enum fields: emit a CHECK constraint listing the valid member values.
  if (subType === FIELD_SUBTYPE_ENUM && !isArray) {
    const values = enumValues(field);
    if (values !== undefined && values.length > 0) {
      const intMap = intValueMapOf(field);
      let list: string;
      if (intMap !== undefined) {
        // Int-backed: the column holds integers, so the CHECK lists them unquoted.
        // Keyed BY MEMBER through the map (not Object.values) so the constraint can
        // never disagree with @values, which stays the SSOT. Must match
        // migrate-ts's buildChecks exactly or `meta verify` reports permanent drift.
        list = values
          .map((v) => String(intValueForMember(intMap, v, `CHECK for column '${dbName}'`)))
          .join(", ");
      } else {
        // Single-quote escaping is belt-and-suspenders: the loader's
        // ENUM_MEMBER_PATTERN already rejects quote-bearing members (members are
        // validated to be identifier-safe), so this never fires in practice.
        list = values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ");
      }
      result.checkConstraint = `${dbName} IN (${list})`;
    }
  }

  return result;
}
