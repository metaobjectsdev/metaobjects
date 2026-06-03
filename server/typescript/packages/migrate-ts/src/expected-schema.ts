import type { ColumnNamingStrategy, MetaData, MetaObject, MetaRoot, MetaValidator } from "@metaobjectsdev/metadata";
import {
  VALIDATOR_SUBTYPE_NUMERIC, VALIDATOR_SUBTYPE_LENGTH, VALIDATOR_SUBTYPE_REGEX,
  VALIDATOR_ATTR_PATTERN,
  TYPE_OBJECT,
  MetaSource,
  IDENTITY_ATTR_GENERATION,
  IDENTITY_ATTR_UNIQUE,
  FIELD_ATTR_DEFAULT,
  FIELD_ATTR_MAX_LENGTH,
  FIELD_ATTR_PRECISION,
  FIELD_ATTR_SCALE,
  FIELD_ATTR_UNIQUE,
  FIELD_SUBTYPE_STRING,
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_LONG,
  FIELD_SUBTYPE_DOUBLE,
  FIELD_SUBTYPE_FLOAT,
  FIELD_SUBTYPE_DECIMAL,
  FIELD_SUBTYPE_BOOLEAN,
  FIELD_SUBTYPE_CURRENCY,
  FIELD_SUBTYPE_DATE,
  FIELD_SUBTYPE_TIME,
  FIELD_SUBTYPE_TIMESTAMP,
  FIELD_SUBTYPE_OBJECT,
  FIELD_SUBTYPE_UUID,
  FIELD_SUBTYPE_ENUM,
  FIELD_ATTR_VALUES,
  FIELD_ATTR_OBJECT_REF,
  FIELD_ATTR_STORAGE,
  FIELD_ATTR_DB_COLUMN_TYPE,
  DB_COLUMN_TYPE_UUID,
  DB_COLUMN_TYPE_JSONB,
  DB_COLUMN_TYPE_TIMESTAMP_WITH_TZ,
  STORAGE_FLATTENED,
  DOC_ATTR_DESCRIPTION,
  applyColumnNamingStrategy, DEFAULT_COLUMN_NAMING_STRATEGY,
  resolveTableName, resolveColumnName, resolveTableSchema,
} from "@metaobjectsdev/metadata";
import type { SqlType } from "./sql-type.js";
import type {
  Dialect, SchemaSnapshot, TableDescriptor, ColumnDescriptor, IndexDescriptor, FkDescriptor,
  CheckDescriptor,
} from "./types.js";
import { buildExpectedViews } from "./expected-views.js";
import {
  resolveReferentialActions,
  validateSetNullNullability,
  readIdentityFields,
  findField,
  isRequired,
} from "./referential-actions.js";

export interface BuildExpectedSchemaOptions {
  /**
   * If set, normalize column SqlTypes for the target dialect so the diff
   * matches what introspection will see. For sqlite (and d1, which is SQLite
   * at the SQL level) this collapses boolean → integer{64} and
   * timestamp/date/time → text, since sqlite has no native boolean/timestamp
   * affinity and Drizzle's `integer(..., {mode:"boolean"})` / `text("ts")`
   * patterns produce INTEGER / TEXT in the actual DB.
   */
  dialect?: Dialect;
  /**
   * Column-naming strategy for fields with no `@column` override. Defaults to
   * `"snake_case"`. Must match the runtime's `ObjectManager` strategy — a
   * mismatch yields a schema whose columns the runtime can't address.
   */
  columnNamingStrategy?: ColumnNamingStrategy;
}

