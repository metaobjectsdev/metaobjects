import type { ColumnNamingStrategy, MetaData } from "@metaobjectsdev/metadata";
import {
  TYPE_FIELD, TYPE_IDENTITY,
  IDENTITY_SUBTYPE_PRIMARY,
  IDENTITY_ATTR_FIELDS,
  DEFAULT_COLUMN_NAMING_STRATEGY,
  resolveTableName, resolveColumnName,
} from "@metaobjectsdev/metadata";
import { MetadataError } from "./errors.js";
import type {
  WhereClause, OrderBy, PrimitiveValue, Row,
  SelectSpec, InsertSpec, UpdateSpec, DeleteSpec, CountSpec,
} from "./persistence-driver.js";

export { resolveTableName } from "@metaobjectsdev/metadata";

export type Filter = Record<string, FilterValue> | { $and: Filter[] };

export type FilterValue =
  | string | number | boolean | null
  | (string | number)[]
  | {
      $eq?: string | number | boolean | null;
      $ne?: string | number | boolean | null;
      $gt?: string | number;
      $gte?: string | number;
      $lt?: string | number;
      $lte?: string | number;
      $like?: string;
      $in?: (string | number)[];
      $isNull?: boolean;
    };

export interface QueryOpts {
  orderBy?: [string, "asc" | "desc"] | [string, "asc" | "desc"][];
  limit?: number;
  offset?: number;
}

export function resolvePkFields(entity: MetaData): string[] {
  const primary = entity.ownChildren().find(
    (c) => c.type === TYPE_IDENTITY && c.subType === IDENTITY_SUBTYPE_PRIMARY,
  );
  if (!primary) {
    throw new MetadataError(`Entity '${entity.name}' has no primary identity`, { entity: entity.name });
  }
  const attr = primary.ownAttr(IDENTITY_ATTR_FIELDS);
  if (!Array.isArray(attr) || attr.length === 0) {
    throw new MetadataError(`Entity '${entity.name}' primary identity has no @fields`, { entity: entity.name });
  }
  return attr.map(String);
}

function listFieldNames(entity: MetaData): string[] {
  const out: string[] = [];
  for (const child of entity.ownChildren()) {
    if (child.type === TYPE_FIELD) out.push(child.name);
  }
  return out;
}

function getField(entity: MetaData, fieldName: string): MetaData {
  const f = entity.ownChildren().find((c) => c.type === TYPE_FIELD && c.name === fieldName);
  if (!f) {
    throw new MetadataError(
      `Unknown field '${fieldName}' on entity '${entity.name}'`,
      { entity: entity.name },
    );
  }
  return f;
}

function rowToColumns(entity: MetaData, data: Row, strategy: ColumnNamingStrategy): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(data)) {
    const field = getField(entity, k);
    out[resolveColumnName(field, strategy)] = v;
  }
  return out;
}

/**
 * Returns null when `filter` has no clauses ({} or { $and: [] }) — meaning "match all"
 * (callers should treat null the same as omitting the where clause entirely).
 */
export function compileFilter(
  entity: MetaData,
  filter: Filter,
  strategy: ColumnNamingStrategy = DEFAULT_COLUMN_NAMING_STRATEGY,
): WhereClause | null {
  if ("$and" in filter && Array.isArray(filter.$and)) {
    // TS can't narrow $and away from the Record branch, so the runtime check above
    // proves it's a Filter[] but the element type still needs a bridge cast.
    const andFilters = filter.$and as Filter[];
    const clauses = andFilters
      .map((f) => compileFilter(entity, f, strategy))
      .filter((c): c is WhereClause => c !== null);
    if (clauses.length === 0) return null;
    return clauses.length === 1 ? clauses[0]! : { kind: "and", clauses };
  }
  const entries = Object.entries(filter);
  if (entries.length === 0) return null;
  if (entries.length === 1) {
    return compileEntry(entity, entries[0]![0], entries[0]![1] as FilterValue, strategy);
  }
  return {
    kind: "and",
    clauses: entries.map(([k, v]) => compileEntry(entity, k, v as FilterValue, strategy)),
  };
}

function compileEntry(
  entity: MetaData, fieldName: string, value: FilterValue, strategy: ColumnNamingStrategy,
): WhereClause {
  const field = getField(entity, fieldName);
  const column = resolveColumnName(field, strategy);

  if (value === null) return { kind: "isNull", column, not: false };
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return { kind: "eq", column, value };
  }
  if (Array.isArray(value)) {
    return { kind: "in", column, values: value as PrimitiveValue[] };
  }

  // If multiple operators are set on one field ({ $gte: 5, $lte: 10 }), the FIRST match wins
  // and later operators are silently ignored. Range queries must use $and: [...] explicitly.
  const op = value;
  if ("$eq" in op && op.$eq !== undefined) {
    if (op.$eq === null) return { kind: "isNull", column, not: false };
    return { kind: "eq", column, value: op.$eq };
  }
  if ("$ne" in op && op.$ne !== undefined) {
    if (op.$ne === null) return { kind: "isNull", column, not: true };
    return { kind: "ne", column, value: op.$ne };
  }
  if ("$gt" in op && op.$gt !== undefined) return { kind: "gt", column, value: op.$gt };
  if ("$gte" in op && op.$gte !== undefined) return { kind: "gte", column, value: op.$gte };
  if ("$lt" in op && op.$lt !== undefined) return { kind: "lt", column, value: op.$lt };
  if ("$lte" in op && op.$lte !== undefined) return { kind: "lte", column, value: op.$lte };
  if ("$like" in op && op.$like !== undefined) return { kind: "like", column, pattern: op.$like };
  if ("$in" in op && op.$in !== undefined) return { kind: "in", column, values: op.$in };
  if ("$isNull" in op && op.$isNull !== undefined) {
    return { kind: "isNull", column, not: !op.$isNull };
  }
  throw new MetadataError(`No recognized operator on filter for field '${fieldName}'`);
}

