// The prisma-schema generator's first stage: the model as Prisma models.
//
// The tables, columns, keys, indexes, foreign keys and CHECK constraints come from
// `buildExpectedSchema`, the same schema `meta migrate` writes and `meta verify --db` compares a
// live database against. Building from it, rather than walking the model a second time, is what
// lets a database that Prisma created from this schema pass `meta verify --db`: the physical names,
// the column types, the referential actions and the index names are the ones the gate expects,
// by construction. What this stage adds is the Prisma side of each table: the model and field
// names (the entity and field names of the model), the scalar and native type per provider, and
// the relation fields Prisma needs on both ends of every foreign key.
//
// What Prisma cannot declare is refused, never dropped: a view `meta verify --db` expects (a
// projection's, a write-through entity's read view, a served report's), an expression or partial
// index, a CHECK constraint on SQLite, a database schema outside Postgres. Every refusal is a
// PrismaSchemaError naming the node and the fix.

import {
  FIELD_SUBTYPE_BOOLEAN,
  FIELD_SUBTYPE_DATE,
  FIELD_SUBTYPE_DECIMAL,
  FIELD_SUBTYPE_DOUBLE,
  FIELD_SUBTYPE_ENUM,
  FIELD_SUBTYPE_FLOAT,
  FIELD_SUBTYPE_INET,
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_OBJECT,
  FIELD_SUBTYPE_TIME,
  FIELD_SUBTYPE_TIMESTAMP,
  FIELD_SUBTYPE_UUID,
  FIELD_ATTR_OBJECT_REF,
  FIELD_ATTR_STORAGE,
  FIELD_ATTR_VALUES,
  STORAGE_FLATTENED,
  isMetaObject,
  physicalNamingOf,
  pluralize,
  refTarget,
  resolveColumnName,
  type MetaField,
  type MetaObject,
  type MetaRoot,
} from "@metaobjectsdev/metadata";
import {
  buildExpectedSchemaWithProvenance,
  qualifiedDbName,
  type CheckDescriptor,
  type ColumnDescriptor,
  type FkAction,
  type FkDescriptor,
  type IndexDescriptor,
  type SqlType,
  type TableDescriptor,
} from "@metaobjectsdev/migrate-ts/expected";
import { buildProjectionViews, type ExpectedView } from "../projection/build-projection-views.js";
import { tphStorageObject } from "../tph.js";
import {
  ERR_PRISMA_NAME_COLLISION,
  ERR_PRISMA_NO_PRIMARY_KEY,
  ERR_PRISMA_READ_ONLY_SOURCE,
  ERR_PRISMA_UNMAPPABLE_RELATION,
  ERR_PRISMA_UNSUPPORTED_CHECK,
  ERR_PRISMA_UNSUPPORTED_INDEX,
  ERR_PRISMA_UNSUPPORTED_SCHEMA,
  PrismaSchemaError,
} from "./prisma-errors.js";

/** The Prisma datasource providers the generator writes a schema for. */
export const PRISMA_PROVIDERS = ["postgresql", "mysql", "sqlite"] as const;
export type PrismaProvider = (typeof PRISMA_PROVIDERS)[number];

/** One field line of a model: `name Type? @attr @attr`. */
export interface PrismaFieldSpec {
  readonly name: string;
  /** The Prisma scalar (`String`, `BigInt`, ...) or, for a relation field, the model name. */
  readonly type: string;
  readonly list: boolean;
  readonly optional: boolean;
  /** Field attributes in the order they are written: `@id`, `@default(...)`, `@map(...)`, `@db.X`. */
  readonly attributes: readonly string[];
}

export interface PrismaModelSpec {
  readonly name: string;
  readonly fields: readonly PrismaFieldSpec[];
  /** Block attributes: `@@id`, `@@unique`, `@@index`, `@@map`, `@@schema`. */
  readonly blockAttributes: readonly string[];
}

/** A CHECK constraint the schema cannot carry, as the SQL that adds it. */
export interface PrismaCheckSpec {
  readonly table: string;
  readonly schema: string | undefined;
  readonly name: string;
  readonly expression: string;
}

export interface PrismaSchemaSpec {
  readonly provider: PrismaProvider;
  readonly models: readonly PrismaModelSpec[];
  /** Database schemas the models live in, when any is not the default (Postgres multi-schema). */
  readonly schemas: readonly string[];
  readonly checks: readonly PrismaCheckSpec[];
}

