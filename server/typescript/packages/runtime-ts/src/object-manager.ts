import type { MetaData } from "@metaobjectsdev/metadata";
import {
  TYPE_OBJECT, TYPE_FIELD,
  FIELD_SUBTYPE_INT, FIELD_SUBTYPE_SHORT, FIELD_SUBTYPE_BYTE,
  FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_DOUBLE, FIELD_SUBTYPE_FLOAT, FIELD_SUBTYPE_DECIMAL,
} from "@metaobjectsdev/metadata";
import type {
  PersistenceDriver, Row, WhereClause,
  InsertManySpec, UpdateManySpec, DeleteManySpec,
} from "./persistence-driver.js";
import {
  buildSelectSpec, buildCountSpec, buildInsertSpec, buildUpdateSpec, buildDeleteSpec,
  resolvePkFields, compileFilter,
  type Filter, type QueryOpts, type DiscriminatorScope,
} from "./query-builder.js";
import { tphSubtypeOf, type TphSubtype } from "./tph.js";
import {
  buildNameMap, resolveTableName, DEFAULT_COLUMN_NAMING_STRATEGY,
  type ColumnNamingStrategy, type EntityNameMap,
} from "@metaobjectsdev/metadata";
import { coerceRowOnRead, coerceRowOnWrite } from "./type-coercer.js";
import { decodeRef, encodeRef } from "./ref-codec.js";
import { runValidators } from "./validator-runner.js";
import { resolveIdentity } from "./identity-strategy.js";
import {
  viewFieldNames,
  fieldViewSpec, entityViewSpec,
  type FieldViewSpec, type EntityViewSpec,
} from "./view.js";
import type { ValidationResult } from "./validator-runner.js";
import {
  resolveRelationDescriptor, buildLazyRelateSpec, buildIncludeBatchSpec,
} from "./relation-resolver.js";
import {
  resolveN2mDescriptor, buildN2mLazySpecs, buildN2mBatchSpecs,
  resolveJoinColumnName,
} from "./n2m-resolver.js";
import { MetadataError, UnsafeNameError, ValidationError, NotFoundError } from "./errors.js";
import { VALID_ENTITY_NAME, DEFAULT_IF_MISSING } from "./constants.js";

export interface ObjectManagerOptions {
  metadata: MetaData;
  driver: PersistenceDriver;
  /**
   * Column-naming strategy for fields with no `@column` override. Defaults to
   * `"snake_case"`. Must agree with the codegen / migration config that
   * created the schema (a mismatch yields columns the runtime can't address).
   */
  columnNamingStrategy?: ColumnNamingStrategy;
}

export interface ReadOpts extends QueryOpts {
  view?: string;
  include?: string[];
  tx?: PersistenceDriver;
}

export interface WriteOpts {
  view?: string;
  tx?: PersistenceDriver;
  ifMissing?: "throw" | "ignore";
}

export class ObjectManager {
  private readonly metadata: MetaData;
  private readonly driver: PersistenceDriver;
  private readonly columnNamingStrategy: ColumnNamingStrategy;
  private readonly nameMapCache = new Map<string, EntityNameMap>();

  constructor(opts: ObjectManagerOptions) {
    this.metadata = opts.metadata;
    this.driver = opts.driver;
    this.columnNamingStrategy = opts.columnNamingStrategy ?? DEFAULT_COLUMN_NAMING_STRATEGY;
  }

  private nameMap(entity: MetaData): EntityNameMap {
    let m = this.nameMapCache.get(entity.name);
    if (!m) {
      m = buildNameMap(entity, this.columnNamingStrategy);
      this.nameMapCache.set(entity.name, m);
    }
    return m;
  }

  /** TPH discriminator scope for a subtype entity, or undefined for non-TPH. */
  private tphScope(entity: MetaData): DiscriminatorScope | undefined {
    const t = tphSubtypeOf(entity);
    return t ? { field: t.field, value: t.value } : undefined;
  }

  /** AND the TPH discriminator predicate into a filter (subtype-scoped reads). */
  private scopeFilter(filter: Filter | undefined, tph: TphSubtype | null): Filter | undefined {
    if (tph === null) return filter;
    const disc = { [tph.field]: { $eq: tph.value } } as Filter;
    if (filter === undefined) return disc;
    return { $and: [filter, disc] } as Filter;
  }

  async findById(entityName: string, id: unknown, opts: ReadOpts = {}): Promise<Row | null> {
    const entity = this.requireEntity(entityName);
    const pkField = resolvePkFields(entity)[0]!;
    return this.findFirst(entityName, { [pkField]: id as string | number }, opts);
  }