export function buildExpectedSchema(
  root: MetaData,
  opts?: BuildExpectedSchemaOptions,
): SchemaSnapshot {
  // D1 is SQLite at the SQL level; normalize it so downstream dialect checks
  // don't need to handle "d1" separately.
  const dialect = opts?.dialect === "d1" ? "sqlite" : opts?.dialect;
  const strategy: ColumnNamingStrategy = opts?.columnNamingStrategy ?? DEFAULT_COLUMN_NAMING_STRATEGY;

  // Pass 1: collect entities + their resolved table names.
  // Skip:
  //   - abstract objects (e.g., BaseEntity)
  //   - value objects (no table backing)
  //   - projections (read-only @kind source with no writable peer — handled by
  //     the view-diff pipeline, not the table diff)
  const entities: { entity: MetaObject; tableName: string }[] = [];
  for (const child of root.ownChildren()) {
    if (child.type !== TYPE_OBJECT) continue;
    if (child.isAbstract) continue;
    if (child.subType === "value") continue;
    const hasReadOnlySource = child.ownChildren().some(
      (c) => c instanceof MetaSource && c.isReadOnly(),
    );
    const hasWritableSource = child.ownChildren().some(
      (c) => c instanceof MetaSource && c.isWritable(),
    );
    // Projection: read-only and not write-through.
    if (hasReadOnlySource && !hasWritableSource) continue;
    entities.push({ entity: child as MetaObject, tableName: resolveTableName(child) });
  }
  const entityToTable = new Map(entities.map((e) => [e.entity.name, e.tableName]));
  const resolveTargetTable = (entityName: string) => entityToTable.get(entityName);

  // Pass 2: build full descriptors with FK resolution.
  // Schema is resolved here (not stored in Pass 1) to avoid exactOptionalPropertyTypes
  // issues with `string | undefined` vs `schema?: string`.
  const tables: TableDescriptor[] = entities.map(({ entity, tableName }) => {
    const t = buildTable(entity, tableName, resolveTargetTable, root as MetaRoot, strategy, dialect);
    const schema = resolveTableSchema(entity);
    if (schema !== undefined) t.schema = schema;
    return t;
  });

  // Pass 3: dialect-specific SqlType normalization.
  if (dialect === "sqlite") {
    for (const table of tables) {
      for (const col of table.columns) {
        col.sqlType = normalizeForSqlite(col.sqlType);
      }
    }
  }

  // Dialect validation: SQLite has no schema concept; reject any non-default @schema.
  if (dialect === "sqlite") {
    for (const table of tables) {
      if (table.schema !== undefined) {
        throw new Error(
          `sqlite does not support DB schemas; entity-table "${table.name}" declares @schema "${table.schema}"`,
        );
      }
    }
  }

  // Pass 4: views from read-only projections. Built regardless of dialect so
  // the diff produces correct create-view changes; emit() refuses them for
  // sqlite/d1 with a clear error ("view migration not implemented for ...").
  const views = buildExpectedViews(root as MetaRoot, strategy);

  return { tables, views };
}

/**
 * Normalize a canonical SqlType for what sqlite introspection will actually see.
 * sqlite stores all integers (including booleans) as INTEGER, and uses TEXT for
 * date/time/timestamp affinities by default.
 */
function normalizeForSqlite(sqlType: SqlType): SqlType {
  switch (sqlType.kind) {
    case "boolean":
      return { kind: "integer", bits: 64 };
    case "timestamp":
    case "date":
    case "time":
      return { kind: "text" };
    case "integer":
      // SQLite stores every INTEGER as a 64-bit value and Drizzle's int() emits
      // plain "INTEGER" regardless of source bit-width. Collapse 32 → 64 so the
      // expected snapshot matches what introspection sees.
      return { kind: "integer", bits: 64 };
    case "real4":
      // SQLite has a single float storage class ("REAL"); it cannot distinguish
      // single-precision (real4 / field.float) from double-precision (real /
      // field.double). Collapse real4 → real so the expected snapshot matches
      // what the SQLite introspector produces, preventing a phantom
      // change-column-type diff on every field.float column.
      return { kind: "real" };
    case "uuid":
      // SQLite has no native uuid type; uuid values are stored as TEXT (the
      // conformance corpus is Postgres-only, but TS supports a sqlite dialect).
      // Collapse uuid → text so the expected snapshot matches what the SQLite
      // introspector produces, preventing a phantom change-column-type diff.
      return { kind: "text" };
    default:
      return sqlType;
  }
}