export interface BuildPrismaSchemaOptions {
  readonly provider: PrismaProvider;
  /** Which objects the schema covers. Default: every object. */
  readonly matches?: (obj: MetaObject) => boolean;
  /**
   * `"file"` (the default) returns the CHECK constraints for a companion SQL file; `"omit"` leaves
   * them out, which is the only way to take a model with checks to SQLite.
   */
  readonly checks?: "file" | "omit";
}

/** Postgres' default schema: a table in it carries no `@@schema`. */
const DEFAULT_PG_SCHEMA = "public";

/** The VARCHAR length MySQL gets for a key, indexed or defaulted string with no `@maxLength`. */
const MYSQL_KEY_VARCHAR_LENGTH = 255;

const PRISMA_REFERENTIAL_ACTION: Record<FkAction, string> = {
  cascade: "Cascade",
  "set-null": "SetNull",
  restrict: "Restrict",
  "no-action": "NoAction",
};

/** Postgres index access methods Prisma can declare, by their `@@index(type: ...)` spelling. */
const PRISMA_PG_INDEX_TYPE: Record<string, string> = {
  hash: "Hash",
  gin: "Gin",
  gist: "Gist",
  brin: "Brin",
  spgist: "SpGist",
};

/** The scalar and native type of one column, before nullability and defaults. */
interface ColumnType {
  scalar: string;
  list: boolean;
  native?: string;
}

/** The field a column holds, and its Prisma field name. */
interface ColumnField {
  field: MetaField;
  name: string;
}

/** A table on its way to a model: the descriptor, the object that declared it and its fields by column. */
interface TableEntry {
  table: TableDescriptor;
  key: string;
  object: MetaObject;
  modelName: string;
  fieldByColumn: Map<string, ColumnField>;
  /** Prisma field name per column. */
  fieldName: Map<string, string>;
  columnType: Map<string, ColumnType>;
  /** Every Prisma field name the model has taken so far, scalar and relation. */
  takenNames: Set<string>;
  relationFields: PrismaFieldSpec[];
}

const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);
const upperFirst = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** A Prisma string literal. */
export function prismaString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function migrateDialect(provider: PrismaProvider): "postgres" | "sqlite" | undefined {
  // MySQL has no expected-schema dialect (MetaObjects does not own a MySQL schema, ADR-0015); the
  // canonical schema, with no dialect normalization, is the one its tables are read from.
  if (provider === "postgresql") return "postgres";
  if (provider === "sqlite") return "sqlite";
  return undefined;
}

/** Every object of the loaded model, by resolution key. */
function objectsByKey(root: MetaRoot): Map<string, MetaObject> {
  const out = new Map<string, MetaObject>();
  // ADR-0039: effective children of the root.
  for (const child of root.children()) {
    if (isMetaObject(child)) out.set(child.resolutionKey(), child);
  }
  return out;
}

function refuseView(obj: MetaObject, view: ExpectedView): PrismaSchemaError {
  return new PrismaSchemaError(
    ERR_PRISMA_READ_ONLY_SOURCE,
    `'${obj.resolutionKey()}' declares view '${view.name}', and a Prisma schema cannot create a view: ` +
      `\`prisma db push\` and \`prisma migrate\` would leave it out, and \`meta verify --db\` would report it ` +
      `missing. Create it in a Prisma migration (\`prisma migrate dev --create-only\`, then add the SQL) and mark ` +
      `its read source.rdb \`@unmanaged: true\`, or leave '${obj.resolutionKey()}' out of this generator with its ` +
      `\`filter\` option.`,
  );
}

function refuseSchema(obj: MetaObject, schema: string, provider: PrismaProvider): PrismaSchemaError {
  return new PrismaSchemaError(
    ERR_PRISMA_UNSUPPORTED_SCHEMA,
    `'${obj.resolutionKey()}' declares @schema '${schema}' on its source.rdb, and a Prisma schema places a model ` +
      `in a database schema (\`@@schema\`) only on postgresql; on ${provider} every model lives in the database ` +
      `the connection names. Remove the @schema, or use the postgresql provider.`,
  );
}

/**
 * The fields whose column lands in the table: the declaring object's, then each TPH subtype's. A
 * `field.object @storage: flattened` holds one column per field of its value object,
 * `<parent_col>_<nested_col>`, which is Prisma field `<parent><Nested>`.
 */