  async findFirst(entityName: string, filter: Filter, opts: ReadOpts = {}): Promise<Row | null> {
    const entity = this.requireEntity(entityName);
    const driver = opts.tx ?? this.driver;
    const scoped = this.scopeFilter(filter, tphSubtypeOf(entity));
    const spec = buildSelectSpec(entity, scoped, { ...opts, limit: 1 }, undefined, this.columnNamingStrategy);
    const row = await driver.selectOne(spec);
    if (row === null) return null;
    const jsRow = this.toJsRow(entity, row);
    if (opts.include && opts.include.length > 0) {
      await this.attachIncludes(entity, [jsRow], opts.include, driver);
    }
    return jsRow;
  }

  async findMany(entityName: string, filter?: Filter, opts: ReadOpts = {}): Promise<Row[]> {
    const entity = this.requireEntity(entityName);
    const driver = opts.tx ?? this.driver;
    const scoped = this.scopeFilter(filter, tphSubtypeOf(entity));
    const spec = buildSelectSpec(entity, scoped, opts, undefined, this.columnNamingStrategy);
    const rows = (await driver.selectMany(spec)).map((r) => this.toJsRow(entity, r));
    if (opts.include && opts.include.length > 0) {
      await this.attachIncludes(entity, rows, opts.include, driver);
    }
    return rows;
  }

  async count(entityName: string, filter?: Filter, opts: Pick<ReadOpts, "tx"> = {}): Promise<number> {
    const entity = this.requireEntity(entityName);
    const driver = opts.tx ?? this.driver;
    const scoped = this.scopeFilter(filter, tphSubtypeOf(entity));
    return driver.count(buildCountSpec(entity, scoped, this.columnNamingStrategy));
  }

  async load(refString: string): Promise<Row | null> {
    const { entity: entityName, pkValues } = decodeRef(refString);
    const entity = this.requireEntity(entityName);
    const pkFields = resolvePkFields(entity);
    if (pkValues.length !== pkFields.length) {
      throw new MetadataError(
        `Reference '${refString}' has ${pkValues.length} PK values; entity '${entityName}' expects ${pkFields.length}`,
        { entity: entityName },
      );
    }
    const filter: Filter = {};
    for (let i = 0; i < pkFields.length; i++) {
      const fieldName = pkFields[i]!;
      const rawValue = pkValues[i]!;
      filter[fieldName] = coercePkValue(entity, fieldName, rawValue);
    }
    return this.findFirst(entityName, filter);
  }

  refOf(entityName: string, record: Row): string {
    const entity = this.requireEntity(entityName);
    return encodeRef(entityName, record, resolvePkFields(entity));
  }

  async create(entityName: string, data: Row, opts: WriteOpts = {}): Promise<Row> {
    const entity = this.requireEntity(entityName);
    const driver = opts.tx ?? this.driver;

    const restricted0 = this.applyViewRestriction(entity, data, opts.view);
    // FR-017 TPH: a subtype create injects its discriminator value (the entity
    // names the subtype; the caller never sets it).
    const tph = tphSubtypeOf(entity);
    const restricted = tph ? { ...restricted0, [tph.field]: tph.value } : restricted0;
    const ident = resolveIdentity(entity, restricted);
    const merged: Row = { ...restricted, ...ident.values };

    const validation = runValidators(entity, merged);
    if (!validation.ok) {
      throw new ValidationError(formatValidationMessage(entityName, validation.errors), { entity: entityName, errors: validation.errors });
    }

    const coerced = coerceRowOnWrite(entity, merged, driver.dialect);
    const spec = buildInsertSpec(entity, coerced, this.columnNamingStrategy);
    const dbRow = await driver.insert(spec);
    return this.toJsRow(entity, dbRow);
  }

  async update(entityName: string, id: unknown, data: Row, opts: WriteOpts = {}): Promise<Row | null> {
    const entity = this.requireEntity(entityName);
    const driver = opts.tx ?? this.driver;

    const restricted0 = this.applyViewRestriction(entity, data, opts.view);
    // FR-017 TPH: the discriminator is immutable — a subtype can't be changed
    // into another subtype, so strip it from the patch before validating/writing.
    const tph = tphSubtypeOf(entity);
    let restricted = restricted0;
    if (tph && tph.field in restricted0) {
      const { [tph.field]: _omit, ...rest } = restricted0;
      restricted = rest;
    }

    // Partial mode: only validate fields the caller actually passed; absent keys are untouched.
    const validation = runValidators(entity, restricted, { partial: true });
    if (!validation.ok) {
      throw new ValidationError(formatValidationMessage(entityName, validation.errors), { entity: entityName, errors: validation.errors });
    }

    const coerced = coerceRowOnWrite(entity, restricted, driver.dialect);
    // FR-017 TPH: scope the by-id update to the subtype (cross-subtype → not found).
    const spec = buildUpdateSpec(entity, coerced, id, this.columnNamingStrategy, this.tphScope(entity));
    const dbRow = await driver.update(spec);
    if (dbRow === null) {
      const mode = opts.ifMissing ?? DEFAULT_IF_MISSING;
      if (mode === "throw") throw new NotFoundError(`${entityName} ${String(id)} not found`, { entity: entityName, id });
      return null;
    }
    return this.toJsRow(entity, dbRow);
  }