function buildTable(
  entity: MetaObject,
  tableName: string,
  resolveTargetTable: (entityName: string) => string | undefined,
  root: MetaRoot,
  strategy: ColumnNamingStrategy,
  dialect: Dialect | undefined,
): TableDescriptor {
  // Use effective accessors so inherited fields/identities (from `extends:` /
  // abstract bases like BaseEntity) are included.
  const pkIdentity = entity.primaryIdentity();

  const pkJsNames = pkIdentity ? readIdentityFields(pkIdentity) : [];
  const pkGeneration = pkIdentity
    ? (pkIdentity.ownAttr(IDENTITY_ATTR_GENERATION) as string | undefined)
    : undefined;

  const primaryKey = pkJsNames.map((jsName) => {
    const field = findField(entity, jsName);
    return field ? resolveColumnName(field, strategy) : applyColumnNamingStrategy(jsName, strategy);
  });

  const columns: ColumnDescriptor[] = [];
  for (const field of entity.fields()) {
    const isPk = pkJsNames.includes(field.name);
    if (
      field.subType === FIELD_SUBTYPE_OBJECT &&
      field.ownAttr(FIELD_ATTR_STORAGE) === STORAGE_FLATTENED
    ) {
      // Flattened storage: expand nested value-object fields as prefixed columns.
      // The parent field.object itself does NOT produce its own column.
      columns.push(...flattenObjectField(field, root, strategy));
    } else {
      columns.push(buildColumn(field, isPk, isPk ? pkGeneration : undefined, strategy));
    }
  }

  const descriptor: TableDescriptor = {
    name: tableName,
    columns,
    indexes: buildSecondaryIndexes(entity, tableName, strategy),
    foreignKeys: buildForeignKeys(entity, tableName, resolveTargetTable, root, strategy),
    checks: buildChecks(entity, tableName, strategy, dialect),
    primaryKey,
  };
  const entityDesc = readDescription(entity);
  if (entityDesc !== undefined) descriptor.description = entityDesc;
  return descriptor;
}

/**
 * Read effective `description` attr from a node. Returns the string if present
 * and non-empty, undefined otherwise. Uses `.attr` (effective, not own) so a
 * node that extends an abstract base picks up the base's description — required
 * for both entity- and field-level COMMENT ON parity with the entity-attr contract.
 */