function fieldsByColumn(obj: MetaObject, all: Iterable<MetaObject>, strategy: ReturnType<typeof physicalNamingOf>["columns"]): Map<string, ColumnField> {
  const members = [obj, ...[...all].filter((o) => o !== obj && tphStorageObject(o) === obj)];
  const out = new Map<string, ColumnField>();
  const add = (col: string, field: MetaField, name: string): void => {
    if (!out.has(col)) out.set(col, { field, name });
  };
  for (const member of members) {
    // ADR-0039: effective fields — inherited columns live on the parent.
    for (const field of member.fields()) {
      // ADR-0039: resolving — @storage and @objectRef may be inherited via extends.
      if (field.subType === FIELD_SUBTYPE_OBJECT && field.attr(FIELD_ATTR_STORAGE) === STORAGE_FLATTENED) {
        const value = refTarget(field, FIELD_ATTR_OBJECT_REF);
        if (value === undefined || !isMetaObject(value)) continue;
        const prefix = `${resolveColumnName(field, strategy)}_`;
        for (const nested of value.fields()) add(prefix + resolveColumnName(nested, strategy), nested, field.name + upperFirst(nested.name));
        continue;
      }
      add(resolveColumnName(field, strategy), field, field.name);
    }
  }
  return out;
}

/** A column shape the expected schema never produces for this provider: a defect, not a refusal. */
function unreachableType(provider: PrismaProvider, field: MetaField, what: string): Error {
  return new Error(`prisma-schema: the ${provider} expected schema gave field '${field.resolutionKey()}' ${what}.`);
}

function pgColumnType(t: SqlType, field: MetaField): ColumnType {
  switch (t.kind) {
    case "text":
      return t.maxLength === undefined ? { scalar: "String", list: false } : { scalar: "String", list: false, native: `@db.VarChar(${t.maxLength})` };
    case "integer":
      return { scalar: t.bits === 64 ? "BigInt" : "Int", list: false };
    case "real":
      return { scalar: "Float", list: false };
    case "real4":
      return { scalar: "Float", list: false, native: "@db.Real" };
    case "numeric":
      return t.precision === undefined
        ? { scalar: "Decimal", list: false, native: "@db.Decimal" }
        : { scalar: "Decimal", list: false, native: `@db.Decimal(${t.precision}, ${t.scale ?? 0})` };
    case "boolean":
      return { scalar: "Boolean", list: false };
    case "timestamp":
      return { scalar: "DateTime", list: false, native: t.withTimezone ? "@db.Timestamptz" : "@db.Timestamp" };
    case "date":
      return { scalar: "DateTime", list: false, native: "@db.Date" };
    case "time":
      return { scalar: "DateTime", list: false, native: "@db.Time" };
    case "json":
      return { scalar: "Json", list: false };
    case "blob":
      return { scalar: "Bytes", list: false };
    case "uuid":
      return { scalar: "String", list: false, native: "@db.Uuid" };
    case "inet":
      return { scalar: "String", list: false, native: "@db.Inet" };
    case "array": {
      if (t.element.kind === "array") throw unreachableType("postgresql", field, "a nested array");
      const element = pgColumnType(t.element, field);
      return { ...element, list: true };
    }
  }
}

/** SQLite: the column layout of the expected schema (dates and times as TEXT). */
function sqliteColumnType(t: SqlType, field: MetaField): ColumnType {
  // SQLite's expected schema stores an array as TEXT (JSON).
  if (t.kind === "array") throw unreachableType("sqlite", field, "an array column");
  switch (field.subType) {
    case FIELD_SUBTYPE_BOOLEAN:
      return { scalar: "Boolean", list: false };
    case FIELD_SUBTYPE_DOUBLE:
    case FIELD_SUBTYPE_FLOAT:
      return { scalar: "Float", list: false };
    // The expected schema gives a decimal a NUMERIC column, which is Prisma's DECIMAL (SQLite
    // ignores the precision either way).
    case FIELD_SUBTYPE_DECIMAL:
      return { scalar: "Decimal", list: false };
    // Dates and times are ISO-8601 TEXT, which every port reads.
    case FIELD_SUBTYPE_DATE:
    case FIELD_SUBTYPE_TIME:
    case FIELD_SUBTYPE_TIMESTAMP:
      return { scalar: "String", list: false };
  }
  switch (t.kind) {
    case "integer":
      // SQLite's canonical integer is 64-bit; the field says which one the code holds.
      return { scalar: field.subType === FIELD_SUBTYPE_INT || field.subType === FIELD_SUBTYPE_ENUM ? "Int" : "BigInt", list: false };
    case "real":
    case "real4":
      return { scalar: "Float", list: false };
    case "json":
      return { scalar: "Json", list: false };
    case "blob":
      return { scalar: "Bytes", list: false };
    default:
      return { scalar: "String", list: false };
  }
}