  async delete(entityName: string, id: unknown, opts: WriteOpts = {}): Promise<boolean> {
    const entity = this.requireEntity(entityName);
    const driver = opts.tx ?? this.driver;
    // FR-017 TPH: scope the by-id delete to the subtype (cross-subtype → not found).
    const spec = buildDeleteSpec(entity, id, this.columnNamingStrategy, this.tphScope(entity));
    const n = await driver.delete(spec);
    if (n === 0) {
      const mode = opts.ifMissing ?? DEFAULT_IF_MISSING;
      if (mode === "throw") throw new NotFoundError(`${entityName} ${String(id)} not found`, { entity: entityName, id });
      return false;
    }
    return true;
  }

  async createMany(entityName: string, dataArray: Row[], opts: WriteOpts = {}): Promise<Row[]> {
    const entity = this.requireEntity(entityName);
    const driver = opts.tx ?? this.driver;

    // Validate + identity-resolve every row before any insert so a late failure can't leave partial state.
    const validatedRows: Row[] = [];
    for (const data of dataArray) {
      const restricted = this.applyViewRestriction(entity, data, opts.view);
      const ident = resolveIdentity(entity, restricted);
      const merged: Row = { ...restricted, ...ident.values };
      const v = runValidators(entity, merged);
      if (!v.ok) {
        throw new ValidationError(formatValidationMessage(entityName, v.errors), { entity: entityName, errors: v.errors });
      }
      validatedRows.push(merged);
    }

    const spec: InsertManySpec = {
      table: resolveTableName(entity),
      rows: validatedRows.map((r) => this.toDbRow(entity, coerceRowOnWrite(entity, r, driver.dialect))),
      returning: this.allDbColumns(entity),
    };
    // Wrap the batch in a transaction so a driver-level constraint failure on row N
    // rolls back rows 1..N-1. Caller-supplied opts.tx already provides this.
    const dbRows = opts.tx
      ? await driver.insertMany(spec)
      : await driver.transaction((tx) => tx.insertMany(spec));
    return dbRows.map((r) => this.toJsRow(entity, r));
  }

  async updateMany(entityName: string, filter: Filter, partial: Row, opts: WriteOpts = {}): Promise<number> {
    const entity = this.requireEntity(entityName);
    const driver = opts.tx ?? this.driver;
    const restricted = this.applyViewRestriction(entity, partial, opts.view);
    const v = runValidators(entity, restricted, { partial: true });
    if (!v.ok) {
      throw new ValidationError(formatValidationMessage(entityName, v.errors), { entity: entityName, errors: v.errors });
    }

    const coerced = coerceRowOnWrite(entity, restricted, driver.dialect);
    const spec: UpdateManySpec = {
      table: resolveTableName(entity),
      values: this.toDbRow(entity, coerced),
      where: requireNonEmptyFilter(entity, filter, "updateMany", this.columnNamingStrategy),
    };
    return driver.updateMany(spec);
  }

  async deleteMany(entityName: string, filter: Filter, opts: WriteOpts = {}): Promise<number> {
    const entity = this.requireEntity(entityName);
    const driver = opts.tx ?? this.driver;
    const spec: DeleteManySpec = {
      table: resolveTableName(entity),
      where: requireNonEmptyFilter(entity, filter, "deleteMany", this.columnNamingStrategy),
    };
    return driver.deleteMany(spec);
  }

  async transaction<T>(fn: (txOm: ObjectManager) => Promise<T>): Promise<T> {
    return this.driver.transaction(async (txDriver) => {
      const txOm = new ObjectManager({
        metadata: this.metadata, driver: txDriver, columnNamingStrategy: this.columnNamingStrategy,
      });
      return fn(txOm);
    });
  }

