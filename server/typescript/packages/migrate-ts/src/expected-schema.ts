import type { MetaData, MetaObject, MetaRoot } from "@metaobjectsdev/metadata";
import {
  TYPE_OBJECT,
  MetaSource,
  IDENTITY_ATTR_GENERATION,
  IDENTITY_ATTR_UNIQUE,
  FIELD_ATTR_DEFAULT,
  FIELD_ATTR_UNIQUE,
  FIELD_SUBTYPE_STRING,
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_LONG,
  FIELD_SUBTYPE_SHORT,
  FIELD_SUBTYPE_BYTE,
  FIELD_SUBTYPE_DOUBLE,
  FIELD_SUBTYPE_FLOAT,
  FIELD_SUBTYPE_DECIMAL,
  FIELD_SUBTYPE_BOOLEAN,
  FIELD_SUBTYPE_CURRENCY,
  FIELD_SUBTYPE_DATE,
  FIELD_SUBTYPE_TIME,
  FIELD_SUBTYPE_TIMESTAMP,
  FIELD_SUBTYPE_OBJECT,
  FIELD_SUBTYPE_CLASS,
  FIELD_ATTR_OBJECT_REF,
  FIELD_ATTR_STORAGE,
  STORAGE_FLATTENED,
  DOC_ATTR_DESCRIPTION,
  resolveTableName, resolveColumnName, resolveTableSchema,
} from "@metaobjectsdev/metadata";
import type { SqlType } from "./sql-type.js";
import type {
  SchemaSnapshot, TableDescriptor, ColumnDescriptor, IndexDescriptor, FkDescriptor,
} from "./types.js";
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
   * matches what introspection will see. For sqlite this collapses
   * boolean → integer{64} and timestamp/date/time → text, since sqlite
   * has no native boolean/timestamp affinity and Drizzle's
   * `integer(..., {mode:"boolean"})` / `text("ts")` patterns produce
   * INTEGER / TEXT in the actual DB.
   */
  dialect?: "sqlite" | "postgres";
}

export function buildExpectedSchema(
  root: MetaData,
  opts?: BuildExpectedSchemaOptions,
): SchemaSnapshot {
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
    const t = buildTable(entity, tableName, resolveTargetTable, root as MetaRoot);
    const schema = resolveTableSchema(entity);
    if (schema !== undefined) t.schema = schema;
    return t;
  });

  // Pass 3: dialect-specific SqlType normalization.
  if (opts?.dialect === "sqlite") {
    for (const table of tables) {
      for (const col of table.columns) {
        col.sqlType = normalizeForSqlite(col.sqlType);
      }
    }
  }

  // Dialect validation: SQLite has no schema concept; reject any non-default @schema.
  if (opts?.dialect === "sqlite") {
    for (const table of tables) {
      if (table.schema !== undefined) {
        throw new Error(
          `sqlite does not support DB schemas; entity-table "${table.name}" declares @schema "${table.schema}"`,
        );
      }
    }
  }

  return { tables, views: [] };
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
      return { kind: "text" };
    case "integer":
      // SQLite stores every INTEGER as a 64-bit value and Drizzle's int() emits
      // plain "INTEGER" regardless of source bit-width. Collapse 32 → 64 so the
      // expected snapshot matches what introspection sees.
      return { kind: "integer", bits: 64 };
    default:
      return sqlType;
  }
}

function buildTable(
  entity: MetaObject,
  tableName: string,
  resolveTargetTable: (entityName: string) => string | undefined,
  root: MetaRoot,
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
    return field ? resolveColumnName(field) : toSnake(jsName);
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
      columns.push(...flattenObjectField(field, root));
    } else {
      columns.push(buildColumn(field, isPk, isPk ? pkGeneration : undefined));
    }
  }

  const entityDesc = entity.attr(DOC_ATTR_DESCRIPTION);
  const descriptor: TableDescriptor = {
    name: tableName,
    columns,
    indexes: buildSecondaryIndexes(entity, tableName),
    foreignKeys: buildForeignKeys(entity, tableName, resolveTargetTable, root),
    primaryKey,
  };
  if (typeof entityDesc === "string" && entityDesc.length > 0) {
    descriptor.description = entityDesc;
  }
  return descriptor;
}