/** MySQL: the column layout the Drizzle generator's MySQL arm writes. */
function mysqlColumnType(t: SqlType, field: MetaField, needsLength: boolean): ColumnType {
  if (t.kind === "array" || t.kind === "json") return { scalar: "Json", list: false };
  const varchar = (n: number): ColumnType => ({ scalar: "String", list: false, native: `@db.VarChar(${n})` });
  switch (field.subType) {
    case FIELD_SUBTYPE_UUID:
      return varchar(36);
    case FIELD_SUBTYPE_INET:
      return varchar(45);
    case FIELD_SUBTYPE_TIMESTAMP:
      return { scalar: "DateTime", list: false, native: "@db.DateTime(3)" };
    case FIELD_SUBTYPE_TIME:
      return { scalar: "DateTime", list: false, native: "@db.Time(3)" };
    case FIELD_SUBTYPE_DATE:
      return { scalar: "DateTime", list: false, native: "@db.Date" };
    case FIELD_SUBTYPE_FLOAT:
      return { scalar: "Float", list: false, native: "@db.Float" };
    case FIELD_SUBTYPE_ENUM: {
      if (t.kind === "integer") return { scalar: "Int", list: false };
      // ADR-0039: resolving — @values may be inherited.
      const raw = field.attr(FIELD_ATTR_VALUES);
      const values = Array.isArray(raw) ? raw.map(String) : [];
      return varchar(values.reduce((n, v) => Math.max(n, v.length), 1));
    }
  }
  switch (t.kind) {
    case "text":
      if (t.maxLength !== undefined) return varchar(t.maxLength);
      return needsLength ? varchar(MYSQL_KEY_VARCHAR_LENGTH) : { scalar: "String", list: false, native: "@db.Text" };
    case "integer":
      return { scalar: t.bits === 64 ? "BigInt" : "Int", list: false };
    case "real":
    case "real4":
      return { scalar: "Float", list: false };
    case "numeric":
      if (t.precision === undefined) return { scalar: "Decimal", list: false, native: "@db.Decimal(19, 4)" };
      return { scalar: "Decimal", list: false, native: `@db.Decimal(${t.precision}, ${t.scale ?? 0})` };
    case "boolean":
      return { scalar: "Boolean", list: false };
    case "blob":
      return { scalar: "Bytes", list: false };
    default:
      return { scalar: "String", list: false, native: "@db.Text" };
  }
}

/** Columns MySQL must give a length to: keys, indexed columns, foreign keys and defaulted columns. */
function mysqlKeyedColumns(table: TableDescriptor): Set<string> {
  const out = new Set<string>(table.primaryKey);
  for (const ix of table.indexes) for (const c of ix.columns) out.add(c);
  for (const fk of table.foreignKeys) for (const c of fk.columns) out.add(c);
  for (const c of table.columns) if (c.default !== undefined) out.add(c.name);
  return out;
}

const CURRENT_TIME_EXPR = /^(now\(\)|current_timestamp)$/i;
const NUMERIC_LITERAL = /^-?\d+(\.\d+)?$/;
/** The default expressions SQLite takes bare; any other needs parentheses. */
const SQLITE_KEYWORD_DEFAULT = /^current_(timestamp|date|time)$/i;

/** The `@default(...)` for a column, or undefined when it has none. */
function defaultAttribute(col: ColumnDescriptor, type: ColumnType, provider: PrismaProvider): string | undefined {
  if (col.identity === "increment") return "@default(autoincrement())";
  if (col.identity === "uuid") {
    // Postgres gives the column a database default; the other providers fill it in the client,
    // which matches a column with no default.
    return provider === "postgresql" ? `@default(dbgenerated(${prismaString("gen_random_uuid()")}))` : "@default(uuid())";
  }
  const d = col.default;
  if (d === undefined) return undefined;
  if (d.kind === "expr") {
    // MySQL takes the current time only at the column's precision (CURRENT_TIMESTAMP(3) on a
    // DATETIME(3)), which is what Prisma's `now()` writes there.
    if (provider === "mysql" && type.scalar === "DateTime" && CURRENT_TIME_EXPR.test(d.value)) return "@default(now())";
    // Elsewhere the expression verbatim, never Prisma's `now()`: Prisma writes that as
    // CURRENT_TIMESTAMP, and `meta verify --db` compares a default's text. SQLite takes an
    // expression default only in parentheses, and stores it without them, so the text matches.
    const expr = provider === "sqlite" && !SQLITE_KEYWORD_DEFAULT.test(d.value) ? `(${d.value})` : d.value;
    return `@default(dbgenerated(${prismaString(expr)}))`;
  }
  const v = d.value;
  if (type.list) {
    if (v === "{}" || v === "[]") return "@default([])";
    return `@default(dbgenerated(${prismaString(`'${v.replace(/'/g, "''")}'`)}))`;
  }
  switch (type.scalar) {
    case "Boolean":
      if (v === "true" || v === "false") return `@default(${v})`;
      // SQLite's expected schema spells a boolean default as 1 or 0.
      if (v === "1" || v === "0") return `@default(${v === "1" ? "true" : "false"})`;
      break;
    case "Int":
    case "BigInt":
    case "Float":
    case "Decimal":
      if (NUMERIC_LITERAL.test(v)) return `@default(${v})`;
      break;
    case "String":
    case "Json":
      return `@default(${prismaString(v)})`;
  }
  // A literal Prisma has no typed spelling for (a date literal, say): the database default, verbatim.
  return `@default(dbgenerated(${prismaString(`'${v.replace(/'/g, "''")}'`)}))`;
}

