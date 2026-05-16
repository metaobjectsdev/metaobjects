import type { MetaData } from "@metaobjects/metadata";
import {
  TYPE_OBJECT, TYPE_FIELD, TYPE_IDENTITY, TYPE_RELATIONSHIP,
  IDENTITY_ATTR_FIELDS,
  IDENTITY_ATTR_GENERATION,
  IDENTITY_ATTR_UNIQUE,
  IDENTITY_SUBTYPE_PRIMARY,
  FIELD_ATTR_REQUIRED,
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
  FIELD_SUBTYPE_DATE,
  FIELD_SUBTYPE_TIME,
  FIELD_SUBTYPE_TIMESTAMP,
  FIELD_SUBTYPE_OBJECT,
  FIELD_SUBTYPE_CLASS,
  RELATIONSHIP_ATTR_CARDINALITY,
  RELATIONSHIP_ATTR_OBJECT_REF,
  RELATIONSHIP_ATTR_FK_FIELD,
  CARDINALITY_ONE,
  resolveTableName, resolveColumnName,
} from "@metaobjects/metadata";
import type { SqlType } from "./sql-type.js";
import type {
  SchemaSnapshot, TableDescriptor, ColumnDescriptor, IndexDescriptor, FkDescriptor,
} from "./types.js";

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
  const entities: { entity: MetaData; tableName: string }[] = [];
  for (const child of root.children()) {
    if (child.type !== TYPE_OBJECT) continue;
    entities.push({ entity: child, tableName: resolveTableName(child) });
  }
  const entityToTable = new Map(entities.map((e) => [e.entity.name, e.tableName]));
  const resolveTargetTable = (entityName: string) => entityToTable.get(entityName);

  // Pass 2: build full descriptors with FK resolution.
  const tables: TableDescriptor[] = entities.map(({ entity, tableName }) =>
    buildTable(entity, tableName, resolveTargetTable),
  );

  // Pass 3: dialect-specific SqlType normalization.
  if (opts?.dialect === "sqlite") {
    for (const table of tables) {
      for (const col of table.columns) {
        col.sqlType = normalizeForSqlite(col.sqlType);
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
    default:
      return sqlType;
  }
}

function buildTable(
  entity: MetaData,
  tableName: string,
  resolveTargetTable: (entityName: string) => string | undefined,
): TableDescriptor {
  let primaryKey: string[] = [];
  let pkIdentity: MetaData | undefined;

  // First pass: locate the primary identity so column construction can consult it.
  for (const child of entity.children()) {
    if (child.type === TYPE_IDENTITY && isPrimaryIdentity(child)) {
      pkIdentity = child;
      primaryKey = readIdentityFields(child).map((jsName) => {
        const field = findField(entity, jsName);
        return field ? resolveColumnName(field) : toSnake(jsName);
      });
      break;
    }
  }

  const pkJsNames = pkIdentity ? readIdentityFields(pkIdentity) : [];
  const pkGeneration = pkIdentity
    ? (pkIdentity.attr(IDENTITY_ATTR_GENERATION) as string | undefined)
    : undefined;

  const columns: ColumnDescriptor[] = [];
  for (const child of entity.children()) {
    if (child.type !== TYPE_FIELD) continue;
    const isPk = pkJsNames.includes(child.name);
    columns.push(buildColumn(child, isPk, isPk ? pkGeneration : undefined));
  }

  return {
    name: tableName,
    columns,
    indexes: buildSecondaryIndexes(entity, tableName),
    foreignKeys: buildForeignKeys(entity, tableName, resolveTargetTable),
    primaryKey,
  };
}

function buildSecondaryIndexes(entity: MetaData, tableName: string): IndexDescriptor[] {
  const indexes: IndexDescriptor[] = [];

  // (a) Implicit unique indexes from @unique fields. Drizzle auto-creates these
  // on the DB side using the convention `<table>_<column>_unique` whenever a
  // column has `.unique()`. We mirror them in the expected schema so the diff
  // doesn't see them as drop-only on the actual side.
  for (const child of entity.children()) {
    if (child.type !== TYPE_FIELD) continue;
    if (child.attr(FIELD_ATTR_UNIQUE) !== true) continue;
    const colName = resolveColumnName(child);
    indexes.push({
      name: `${tableName}_${colName}_unique`,
      columns: [colName],
      unique: true,
    });
  }

  // (b) Explicit secondary identities — unique-by-default, opt out with @unique: false.
  for (const child of entity.children()) {
    if (child.type !== TYPE_IDENTITY) continue;
    if (isPrimaryIdentity(child)) continue;
    const fieldNames = readIdentityFields(child);
    if (fieldNames.length === 0) continue;
    const cols = fieldNames.map((jsName) => {
      const field = findField(entity, jsName);
      return field ? resolveColumnName(field) : toSnake(jsName);
    });
    const uniqueAttr = child.attr(IDENTITY_ATTR_UNIQUE);
    indexes.push({
      name: `${tableName}_${toSnake(child.name)}`,
      columns: cols,
      unique: uniqueAttr !== false,
    });
  }
  return indexes;
}

function buildForeignKeys(
  entity: MetaData,
  tableName: string,
  resolveTargetTable: (entityName: string) => string | undefined,
): FkDescriptor[] {
  const fks: FkDescriptor[] = [];
  for (const child of entity.children()) {
    if (child.type !== TYPE_RELATIONSHIP) continue;
    const cardinality = child.attr(RELATIONSHIP_ATTR_CARDINALITY);
    if (cardinality !== CARDINALITY_ONE) continue;

    const targetEntity = child.attr(RELATIONSHIP_ATTR_OBJECT_REF);
    if (typeof targetEntity !== "string") continue;
    const refTable = resolveTargetTable(targetEntity);
    if (!refTable) continue;

    const fkFieldRaw = child.attr(RELATIONSHIP_ATTR_FK_FIELD);
    const fkFieldJsName = typeof fkFieldRaw === "string"
      ? fkFieldRaw
      : `${child.name}Id`;          // default: <relationshipName>Id
    const fkField = findField(entity, fkFieldJsName);
    const fkCol = fkField ? resolveColumnName(fkField) : toSnake(fkFieldJsName);

    fks.push({
      name: `${tableName}_${fkCol}_fk`,
      columns: [fkCol],
      refTable,
      refColumns: ["id"],             // v0.1: assume PK is single "id" column on target
    });
  }
  return fks;
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
  const required = field.attr(FIELD_ATTR_REQUIRED);
  const isRequired = required === true || required === "true";
  const defaultRaw = field.attr(FIELD_ATTR_DEFAULT);

  const col: ColumnDescriptor = {
    name: resolveColumnName(field),
    sqlType: subtypeToSqlType(field.subType),
    nullable: !isPk && !isRequired,
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

  return col;
}

function subtypeToSqlType(subType: string): SqlType {
  switch (subType) {
    case FIELD_SUBTYPE_STRING:    return { kind: "text" };
    case FIELD_SUBTYPE_INT:
    case FIELD_SUBTYPE_SHORT:
    case FIELD_SUBTYPE_BYTE:      return { kind: "integer", bits: 32 };
    case FIELD_SUBTYPE_LONG:      return { kind: "integer", bits: 64 };
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

function isPrimaryIdentity(identity: MetaData): boolean {
  return identity.subType === IDENTITY_SUBTYPE_PRIMARY;
}

function readIdentityFields(identity: MetaData): string[] {
  const raw = identity.attr(IDENTITY_ATTR_FIELDS);
  if (Array.isArray(raw)) {
    return raw.map(String).filter((s) => s.length > 0);
  }
  if (typeof raw === "string") {
    // Fallback: comma-separated string form (defensive; canonical form is array)
    return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  }
  return [];
}

function findField(entity: MetaData, name: string): MetaData | undefined {
  for (const child of entity.children()) {
    if (child.type === TYPE_FIELD && child.name === name) return child;
  }
  return undefined;
}

function toSnake(s: string): string {
  return s
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}