function buildSecondaryIndexes(entity: MetaObject, tableName: string): IndexDescriptor[] {
  const indexes: IndexDescriptor[] = [];

  // (a) Implicit unique indexes from @unique fields. Drizzle auto-creates these
  // on the DB side using the convention `<table>_<column>_unique` whenever a
  // column has `.unique()`. We mirror them in the expected schema so the diff
  // doesn't see them as drop-only on the actual side.
  for (const field of entity.fields()) {
    if (field.ownAttr(FIELD_ATTR_UNIQUE) !== true) continue;
    const colName = resolveColumnName(field);
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
      return field ? resolveColumnName(field) : toSnake(jsName);
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

function buildForeignKeys(
  entity: MetaObject,
  tableName: string,
  resolveTargetTable: (entityName: string) => string | undefined,
  root: MetaRoot,
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
      return fkField ? resolveColumnName(fkField) : toSnake(jsName);
    });

    // Target columns: prefer explicit multi-field dotted form, else delegate
    // to MetaReferenceIdentity.resolvedTargetPkField (single field → target's
    // primary identity → "id" fallback).
    const explicitTargetFields = refChild.targetFields;
    const refColumns = explicitTargetFields.length > 1
      ? explicitTargetFields.map(toSnake)
      : [toSnake(refChild.resolvedTargetPkField(root) ?? "id")];

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
function flattenObjectField(field: MetaData, root: MetaRoot): ColumnDescriptor[] {
  const ref = field.ownAttr(FIELD_ATTR_OBJECT_REF);
  if (typeof ref !== "string" || ref.length === 0) return [];
  const targetObject = root.findObject(ref);
  if (targetObject === undefined) return [];
  const prefix = resolveColumnName(field) + "_";
  const cols: ColumnDescriptor[] = [];
  for (const nested of targetObject.fields()) {
    const inner = buildColumn(nested, /* isPk */ false, /* pkGeneration */ undefined);
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
): ColumnDescriptor {
  // Both the @required attr and the validator.required child signal NOT NULL.
  const fieldIsRequired = isRequired(field);
  const defaultRaw = field.ownAttr(FIELD_ATTR_DEFAULT);

  const col: ColumnDescriptor = {
    name: resolveColumnName(field),
    sqlType: subtypeToSqlType(field.subType),
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

  // Use effective attr (.attr) so a field that extends an abstract base picks
  // up the base's @description — parity with buildTable's entity.attr() call.
  const fieldDesc = field.attr(DOC_ATTR_DESCRIPTION);
  if (typeof fieldDesc === "string" && fieldDesc.length > 0) {
    col.description = fieldDesc;
  }

  return col;
}

function subtypeToSqlType(subType: string): SqlType {
  switch (subType) {
    case FIELD_SUBTYPE_STRING:    return { kind: "text" };
    case FIELD_SUBTYPE_INT:
    case FIELD_SUBTYPE_SHORT:
    case FIELD_SUBTYPE_BYTE:      return { kind: "integer", bits: 32 };
    case FIELD_SUBTYPE_LONG:
    case FIELD_SUBTYPE_CURRENCY:  return { kind: "integer", bits: 64 };
    case FIELD_SUBTYPE_DOUBLE:
    case FIELD_SUBTYPE_FLOAT:     return { kind: "real" };
    case FIELD_SUBTYPE_DECIMAL:   return { kind: "numeric" };
    case FIELD_SUBTYPE_BOOLEAN:   return { kind: "boolean" };
    case FIELD_SUBTYPE_DATE:      return { kind: "date" };
    case FIELD_SUBTYPE_TIME:      return { kind: "text" }; // SQL TIME rare; coerce to text
    case FIELD_SUBTYPE_TIMESTAMP: return { kind: "timestamp", withTimezone: false };
    case FIELD_SUBTYPE_OBJECT:
    case FIELD_SUBTYPE_CLASS:     return { kind: "json" };
    default:                      return { kind: "text" }; // unknown → text fallback
  }
}

function toSnake(s: string): string {
  return s
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}
