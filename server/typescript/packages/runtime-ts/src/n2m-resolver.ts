// Two-stage M:N resolution.
//
// A M:N relationship declares only the slim FR-017 vocabulary on the source
// entity: `@cardinality: "many"` + `@objectRef: <target>` + `@through:
// <junction>` (plus optional `@sourceRefField` / `@symmetric` for self-joins).
// It does NOT restate the junction FK columns — those are DERIVED from the
// junction entity's two `identity.reference` children via the shared
// `deriveM2MFields` helper (the SSOT for FK direction, the same one the loader
// validator + every other port use). This kills the pre-FR-017 stopgap that
// read `@joinEntity` / `@joinFields` off the relationship.
//
// Resolution has three modes (see the FR-017 design):
//   1. Hetero (source != target): junction WHERE sourceField (IN|=) source.pk,
//      collect targetField, then target WHERE pk IN (...).
//   2. Directed self-join (`@sourceRefField`): identical traversal; the helper
//      has already picked which junction FK is the source side.
//   3. Symmetric self-join (`@symmetric: true`): single-row storage, union on
//      read — junction WHERE sourceField (IN|=) id OR targetField (IN|=) id;
//      for each row the related id is whichever FK column is NOT the source id.

import type { ColumnNamingStrategy, MetaData, MetaObject, MetaRoot } from "@metaobjectsdev/metadata";
import {
  TYPE_OBJECT, TYPE_FIELD, TYPE_RELATIONSHIP,
  RELATIONSHIP_ATTR_CARDINALITY, RELATIONSHIP_ATTR_OBJECT_REF, RELATIONSHIP_ATTR_THROUGH,
  CARDINALITY_MANY,
  DEFAULT_COLUMN_NAMING_STRATEGY,
  resolveColumnName,
  deriveM2MFields,
} from "@metaobjectsdev/metadata";
import type { MetaRelationship } from "@metaobjectsdev/metadata";
import { MetadataError } from "./errors.js";
import { buildSelectSpec, resolvePkFields } from "./query-builder.js";
import type { SelectSpec, WhereClause, PrimitiveValue, Row } from "./persistence-driver.js";

export interface N2mDescriptor {
  /** Entity that declares the relationship (source of the lookup; its PK feeds sourceField). */
  sourceEntityName: string;
  targetEntityName: string;
  joinEntityName: string;
  /** Junction FK field holding the source-side key (derived from the junction's references). */
  sourceJoinField: string;
  /** Junction FK field holding the target-side key (derived from the junction's references). */
  targetJoinField: string;
  /** Undirected self-join: union both junction FK columns at read time. */
  symmetric: boolean;
}

export interface N2mLazyOutput {
  joinSpec: SelectSpec;
  /** Caller runs joinSpec, then passes the rows here to build the target spec. */
  makeTargetSpec: (joinRows: Row[]) => SelectSpec | null;
}

export type N2mBatchOutput = N2mLazyOutput;

/** Returns null if the named relationship is not M:N — caller should try resolveRelationDescriptor. */
export function resolveN2mDescriptor(
  sourceEntity: MetaData,
  relationName: string,
  root: MetaData,
): N2mDescriptor | null {
  for (const child of sourceEntity.ownChildren()) {
    if (child.type !== TYPE_RELATIONSHIP) continue;
    if (child.name !== relationName) continue;
    if (child.ownAttr(RELATIONSHIP_ATTR_CARDINALITY) !== CARDINALITY_MANY) continue;
    if (child.ownAttr(RELATIONSHIP_ATTR_THROUGH) === undefined) continue; // 1:N many — not M:N.

    const rel = child as MetaRelationship;
    const targetEntityName = rel.ownAttr(RELATIONSHIP_ATTR_OBJECT_REF) as string | undefined;
    const joinEntityName = rel.ownAttr(RELATIONSHIP_ATTR_THROUGH) as string | undefined;
    if (!targetEntityName || !joinEntityName) {
      throw new MetadataError(
        `M:N relationship '${relationName}' on '${sourceEntity.name}' requires @objectRef + @through`,
        { entity: sourceEntity.name },
      );
    }

    // Derive the [sourceFK, targetFK] junction columns from the junction's two
    // identity.reference children (handles hetero / directed / symmetric).
    let fields;
    try {
      fields = deriveM2MFields(rel, sourceEntity as MetaObject, root as MetaRoot);
    } catch (e) {
      throw new MetadataError(
        `M:N relationship '${relationName}' on '${sourceEntity.name}': ${(e as Error).message}`,
        { entity: sourceEntity.name },
      );
    }

    return {
      sourceEntityName: sourceEntity.name,
      targetEntityName,
      joinEntityName,
      sourceJoinField: fields.sourceField,
      targetJoinField: fields.targetField,
      symmetric: rel.symmetric,
    };
  }
  return null;
}

export function buildN2mLazySpecs(
  desc: N2mDescriptor,
  sourceRecord: Row,
  root: MetaData,
  strategy: ColumnNamingStrategy = DEFAULT_COLUMN_NAMING_STRATEGY,
): N2mLazyOutput {
  return buildSpecs(desc, sourceRecord, root, strategy);
}

export function buildN2mBatchSpecs(
  desc: N2mDescriptor,
  sourceRecords: Row[],
  root: MetaData,
  strategy: ColumnNamingStrategy = DEFAULT_COLUMN_NAMING_STRATEGY,
): N2mBatchOutput {
  return buildSpecs(desc, sourceRecords, root, strategy);
}