function indexFieldList(entry: TableEntry, ix: IndexDescriptor): string {
  return ix.columns
    .map((c, i) => {
      const name = entry.fieldName.get(c);
      if (name === undefined) throw new Error(`prisma-schema: index '${ix.name}' names a column '${c}' the table has no field for.`);
      return ix.orders?.[i] === "desc" ? `${name}(sort: Desc)` : name;
    })
    .join(", ");
}

function refuseIndex(entry: TableEntry, ix: IndexDescriptor, what: string): PrismaSchemaError {
  return new PrismaSchemaError(
    ERR_PRISMA_UNSUPPORTED_INDEX,
    `index '${ix.name}' on '${entry.object.resolutionKey()}' is ${what}, which a Prisma schema cannot declare. ` +
      `Create it in a Prisma migration (\`prisma migrate dev --create-only\`, then add the SQL), or drop the ` +
      `@expr/@where/@using from the declaration.`,
  );
}

/** Index attributes: field-level `@unique` for a plain single-column unique index, block attributes otherwise. */
function indexAttributes(entry: TableEntry, provider: PrismaProvider, fieldAttrs: Map<string, string[]>): string[] {
  const block: string[] = [];
  for (const ix of entry.table.indexes) {
    if (ix.expr !== undefined) throw refuseIndex(entry, ix, "an expression index");
    if (ix.where !== undefined) throw refuseIndex(entry, ix, "a partial index");
    const args: string[] = [];
    if (ix.using !== undefined && ix.using.toLowerCase() !== "btree") {
      const type = provider === "postgresql" ? PRISMA_PG_INDEX_TYPE[ix.using.toLowerCase()] : undefined;
      if (type === undefined) throw refuseIndex(entry, ix, `a '${ix.using}' index on ${provider}`);
      args.push(`type: ${type}`);
    }
    const plainSingle = ix.unique && ix.columns.length === 1 && ix.orders?.[0] !== "desc" && args.length === 0;
    if (plainSingle) {
      const col = ix.columns[0]!;
      fieldAttrs.get(col)?.push(`@unique(map: ${prismaString(ix.name)})`);
      continue;
    }
    const all = [`[${indexFieldList(entry, ix)}]`, `map: ${prismaString(ix.name)}`, ...args].join(", ");
    block.push(`${ix.unique ? "@@unique" : "@@index"}(${all})`);
  }
  return block;
}

function sameColumns(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join("\0") === [...b].sort().join("\0");
}

/** True when the columns are the table's primary key or one of its unique indexes. */
function isUniqueKey(table: TableDescriptor, columns: readonly string[]): boolean {
  if (sameColumns(table.primaryKey, columns)) return true;
  return table.indexes.some((ix) => ix.unique && ix.expr === undefined && ix.where === undefined && sameColumns(ix.columns, columns));
}

function pickName(entry: TableEntry, candidates: readonly string[], what: string): string {
  for (const c of candidates) {
    if (!entry.takenNames.has(c)) {
      entry.takenNames.add(c);
      return c;
    }
  }
  throw new PrismaSchemaError(
    ERR_PRISMA_NAME_COLLISION,
    `model '${entry.modelName}' has no free name for ${what}: ${candidates.map((c) => `'${c}'`).join(", ")} are all ` +
      `fields already. Rename the field that collides.`,
  );
}

/** The forward relation field's name: `customerId` gives `customer`. */
function forwardCandidates(holder: TableEntry, fk: FkDescriptor, target: TableEntry): string[] {
  const fields = fk.columns.map((c) => holder.fieldName.get(c) ?? c);
  const out: string[] = [];
  if (fields.length === 1) {
    const f = fields[0]!;
    const stripped = f.endsWith("Id") && f.length > 2 ? f.slice(0, -2) : f.endsWith("_id") && f.length > 3 ? f.slice(0, -3) : undefined;
    if (stripped !== undefined) out.push(stripped);
  }
  out.push(`${lowerFirst(target.modelName)}By${fields.map(upperFirst).join("")}`);
  return out;
}