  async relate(entityName: string, record: Row, relationName: string, opts: ReadOpts = {}): Promise<Row | Row[] | null> {
    const entity = this.requireEntity(entityName);
    const driver = opts.tx ?? this.driver;

    // N:M is checked first because its descriptor is more specific; fall through to 1:1/1:N otherwise.
    const n2m = resolveN2mDescriptor(entity, relationName, this.metadata);
    if (n2m !== null) {
      const target = this.requireEntity(n2m.targetEntityName);
      const { joinSpec, makeTargetSpec } = buildN2mLazySpecs(n2m, record, this.metadata, this.columnNamingStrategy);
      const joinRows = await driver.selectMany(joinSpec);
      const targetSpec = makeTargetSpec(joinRows);
      if (targetSpec === null) return [];
      const rows = await driver.selectMany(targetSpec);
      return rows.map((r) => this.toJsRow(target, r));
    }

    const desc = resolveRelationDescriptor(entity, relationName, this.metadata);
    const target = this.requireEntity(desc.targetEntityName);
    const spec = buildLazyRelateSpec(desc, record, this.metadata, this.columnNamingStrategy);
    if (spec === null) return desc.cardinality === "one" ? null : [];
    if (desc.cardinality === "one") {
      const row = await driver.selectOne(spec);
      return row === null ? null : this.toJsRow(target, row);
    }
    const rows = await driver.selectMany(spec);
    return rows.map((r) => this.toJsRow(target, r));
  }

  viewFields(entityName: string, viewName: string): string[] {
    return viewFieldNames(this.requireEntity(entityName), viewName);
  }

  fieldView(entityName: string, fieldName: string, viewName: string): FieldViewSpec | null {
    return fieldViewSpec(this.requireEntity(entityName), fieldName, viewName);
  }

  entityView(entityName: string, viewName: string): EntityViewSpec {
    return entityViewSpec(this.requireEntity(entityName), viewName);
  }

  validate(entityName: string, data: Row): ValidationResult {
    return runValidators(this.requireEntity(entityName), data);
  }

  private async attachIncludes(
    entity: MetaData,
    records: Row[],
    includes: string[],
    driver: PersistenceDriver,
  ): Promise<void> {
    for (const inc of includes) {
      if (inc.includes(".")) {
        throw new MetadataError(
          `Nested includes ('${inc}') are not supported in v0.1; flat includes only`,
          { entity: entity.name },
        );
      }

      const n2m = resolveN2mDescriptor(entity, inc, this.metadata);
      if (n2m !== null) {
        const target = this.requireEntity(n2m.targetEntityName);
        const { joinSpec, makeTargetSpec } = buildN2mBatchSpecs(n2m, records, this.metadata, this.columnNamingStrategy);
        const joinRows = await driver.selectMany(joinSpec);
        const targetSpec = makeTargetSpec(joinRows);
        const targetRows = targetSpec === null ? [] : (await driver.selectMany(targetSpec)).map((r) => this.toJsRow(target, r));

        const sourcePk = resolvePkFields(entity)[0]!;
        const joinEntity = this.requireEntity(n2m.joinEntityName);
        const sourceJoinDbCol = resolveJoinColumnName(joinEntity, n2m.sourceJoinField, this.columnNamingStrategy);
        const targetJoinDbCol = resolveJoinColumnName(joinEntity, n2m.targetJoinField, this.columnNamingStrategy);
        const targetPk = resolvePkFields(target)[0]!;
        // Key everything by String(): the join rows are raw (a BIGINT FK arrives
        // as a string from the driver) while the JS rows' keys are coerced, so a
        // number↔string mismatch would silently drop matches.
        const key = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
        const targetById = new Map(targetRows.map((r) => [key(r[targetPk]), r]));
        const sourceKeys = new Set(records.map((r) => key(r[sourcePk])));
        const grouped = new Map<string, Row[]>();
        const attach = (ownerKey: string | null, relatedKey: string | null): void => {
          if (ownerKey === null) return;
          const t = relatedKey === null ? undefined : targetById.get(relatedKey);
          if (!t) return;
          if (!grouped.has(ownerKey)) grouped.set(ownerKey, []);
          grouped.get(ownerKey)!.push(t);
        };
        for (const j of joinRows) {
          const a = key(j[sourceJoinDbCol]);
          const b = key(j[targetJoinDbCol]);
          if (n2m.symmetric) {
            // Union-on-read: a row (a,b) relates a↔b. Attach to whichever
            // endpoint(s) are in this batch; the related id is the OTHER one.
            if (a !== null && sourceKeys.has(a)) attach(a, b);
            if (b !== null && a !== b && sourceKeys.has(b)) attach(b, a);
          } else {
            attach(a, b);
          }
        }
        for (const r of records) r[inc] = grouped.get(key(r[sourcePk]) ?? "\0") ?? [];
        continue;
      }

      const desc = resolveRelationDescriptor(entity, inc, this.metadata);
      const target = this.requireEntity(desc.targetEntityName);
      const spec = buildIncludeBatchSpec(desc, records, this.metadata, this.columnNamingStrategy);
      const targetRows = spec === null ? [] : (await driver.selectMany(spec)).map((r) => this.toJsRow(target, r));

      if (desc.cardinality === "one") {
        const byKey = new Map(targetRows.map((r) => [r[desc.targetField], r]));
        for (const r of records) r[inc] = byKey.get(r[desc.sourceField]) ?? null;
      } else {
        const grouped = new Map<unknown, Row[]>();
        for (const t of targetRows) {
          const k = t[desc.targetField];
          if (!grouped.has(k)) grouped.set(k, []);
          grouped.get(k)!.push(t);
        }
        for (const r of records) r[inc] = grouped.get(r[desc.sourceField]) ?? [];
      }
    }
  }