function normalizeOrderBy(
  input: QueryOpts["orderBy"], entity: MetaData, strategy: ColumnNamingStrategy,
): OrderBy[] | undefined {
  if (input === undefined) return undefined;
  const arr = Array.isArray(input[0]) ? (input as [string, "asc" | "desc"][]) : [input as [string, "asc" | "desc"]];
  return arr.map(([fieldName, dir]) => {
    const field = getField(entity, fieldName);
    return { column: resolveColumnName(field, strategy), direction: dir };
  });
}

/** If `projectedFields` is provided, only those fields are selected (PK is auto-added). */
export function buildSelectSpec(
  entity: MetaData,
  filter: Filter | undefined,
  opts: QueryOpts,
  projectedFields?: string[],
  strategy: ColumnNamingStrategy = DEFAULT_COLUMN_NAMING_STRATEGY,
): SelectSpec {
  const allFields = projectedFields ?? listFieldNames(entity);
  const pkFields = resolvePkFields(entity);
  const fieldSet = new Set<string>(allFields);
  for (const pk of pkFields) fieldSet.add(pk);

  const columns = [...fieldSet].map((f) => resolveColumnName(getField(entity, f), strategy));
  const orderBy = normalizeOrderBy(opts.orderBy, entity, strategy);

  const spec: SelectSpec = {
    table: resolveTableName(entity),
    columns,
  };
  const where = filter !== undefined ? compileFilter(entity, filter, strategy) : null;
  if (where !== null) spec.where = where;
  if (orderBy !== undefined) spec.orderBy = orderBy;
  if (opts.limit !== undefined) spec.limit = opts.limit;
  if (opts.offset !== undefined) spec.offset = opts.offset;
  return spec;
}

export function buildCountSpec(
  entity: MetaData, filter: Filter | undefined,
  strategy: ColumnNamingStrategy = DEFAULT_COLUMN_NAMING_STRATEGY,
): CountSpec {
  const spec: CountSpec = { table: resolveTableName(entity) };
  const where = filter !== undefined ? compileFilter(entity, filter, strategy) : null;
  if (where !== null) spec.where = where;
  return spec;
}

export function buildInsertSpec(
  entity: MetaData, data: Row,
  strategy: ColumnNamingStrategy = DEFAULT_COLUMN_NAMING_STRATEGY,
): InsertSpec {
  const values = rowToColumns(entity, data, strategy);
  const allFields = listFieldNames(entity);
  return {
    table: resolveTableName(entity),
    values,
    returning: allFields.map((f) => resolveColumnName(getField(entity, f), strategy)),
  };
}

export function buildUpdateSpec(
  entity: MetaData, data: Row, id: unknown,
  strategy: ColumnNamingStrategy = DEFAULT_COLUMN_NAMING_STRATEGY,
): UpdateSpec {
  const values = rowToColumns(entity, data, strategy);
  const pkFields = resolvePkFields(entity);
  if (pkFields.length !== 1) {
    throw new MetadataError(
      `update-by-id requires single-column PK on '${entity.name}'; use updateMany for composite PKs`,
      { entity: entity.name },
    );
  }
  const pkColumn = resolveColumnName(getField(entity, pkFields[0]!), strategy);
  return {
    table: resolveTableName(entity),
    values,
    where: { kind: "eq", column: pkColumn, value: id as PrimitiveValue },
    returning: listFieldNames(entity).map((f) => resolveColumnName(getField(entity, f), strategy)),
  };
}

export function buildDeleteSpec(
  entity: MetaData, id: unknown,
  strategy: ColumnNamingStrategy = DEFAULT_COLUMN_NAMING_STRATEGY,
): DeleteSpec {
  const pkFields = resolvePkFields(entity);
  if (pkFields.length !== 1) {
    throw new MetadataError(
      `delete-by-id requires single-column PK on '${entity.name}'; use deleteMany for composite PKs`,
      { entity: entity.name },
    );
  }
  const pkColumn = resolveColumnName(getField(entity, pkFields[0]!), strategy);
  return {
    table: resolveTableName(entity),
    where: { kind: "eq", column: pkColumn, value: id as PrimitiveValue },
  };
}