function referentialArgs(fk: FkDescriptor): string {
  const onDelete = PRISMA_REFERENTIAL_ACTION[fk.onDelete ?? "no-action"];
  const onUpdate = PRISMA_REFERENTIAL_ACTION[fk.onUpdate ?? "no-action"];
  return `onDelete: ${onDelete}, onUpdate: ${onUpdate}`;
}

function typeSignature(t: ColumnType | undefined): string {
  return t === undefined ? "?" : `${t.scalar}${t.list ? "[]" : ""}${t.native ?? ""}`;
}

/**
 * The model a foreign key references. The descriptor names the referenced table but not its
 * schema: a table of that name in the holder's own schema wins, then the one table of that name.
 */
function fkTarget(holder: TableEntry, fk: FkDescriptor, entries: readonly TableEntry[]): TableEntry | undefined {
  const named = entries.filter((e) => e.table.name === fk.refTable);
  return named.find((e) => e.table.schema === holder.table.schema) ?? (named.length === 1 ? named[0] : undefined);
}

/** Relation fields on both ends of every foreign key. */
function addRelations(entries: readonly TableEntry[], provider: PrismaProvider): void {
  // A relation needs a name when two relations join the same pair of models, or it joins a model to itself.
  const pairCount = new Map<string, number>();
  const pairKey = (a: string, b: string): string => [a, b].sort().join("\0");
  for (const e of entries) {
    for (const fk of e.table.foreignKeys) {
      const t = fkTarget(e, fk, entries);
      if (t === undefined) continue;
      const k = pairKey(e.key, t.key);
      pairCount.set(k, (pairCount.get(k) ?? 0) + 1);
    }
  }
  for (const holder of entries) {
    for (const fk of holder.table.foreignKeys) {
      const target = fkTarget(holder, fk, entries);
      if (target === undefined) {
        throw new PrismaSchemaError(
          ERR_PRISMA_UNMAPPABLE_RELATION,
          `foreign key '${fk.name}' on '${holder.object.resolutionKey()}' references '${fk.refTable}', which this ` +
            `schema has no model for (it is @unmanaged, or outside the generator's filter). Prisma needs a model at both ` +
            `ends of a relation: include that table, or drop the reference.`,
        );
      }
      if (!isUniqueKey(target.table, fk.refColumns)) {
        throw new PrismaSchemaError(
          ERR_PRISMA_UNMAPPABLE_RELATION,
          `foreign key '${fk.name}' on '${holder.object.resolutionKey()}' references (${fk.refColumns.join(", ")}) of ` +
            `'${target.object.resolutionKey()}', which is neither its primary key nor a unique key. Prisma can relate ` +
            `only to a unique key: reference the primary key, or declare an identity.secondary on those fields.`,
        );
      }
      fk.columns.forEach((c, i) => {
        const ref = fk.refColumns[i]!;
        const a = typeSignature(holder.columnType.get(c));
        const b = typeSignature(target.columnType.get(ref));
        if (a !== b) {
          throw new PrismaSchemaError(
            ERR_PRISMA_UNMAPPABLE_RELATION,
            `foreign key '${fk.name}' on '${holder.object.resolutionKey()}' joins column '${c}' (${a}) to ` +
              `'${target.table.name}.${ref}' (${b}); Prisma requires a relation's fields to have the type of the ` +
              `fields they reference. Declare the reference field with the referenced field's subtype.`,
          );
        }
      });
      const self = holder === target;
      const named = self || (pairCount.get(pairKey(holder.key, target.key)) ?? 0) > 1;
      const relationName = named ? `${prismaString(fk.name)}, ` : "";
      const holderFields = fk.columns.map((c) => holder.fieldName.get(c)!);
      const targetFields = fk.refColumns.map((c) => target.fieldName.get(c)!);
      const optional = fk.columns.some((c) => holder.table.columns.find((col) => col.name === c)?.nullable === true);

      const forward = pickName(holder, forwardCandidates(holder, fk, target), `the relation of foreign key '${fk.name}'`);
      holder.relationFields.push({
        name: forward,
        type: target.modelName,
        list: false,
        optional,
        attributes: [
          `@relation(${relationName}fields: [${holderFields.join(", ")}], references: [${targetFields.join(", ")}], ` +
            // SQLite has no named foreign keys.
            `${referentialArgs(fk)}${provider === "sqlite" ? "" : `, map: ${prismaString(fk.name)}`})`,
        ],
      });

      const oneToOne = isUniqueKey(holder.table, fk.columns);
      const base = oneToOne ? lowerFirst(holder.modelName) : lowerFirst(pluralize(holder.modelName));
      const back = pickName(
        target,
        named ? [`${base}By${upperFirst(forward)}`] : [base, `${base}By${upperFirst(forward)}`],
        `the back relation of foreign key '${fk.name}'`,
      );
      target.relationFields.push({
        name: back,
        type: holder.modelName,
        list: !oneToOne,
        optional: oneToOne,
        attributes: named ? [`@relation(${prismaString(fk.name)})`] : [],
      });
    }
  }
}

