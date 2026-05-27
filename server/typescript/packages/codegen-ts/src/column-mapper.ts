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
  FIELD_SUBTYPE_CLASS,
  FIELD_SUBTYPE_ENUM,
  VALIDATOR_SUBTYPE_REQUIRED,
  VALIDATOR_SUBTYPE_LENGTH,
  FIELD_ATTR_MAX_LENGTH,
  FIELD_ATTR_REQUIRED,
  FIELD_ATTR_UNIQUE,
  FIELD_ATTR_DEFAULT,
  VALIDATOR_ATTR_MAX,
} from "@metaobjectsdev/metadata";
import { columnNameFromField } from "./naming.js";
import { enumValues } from "./enum-meta.js";
import { DEFAULT_COLUMN_NAMING_STRATEGY } from "@metaobjectsdev/metadata";
import type { Dialect, ColumnNamingStrategy } from "./metaobjects-config.js";

export type { Dialect };

/**
 * Discriminated union describing how a column default should be emitted.
 * - { kind: "now" }            — dialect-aware: sql`CURRENT_TIMESTAMP` (sqlite) or .defaultNow() (postgres)
 * - { kind: "sqlExpr"; raw }   — raw SQL expression wrapped in sql`...` (CURRENT_DATE, CURRENT_TIME, function calls)
 * - { kind: "literal"; value } — .default(JSON.stringify(value))
 */
export type DefaultExpr =
  | { kind: "now" }
  | { kind: "sqlExpr"; raw: string }
  | { kind: "literal"; value: unknown };

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
    case FIELD_SUBTYPE_CLASS:
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

export interface ColumnSpec {
  /** Drizzle function name, e.g., "text", "integer", "varchar". */
  fnName: string;
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
}

/** Resolve max length from validator.length child or @maxLength attr.
 *  Uses field.validators() (effective) so inherited validators are seen. */
function getMaxLength(field: MetaField): number | undefined {
  const lenAttr = field.ownAttr(FIELD_ATTR_MAX_LENGTH);
  if (typeof lenAttr === "number") return lenAttr;
  for (const child of field.validators()) {
    if (child.subType === VALIDATOR_SUBTYPE_LENGTH) {
      const max = child.ownAttr(VALIDATOR_ATTR_MAX);
      if (typeof max === "number") return max;
    }
  }
  return undefined;
}

/** Check for validator.required child OR @required attr.
 *  Uses field.validators() (effective) so inherited validators are seen. */
function isRequired(field: MetaField): boolean {
  if (field.ownAttr(FIELD_ATTR_REQUIRED) === true) return true;
  return field.validators().some((child) => child.subType === VALIDATOR_SUBTYPE_REQUIRED);
}

export function mapColumnType(
  field: MetaField,
  dialect: Dialect,
  strategy: ColumnNamingStrategy = DEFAULT_COLUMN_NAMING_STRATEGY,
): ColumnSpec {
  const dbName = field.column ?? columnNameFromField(field.name, strategy);
  const importModule = dialect === "sqlite" ? "drizzle-orm/sqlite-core" : "drizzle-orm/pg-core";
  const subType = field.subType;
  const isArray = field.isArray;

  let fnName: string;
  let fnOptions: Record<string, unknown> | undefined;

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
        case FIELD_SUBTYPE_DATE:
        case FIELD_SUBTYPE_TIME:
        case FIELD_SUBTYPE_TIMESTAMP:
        case FIELD_SUBTYPE_STRING:
        case FIELD_SUBTYPE_ENUM:
        case FIELD_SUBTYPE_CLASS:
        case FIELD_SUBTYPE_OBJECT:
        default:
          fnName = "text";
          break;
      }
    }
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
        fnName = "timestamp";
        break;
      case FIELD_SUBTYPE_DECIMAL:
        fnName = "numeric";
        fnOptions = { precision: 19, scale: 4 }; // sane default; @precision/@scale attrs override
        break;
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
      case FIELD_SUBTYPE_ENUM:
      case FIELD_SUBTYPE_CLASS:
      case FIELD_SUBTYPE_OBJECT:
      default:
        fnName = "text";
        break;
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

  if (dialect === "postgres" && isArray) {
    modifiers.push(".array()");
  }

  // SQLite stores arrays as JSON in a text column; Drizzle's text(...,{mode:"json"})
  // infers the column as `unknown` without a $type<T>() annotation, so consumers
  // who pull the inferred type can't see the element type. Emit $type<E[]>()
  // so the inferred TS type is element-precise. Postgres uses .array() above
  // which is already element-typed by Drizzle.
  if (dialect === "sqlite" && isArray) {
    const elementType = sqliteJsonArrayElementTsType(subType);
    if (elementType !== undefined) {
      modifiers.push(`.$type<${elementType}[]>()`);
    }
  }

  if (isRequired(field)) {
    modifiers.push(".notNull()");
  }

  if (field.ownAttr(FIELD_ATTR_UNIQUE) === true) {
    modifiers.push(".unique()");
  }

  let defaultExpr: DefaultExpr | undefined;
  const defaultAttr = field.ownAttr(FIELD_ATTR_DEFAULT);
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
    } else {
      // Literal branch: use the field-type-converted value so booleans/numbers
      // are real JS booleans/numbers (not strings). field.defaultValue() applies
      // convertToDataType(field.dataType, raw) — Java parity with getDefaultValue().
      // JSON.stringify(false) → "false", JSON.stringify(0) → "0" (unquoted) in templates.
      const typedValue = field.defaultValue() ?? defaultAttr;
      defaultExpr = { kind: "literal", value: typedValue };
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
  if (leadingComment !== undefined) result.leadingComment = leadingComment;

  // Enum fields: emit a CHECK constraint listing the valid member values.
  if (subType === FIELD_SUBTYPE_ENUM && !isArray) {
    const values = enumValues(field);
    if (values !== undefined && values.length > 0) {
      // Single-quote escaping is belt-and-suspenders: the loader's
      // ENUM_MEMBER_PATTERN already rejects quote-bearing members (members are
      // validated to be identifier-safe), so this never fires in practice.
      const list = values
        .map((v) => `'${v.replace(/'/g, "''")}'`)
        .join(", ");
      result.checkConstraint = `${dbName} IN (${list})`;
    }
  }

  return result;
}