// Single + batch share one code path: a single record is the one-element case.
function buildSpecs(
  desc: N2mDescriptor,
  source: Row | Row[],
  root: MetaData,
  strategy: ColumnNamingStrategy,
): N2mLazyOutput {
  const joinEntity = mustGetEntity(root, desc.joinEntityName);
  const targetEntity = mustGetEntity(root, desc.targetEntityName);
  const sourceEntity = mustGetEntity(root, desc.sourceEntityName);
  const sourcePkField = resolvePkFields(sourceEntity)[0]!;

  const records = Array.isArray(source) ? source : [source];
  const sourceIds = collectIds(records, sourcePkField);
  const sourceIdSet = new Set<PrimitiveValue>(sourceIds);

  const sourceCol = resolveJoinColumnName(joinEntity, desc.sourceJoinField, strategy);
  const targetCol = resolveJoinColumnName(joinEntity, desc.targetJoinField, strategy);

  // buildSelectSpec compiles a filter on the entity's fields; for symmetric we
  // need an OR across two columns, which the filter DSL can't express. So we
  // build the join spec directly off buildSelectSpec then swap in the where.
  const joinSpec = buildSelectSpec(joinEntity, undefined, {}, undefined, strategy);
  joinSpec.where = desc.symmetric
    ? { kind: "or", clauses: [inOrEq(sourceCol, sourceIds), inOrEq(targetCol, sourceIds)] }
    : inOrEq(sourceCol, sourceIds);

  const makeTargetSpec = (joinRows: Row[]): SelectSpec | null => {
    const targetIds = desc.symmetric
      ? collectSymmetricTargetIds(joinRows, sourceCol, targetCol, sourceIdSet)
      : collectColumnIds(joinRows, targetCol);
    if (targetIds.length === 0) return null;
    const targetPkField = resolvePkFields(targetEntity)[0]!;
    // PK values are always string|number; the IN filter type excludes boolean.
    const ids = targetIds.filter((v): v is string | number => typeof v !== "boolean");
    return buildSelectSpec(targetEntity, { [targetPkField]: ids }, {}, undefined, strategy);
  };

  return { joinSpec, makeTargetSpec };
}

/** `= x` for a single id, `IN (...)` for many (degenerate empty → IN [] = no rows). */
function inOrEq(column: string, ids: PrimitiveValue[]): WhereClause {
  return ids.length === 1
    ? { kind: "eq", column, value: ids[0]! }
    : { kind: "in", column, values: ids };
}

function mustGetEntity(root: MetaData, name: string): MetaData {
  const e = root.ownChildren().find((c) => c.type === TYPE_OBJECT && c.name === name);
  if (!e) throw new MetadataError(`Entity '${name}' not found`, { entity: name });
  return e;
}

function collectIds(records: Row[], pkField: string): PrimitiveValue[] {
  const seen = new Set<PrimitiveValue>();
  for (const r of records) {
    const v = r[pkField];
    if (v === null || v === undefined) continue;
    seen.add(v as PrimitiveValue);
  }
  return [...seen];
}

/** Distinct values of a raw (column-keyed) join column. */
function collectColumnIds(joinRows: Row[], dbColumn: string): PrimitiveValue[] {
  const seen = new Set<PrimitiveValue>();
  for (const r of joinRows) {
    const v = r[dbColumn];
    if (v === null || v === undefined) continue;
    seen.add(v as PrimitiveValue);
  }
  return [...seen];
}

/**
 * Symmetric union-on-read: this gathers the set of related ids to FETCH for the
 * second-stage query. For each junction row (a,b) that surfaced via the
 * `a IN ids OR b IN ids` join filter, the related endpoint is the column that is
 * NOT a source — EXCEPT when BOTH columns are sources (two mutually-related
 * records queried in the same batch), where both must be fetched so the
 * eager-include grouping can attach a→b AND b→a. A self-loop row (a==b, a a
 * source) yields a itself.
 *
 * Membership is compared by string-coerced key: the source ids come from the
 * in-process source record (e.g. a JS number) while the junction FK values come
 * straight off the driver, where a BIGINT key arrives as a string. Comparing
 * raw would miss the match (number 1 !== string "1"); string keys bridge it.
 */
function collectSymmetricTargetIds(
  joinRows: Row[], sourceCol: string, targetCol: string, sourceIds: Set<PrimitiveValue>,
): PrimitiveValue[] {
  const sourceKeys = new Set<string>([...sourceIds].map(String));
  const seen = new Set<PrimitiveValue>();
  const add = (v: PrimitiveValue | null | undefined): void => {
    if (v === null || v === undefined) return;
    seen.add(v);
  };
  for (const r of joinRows) {
    const a = r[sourceCol] as PrimitiveValue | null | undefined;
    const b = r[targetCol] as PrimitiveValue | null | undefined;
    const aIsSource = a !== null && a !== undefined && sourceKeys.has(String(a));
    const bIsSource = b !== null && b !== undefined && sourceKeys.has(String(b));
    // When a is a source, b is its related id; when b is a source, a is its
    // related id. Both can hold at once (mutually-related batch members) — fetch
    // both endpoints then. Falls back to "the non-matched column" when only one
    // side matched (the common single-source-lookup case).
    if (aIsSource) add(b);
    if (bIsSource) add(a);
    if (!aIsSource && !bIsSource) {
      // Row surfaced via the join filter but neither column string-matches a
      // source id (e.g. number/string skew not bridged here) — keep prior
      // behavior: take whichever side is present.
      add(a ?? b);
    }
  }
  return [...seen];
}

export function resolveJoinColumnName(
  joinEntity: MetaData, fieldName: string,
  strategy: ColumnNamingStrategy = DEFAULT_COLUMN_NAMING_STRATEGY,
): string {
  const field = joinEntity.ownChildren().find((c) => c.type === TYPE_FIELD && c.name === fieldName);
  if (!field) throw new MetadataError(`Join field '${fieldName}' not on '${joinEntity.name}'`);
  return resolveColumnName(field, strategy);
}