function refuseCheck(entry: TableEntry, check: CheckDescriptor): PrismaSchemaError {
  return new PrismaSchemaError(
    ERR_PRISMA_UNSUPPORTED_CHECK,
    `'${entry.object.resolutionKey()}' declares CHECK constraint '${check.name}' (${check.expression}). A Prisma ` +
      `schema cannot declare a CHECK, and SQLite cannot add one to a table Prisma created. Pass \`checks: "omit"\` ` +
      `to generate the schema without it (the column then takes any value the Zod schema lets through, and ` +
      `\`meta verify --db\` reports the constraint missing), or use the postgresql provider.`,
  );
}

/**
 * The CHECK constraints, in the SQL the provider's database takes. Postgres gets every check the
 * expected schema declares, so `meta verify --db` finds them. MySQL gets the enum membership
 * checks, which are what the Drizzle MySQL arm writes too: the other checks are Postgres SQL.
 */
function checksOf(entry: TableEntry, provider: PrismaProvider, omit: boolean): PrismaCheckSpec[] {
  if (omit) return [];
  const out: PrismaCheckSpec[] = [];
  for (const check of entry.table.checks) {
    if (provider === "sqlite") throw refuseCheck(entry, check);
    let expression = check.expression;
    if (provider === "mysql") {
      const enumColumn = [...entry.fieldByColumn].find(
        ([c, { field: f }]) => f.subType === FIELD_SUBTYPE_ENUM && check.name === `${entry.table.name}_${c}_chk`,
      );
      if (enumColumn === undefined) continue;
      expression = `\`${enumColumn[0]}\`${check.expression.slice(check.expression.indexOf(" IN ("))}`;
    }
    out.push({ table: entry.table.name, schema: entry.table.schema, name: check.name, expression });
  }
  return out;
}

/** The scalar fields of a model, in column order. */
function scalarFields(entry: TableEntry, provider: PrismaProvider, fieldAttrs: Map<string, string[]>): PrismaFieldSpec[] {
  const pkSingle = entry.table.primaryKey.length === 1 ? entry.table.primaryKey[0] : undefined;
  return entry.table.columns.map((col) => {
    const type = entry.columnType.get(col.name)!;
    const name = entry.fieldName.get(col.name)!;
    const attrs: string[] = [];
    if (col.name === pkSingle) attrs.push("@id");
    const def = defaultAttribute(col, type, provider);
    if (def !== undefined) attrs.push(def);
    attrs.push(...(fieldAttrs.get(col.name) ?? []));
    if (name !== col.name) attrs.push(`@map(${prismaString(col.name)})`);
    if (type.native !== undefined) attrs.push(type.native);
    return { name, type: type.scalar, list: type.list, optional: col.nullable && !type.list, attributes: attrs };
  });
}

/**
 * The loaded model as Prisma models, one per table `meta migrate` would create, plus the CHECK
 * constraints a Prisma schema cannot carry.
 */