  private toDbRow(entity: MetaData, jsRow: Row): Row {
    const { jsToDb } = this.nameMap(entity);
    const out: Row = {};
    for (const [jsName, dbCol] of jsToDb) {
      if (jsName in jsRow) out[dbCol] = jsRow[jsName];
    }
    return out;
  }

  private allDbColumns(entity: MetaData): string[] {
    return [...this.nameMap(entity).jsToDb.values()];
  }

  private applyViewRestriction(entity: MetaData, data: Row, viewName: string | undefined): Row {
    if (viewName === undefined) return data;
    const allowed = new Set(viewFieldNames(entity, viewName));
    const offending = Object.keys(data).filter((k) => !allowed.has(k));
    if (offending.length > 0) {
      throw new ValidationError(
        `View '${viewName}' on '${entity.name}' does not allow fields: ${offending.join(", ")}`,
        {
          entity: entity.name,
          errors: offending.map((field) => ({
            field, rule: "view_restricted",
            message: `Field '${field}' is not in view '${viewName}'`,
          })),
        },
      );
    }
    return data;
  }

  private requireEntity(entityName: string): MetaData {
    if (!VALID_ENTITY_NAME.test(entityName)) {
      throw new UnsafeNameError(
        `Unsafe entity name '${entityName}'`,
        { value: entityName },
      );
    }
    const entity = this.metadata.ownChildren().find((c) => c.type === TYPE_OBJECT && c.name === entityName);
    if (!entity) {
      throw new MetadataError(`Unknown entity '${entityName}'`, { entity: entityName });
    }
    return entity;
  }

  private toJsRow(entity: MetaData, dbRow: Row): Row {
    const { dbToJs } = this.nameMap(entity);
    const out: Row = {};
    for (const [dbCol, jsName] of dbToJs) {
      if (dbCol in dbRow) out[jsName] = dbRow[dbCol];
    }
    return coerceRowOnRead(entity, out, this.driver.dialect);
  }
}

// updateMany / deleteMany with an empty filter would silently affect every row.
// Force callers to be explicit (use $or-style or a tautology if they really mean "all").
function requireNonEmptyFilter(
  entity: MetaData, filter: Filter, op: string, strategy: ColumnNamingStrategy,
): WhereClause {
  const where = compileFilter(entity, filter, strategy);
  if (where === null) {
    throw new MetadataError(
      `${op} on '${entity.name}' requires a non-empty filter — pass an explicit condition or use a per-row loop`,
      { entity: entity.name },
    );
  }
  return where;
}

function formatValidationMessage(entityName: string, errors: { field: string; rule: string }[]): string {
  const summary = errors.map((e) => `${e.field}: ${e.rule}`).join("; ");
  return `Validation failed for ${entityName} (${summary})`;
}

const NUMERIC_SUBTYPES = new Set([
  FIELD_SUBTYPE_INT, FIELD_SUBTYPE_SHORT, FIELD_SUBTYPE_BYTE,
  FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_DOUBLE, FIELD_SUBTYPE_FLOAT, FIELD_SUBTYPE_DECIMAL,
]);

// decodeRef always returns strings; numeric PK fields need coercion back to number.
function coercePkValue(entity: MetaData, fieldName: string, rawValue: string): string | number {
  const field = entity.ownChildren().find((c) => c.type === TYPE_FIELD && c.name === fieldName);
  if (field && NUMERIC_SUBTYPES.has(field.subType)) {
    const n = Number(rawValue);
    if (!Number.isNaN(n)) return n;
  }
  return rawValue;
}