function readDescription(node: { attr: (n: string) => unknown }): string | undefined {
  const v = node.attr(DOC_ATTR_DESCRIPTION);
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function buildSecondaryIndexes(
  entity: MetaObject, tableName: string, strategy: ColumnNamingStrategy,
): IndexDescriptor[] {
  const indexes: IndexDescriptor[] = [];

  // (a) Implicit unique indexes from @unique fields. Drizzle auto-creates these
  // on the DB side using the convention `<table>_<column>_unique` whenever a
  // column has `.unique()`. We mirror them in the expected schema so the diff
  // doesn't see them as drop-only on the actual side.
  for (const field of entity.fields()) {
    if (field.ownAttr(FIELD_ATTR_UNIQUE) !== true) continue;
    const colName = resolveColumnName(field, strategy);
    indexes.push({
      name: `${tableName}_${colName}_unique`,
      columns: [colName],
      unique: true,
    });
  }

  // (b) Explicit secondary identities — unique-by-default, opt out with @unique: false.
  // Drizzle emits the index using the identity's @name attr directly (no table
  // prefix), so the expected name must match.
  for (const identity of entity.secondaryIdentities()) {
    const fieldNames = readIdentityFields(identity);
    if (fieldNames.length === 0) continue;
    const cols = fieldNames.map((jsName) => {
      const field = findField(entity, jsName);
      return field ? resolveColumnName(field, strategy) : applyColumnNamingStrategy(jsName, strategy);
    });
    const uniqueAttr = identity.ownAttr(IDENTITY_ATTR_UNIQUE);
    indexes.push({
      name: identity.name,
      columns: cols,
      unique: uniqueAttr !== false,
    });
  }
  return indexes;
}

/**
 * Derive a CHECK constraint per `field.enum` field: `CHECK (<col> IN ('A', 'B'))`,
 * constraining the column to the declared `@values` members. The constraint name
 * is `<table>_<column>_chk`, mirroring the FK/index naming conventions.
 *
 * `@values` is read effective (`field.attr`) so a concrete field that extends an
 * abstract `field.enum` super inherits its members. The loader rejects a
 * `field.enum` without `@values` (ERR_MISSING_REQUIRED_ATTR), so a present enum
 * field always yields a non-empty member set; a defensive guard skips any edge
 * case where the array is absent rather than emitting `IN ()`.
 */
/**
 * Map a single declared validator to a DB CHECK descriptor, or null when it has
 * no SQL-expressible form on this dialect. The constraint name is
 * `<table>_<col>_<validator>_chk`. The expression references the resolved physical
 * column name verbatim (matching the enum-check convention).
 */
function validatorCheck(
  v: MetaValidator, qcol: string, tableName: string, col: string, dialect: Dialect | undefined,
): CheckDescriptor | null {
  switch (v.subType) {
    case VALIDATOR_SUBTYPE_NUMERIC: {
      const parts: string[] = [];
      if (v.min !== undefined) parts.push(`${qcol} >= ${v.min}`);
      if (v.max !== undefined) parts.push(`${qcol} <= ${v.max}`);
      if (parts.length === 0) return null;
      return { name: `${tableName}_${col}_numeric_chk`, expression: parts.join(" AND ") };
    }
    case VALIDATOR_SUBTYPE_LENGTH: {
      const parts: string[] = [];
      if (v.min !== undefined) parts.push(`length(${qcol}) >= ${v.min}`);
      if (v.max !== undefined) parts.push(`length(${qcol}) <= ${v.max}`);
      if (parts.length === 0) return null;
      return { name: `${tableName}_${col}_length_chk`, expression: parts.join(" AND ") };
    }
    case VALIDATOR_SUBTYPE_REGEX: {
      // Postgres-only: SQLite has no native regex operator.
      if (dialect === "sqlite" || dialect === "d1") return null;
      const pattern = v.ownAttr(VALIDATOR_ATTR_PATTERN);
      if (typeof pattern !== "string" || pattern.length === 0) return null;
      return {
        name: `${tableName}_${col}_regex_chk`,
        expression: `${qcol} ~ '${pattern.replace(/'/g, "''")}'`,
      };
    }
    default:
      return null;
  }
}

/**
 * Quote a column identifier for embedding in a CHECK expression. Both Postgres
 * and SQLite quote identifiers with double-quotes, so the dialect-neutral
 * expression text can carry a quoted column. Quoting is REQUIRED for a
 * mixed-case column (e.g. `enumVal`): a bare `enumVal IN (...)` folds to
 * lowercase `enumval` and references a non-existent column. The check-expression
 * comparator (`normalizeCheckExpr`) strips quotes so an introspected check still
 * compares equal.
 */
function quoteCheckCol(col: string): string {
  return `"${col.replace(/"/g, '""')}"`;
}

function buildChecks(
  entity: MetaObject, tableName: string, strategy: ColumnNamingStrategy, dialect: Dialect | undefined,
): CheckDescriptor[] {
  const checks: CheckDescriptor[] = [];
  for (const field of entity.fields()) {
    const col = resolveColumnName(field, strategy);
    const qcol = quoteCheckCol(col);
    // Enum membership check.
    if (field.subType === FIELD_SUBTYPE_ENUM) {
      const raw = field.attr(FIELD_ATTR_VALUES);
      if (Array.isArray(raw) && raw.length > 0) {
        const values = raw.map((v) => String(v));
        const expression = `${qcol} IN (${values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ")})`;
        checks.push({ name: `${tableName}_${col}_chk`, expression });
      }
    }
    // Validator-derived checks.
    for (const v of field.validators()) {
      const check = validatorCheck(v, qcol, tableName, col, dialect);
      if (check) checks.push(check);
    }
  }
  return checks;
}

function buildForeignKeys(
  entity: MetaObject,
  tableName: string,
  resolveTargetTable: (entityName: string) => string | undefined,
  root: MetaRoot,
  strategy: ColumnNamingStrategy,
): FkDescriptor[] {
  const fks: FkDescriptor[] = [];
  for (const refChild of entity.referenceIdentities()) {
    // @enforce: false → logical-only reference; not a physical FK constraint.
    if (!refChild.enforce) continue;
    const targetEntity = refChild.targetEntity;
    if (targetEntity === undefined) continue;
    const refTable = resolveTargetTable(targetEntity);
    if (!refTable) continue;

    const fkFieldJsNames = readIdentityFields(refChild);
    if (fkFieldJsNames.length === 0) continue;

    const fkCols = fkFieldJsNames.map((jsName) => {
      const fkField = findField(entity, jsName);
      return fkField ? resolveColumnName(fkField, strategy) : applyColumnNamingStrategy(jsName, strategy);
    });

    // Target columns: prefer explicit multi-field dotted form, else delegate
    // to MetaReferenceIdentity.resolvedTargetPkField (single field → target's
    // primary identity → "id" fallback).
    const explicitTargetFields = refChild.targetFields;
    const refColumns = explicitTargetFields.length > 1
      ? explicitTargetFields.map((n) => applyColumnNamingStrategy(n, strategy))
      : [applyColumnNamingStrategy(refChild.resolvedTargetPkField(root) ?? "id", strategy)];

    const { onDelete, onUpdate } = resolveReferentialActions(entity, refChild);
    const constraintName = `${tableName}_${fkCols[0]}_fk`;

    // Guard: ON DELETE SET NULL requires nullable FK columns.
    validateSetNullNullability(entity, refChild, onDelete, constraintName);

    const fk: FkDescriptor = {
      name: constraintName,
      columns: fkCols,
      refTable,
      refColumns,
    };
    if (onDelete !== undefined) fk.onDelete = onDelete;
    if (onUpdate !== undefined) fk.onUpdate = onUpdate;
    fks.push(fk);
  }
  return fks;
}

/**
 * Expand a `field.object @storage "flattened"` into one ColumnDescriptor per
 * nested field of the referenced value-object, prefixed by the parent field's
 * resolved column name + underscore.
 *
 * EF OwnsOne pattern: no JSON column for the parent itself; each nested field
 * becomes `<parent_col>_<nested_col>` in the owning entity's table.
 */
function flattenObjectField(
  field: MetaData, root: MetaRoot, strategy: ColumnNamingStrategy,
): ColumnDescriptor[] {
  const ref = field.ownAttr(FIELD_ATTR_OBJECT_REF);
  if (typeof ref !== "string" || ref.length === 0) return [];
  const targetObject = root.findObject(ref);
  if (targetObject === undefined) return [];
  const prefix = resolveColumnName(field, strategy) + "_";
  const cols: ColumnDescriptor[] = [];
  for (const nested of targetObject.fields()) {
    const inner = buildColumn(nested, /* isPk */ false, /* pkGeneration */ undefined, strategy);
    cols.push({ ...inner, name: prefix + inner.name });
  }
  return cols;
}

const EXPR_DEFAULT_PATTERNS = [
  /^current_timestamp$/i,
  /^now\(\)$/i,
  /^current_date$/i,
  /^current_time$/i,
  /\(\)/,                             // anything function-like
];

function buildColumn(
  field: MetaData,
  isPk: boolean,
  pkGeneration: string | undefined,
  strategy: ColumnNamingStrategy,
): ColumnDescriptor {
  // Both the @required attr and the validator.required child signal NOT NULL.
  const fieldIsRequired = isRequired(field);
  const defaultRaw = field.ownAttr(FIELD_ATTR_DEFAULT);

  const col: ColumnDescriptor = {
    name: resolveColumnName(field, strategy),
    sqlType: subtypeToSqlType(field),
    nullable: !isPk && !fieldIsRequired,
  };

  if (typeof defaultRaw === "string" && defaultRaw.length > 0) {
    const isExpr = EXPR_DEFAULT_PATTERNS.some((re) => re.test(defaultRaw));
    col.default = { kind: isExpr ? "expr" : "literal", value: defaultRaw };
  } else if (typeof defaultRaw === "boolean" || typeof defaultRaw === "number") {
    col.default = { kind: "literal", value: String(defaultRaw) };
  }

  if (isPk && (pkGeneration === "increment" || pkGeneration === "uuid")) {
    col.identity = pkGeneration;
  }

  const fieldDesc = readDescription(field);
  if (fieldDesc !== undefined) col.description = fieldDesc;

  return col;
}

function subtypeToSqlType(field: MetaData): SqlType {
  // R6 Plan 2b: a physical @dbColumnType override selects the DB column type
  // instead of the subtype default (the loader has already validated the
  // (subtype × value) pairing, so an unrecognized value never reaches here).
  const dbColumnType = field.ownAttr(FIELD_ATTR_DB_COLUMN_TYPE);
  if (typeof dbColumnType === "string") {
    switch (dbColumnType) {
      case DB_COLUMN_TYPE_UUID:              return { kind: "uuid" };
      case DB_COLUMN_TYPE_JSONB:             return { kind: "json" };
      case DB_COLUMN_TYPE_TIMESTAMP_WITH_TZ: return { kind: "timestamp", withTimezone: true };
    }
  }

  const subType = field.subType;
  switch (subType) {
    case FIELD_SUBTYPE_STRING:    {
      // @maxLength is declared as ATTR_SUBTYPE_INT so the loader coerces it to a number.
      const m = field.ownAttr(FIELD_ATTR_MAX_LENGTH);
      return typeof m === "number" ? { kind: "text", maxLength: m } : { kind: "text" };
    }
    case FIELD_SUBTYPE_INT:       return { kind: "integer", bits: 32 };
    case FIELD_SUBTYPE_LONG:
    case FIELD_SUBTYPE_CURRENCY:  return { kind: "integer", bits: 64 };
    case FIELD_SUBTYPE_DOUBLE:    return { kind: "real" };
    case FIELD_SUBTYPE_FLOAT:     return { kind: "real4" };
    case FIELD_SUBTYPE_DECIMAL:   {
      // @precision/@scale are declared as ATTR_SUBTYPE_INT so the loader coerces them
      // to numbers. Both present → NUMERIC(p,s); absent → bare NUMERIC (back-compat).
      const precision = field.ownAttr(FIELD_ATTR_PRECISION);
      const scale = field.ownAttr(FIELD_ATTR_SCALE);
      if (typeof precision === "number" && typeof scale === "number") {
        return { kind: "numeric", precision, scale };
      }
      if (typeof precision === "number") {
        return { kind: "numeric", precision };
      }
      return { kind: "numeric" };
    }
    case FIELD_SUBTYPE_BOOLEAN:   return { kind: "boolean" };
    case FIELD_SUBTYPE_DATE:      return { kind: "date" };
    case FIELD_SUBTYPE_TIME:      return { kind: "time" }; // Postgres native TIME (whole-second wire form)
    case FIELD_SUBTYPE_TIMESTAMP: return { kind: "timestamp", withTimezone: false };
    case FIELD_SUBTYPE_OBJECT:    return { kind: "json" };
    case FIELD_SUBTYPE_UUID:      return { kind: "uuid" }; // R6 Plan 2a — Postgres native uuid
    default:                      return { kind: "text" }; // unknown → text fallback
  }
}