export function buildPrismaSchema(root: MetaRoot, options: BuildPrismaSchemaOptions): PrismaSchemaSpec {
  const { provider } = options;
  const matches = options.matches ?? (() => true);
  const objects = objectsByKey(root);

  const dialect = migrateDialect(provider);
  // MySQL has no view dialect; the set of views verify expects is the same under any of them.
  for (const view of buildProjectionViews(root, { dialect: dialect ?? "postgres" })) {
    const obj = objects.get(view.fqn);
    if (obj !== undefined && matches(obj)) throw refuseView(obj, view);
  }

  const { snapshot, provenance } = buildExpectedSchemaWithProvenance(root, dialect === undefined ? {} : { dialect });
  const strategy = physicalNamingOf(root).columns;

  const entries: TableEntry[] = [];
  const modelNames = new Map<string, string>();
  for (const table of snapshot.tables) {
    const key = qualifiedDbName(table);
    const fqn = provenance.get(key);
    const object = fqn === undefined ? undefined : objects.get(fqn);
    if (object === undefined) throw new Error(`prisma-schema: no object declares table '${key}'.`);
    if (!matches(object)) continue;
    if (provider !== "postgresql" && table.schema !== undefined) throw refuseSchema(object, table.schema, provider);
    if (table.primaryKey.length === 0) {
      throw new PrismaSchemaError(
        ERR_PRISMA_NO_PRIMARY_KEY,
        `'${object.resolutionKey()}' has no primary key, and Prisma requires one on every model. Declare an identity.primary.`,
      );
    }
    const other = modelNames.get(object.name);
    if (other !== undefined) {
      throw new PrismaSchemaError(
        ERR_PRISMA_NAME_COLLISION,
        `'${object.resolutionKey()}' and '${other}' would both be Prisma model '${object.name}'; a Prisma schema has one ` +
          `namespace. Narrow the generator's filter to one of them, or rename one.`,
      );
    }
    modelNames.set(object.name, object.resolutionKey());

    const fieldByColumn = fieldsByColumn(object, objects.values(), strategy);
    const entry: TableEntry = {
      table, key, object, modelName: object.name, fieldByColumn,
      fieldName: new Map(), columnType: new Map(), takenNames: new Set(), relationFields: [],
    };
    const keyed = provider === "mysql" ? mysqlKeyedColumns(table) : new Set<string>();
    for (const col of table.columns) {
      const mapped = fieldByColumn.get(col.name);
      if (mapped === undefined) throw new Error(`prisma-schema: no field of '${object.resolutionKey()}' maps to column '${col.name}'.`);
      const { field, name } = mapped;
      if (entry.takenNames.has(name)) {
        throw new PrismaSchemaError(
          ERR_PRISMA_NAME_COLLISION,
          `two columns of '${object.resolutionKey()}' would both be Prisma field '${name}' (a TPH subtype redeclares ` +
            `a field with another column, or a flattened field.object's column takes the name of a field). Rename one of them.`,
        );
      }
      entry.takenNames.add(name);
      entry.fieldName.set(col.name, name);
      const type =
        provider === "postgresql" ? pgColumnType(col.sqlType, field)
        : provider === "sqlite" ? sqliteColumnType(col.sqlType, field)
        : mysqlColumnType(col.sqlType, field, keyed.has(col.name));
      entry.columnType.set(col.name, type);
    }
    entries.push(entry);
  }

  // SQLite: only `INTEGER PRIMARY KEY` is the auto-incrementing rowid, and Prisma writes BIGINT for a
  // BigInt. An increment key there is an Int, and so is every column that references it.
  if (provider === "sqlite") {
    for (const e of entries) {
      for (const col of e.table.columns) if (col.identity === "increment") e.columnType.set(col.name, { scalar: "Int", list: false });
    }
    for (const e of entries) {
      for (const fk of e.table.foreignKeys) {
        const target = fkTarget(e, fk, entries);
        fk.columns.forEach((c, i) => {
          const ref = target?.columnType.get(fk.refColumns[i]!);
          if (ref?.scalar === "Int") e.columnType.set(c, { scalar: "Int", list: false });
        });
      }
    }
  }

  addRelations(entries, provider);

  const nonDefaultSchemas = [...new Set(entries.map((e) => e.table.schema ?? DEFAULT_PG_SCHEMA))].filter((s) => s !== DEFAULT_PG_SCHEMA);
  const multiSchema = provider === "postgresql" && nonDefaultSchemas.length > 0;
  const models: PrismaModelSpec[] = [];
  const checks: PrismaCheckSpec[] = [];
  for (const entry of entries) {
    const fieldAttrs = new Map(entry.table.columns.map((c) => [c.name, [] as string[]]));
    const indexBlock = indexAttributes(entry, provider, fieldAttrs);
    const block: string[] = [];
    if (entry.table.primaryKey.length > 1) {
      block.push(`@@id([${entry.table.primaryKey.map((c) => entry.fieldName.get(c)!).join(", ")}])`);
    }
    block.push(...indexBlock);
    block.push(`@@map(${prismaString(entry.table.name)})`);
    if (multiSchema) block.push(`@@schema(${prismaString(entry.table.schema ?? DEFAULT_PG_SCHEMA)})`);
    models.push({
      name: entry.modelName,
      fields: [...scalarFields(entry, provider, fieldAttrs), ...entry.relationFields],
      blockAttributes: block,
    });
    checks.push(...checksOf(entry, provider, options.checks === "omit"));
  }
  const schemas = multiSchema ? [...new Set([DEFAULT_PG_SCHEMA, ...nonDefaultSchemas])].sort() : [];
  return { provider, models, schemas, checks };
}
