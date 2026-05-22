// Two-stage N:M: first query the join entity for FK pairs, then query the target entity for the rows.
// The relationship declares @joinEntity + @joinFields: [sourceJoinField, targetJoinField].

import type { MetaData } from "@metaobjectsdev/metadata";
import {
  TYPE_OBJECT, TYPE_FIELD, TYPE_RELATIONSHIP,
  RELATIONSHIP_ATTR_CARDINALITY, RELATIONSHIP_ATTR_OBJECT_REF,
  RELATIONSHIP_ATTR_JOIN_ENTITY, RELATIONSHIP_ATTR_JOIN_FIELDS,
  CARDINALITY_MANY,
  resolveColumnName,
} from "@metaobjectsdev/metadata";
import { MetadataError } from "./errors.js";
import { buildSelectSpec, resolvePkFields } from "./query-builder.js";
import type { SelectSpec, PrimitiveValue, Row } from "./persistence-driver.js";

export interface N2mDescriptor {
  /** Entity that declares the relationship (source of the lookup; its PK feeds sourceJoinField). */
  sourceEntityName: string;
  targetEntityName: string;
  joinEntityName: string;
  /** Field name on the join entity holding the source-side FK. */
  sourceJoinField: string;
  /** Field name on the join entity holding the target-side FK. */
  targetJoinField: string;
}

export interface N2mLazyOutput {
  joinSpec: SelectSpec;
  /** Caller runs joinSpec, then passes the rows here to build the target spec. */
  makeTargetSpec: (joinRows: Row[]) => SelectSpec | null;
}

export interface N2mBatchOutput {
  joinSpec: SelectSpec;
  makeTargetSpec: (joinRows: Row[]) => SelectSpec | null;
}

/** Returns null if the named relationship is not N:M — caller should try resolveRelationDescriptor. */
export function resolveN2mDescriptor(
  sourceEntity: MetaData,
  relationName: string,
  root: MetaData,
): N2mDescriptor | null {
  for (const child of sourceEntity.ownChildren()) {
    if (child.type !== TYPE_RELATIONSHIP) continue;
    if (child.name !== relationName) continue;
    if (child.ownAttr(RELATIONSHIP_ATTR_CARDINALITY) !== CARDINALITY_MANY) continue;
    const targetEntityName = child.ownAttr(RELATIONSHIP_ATTR_OBJECT_REF) as string | undefined;
    const joinEntityName = child.ownAttr(RELATIONSHIP_ATTR_JOIN_ENTITY) as string | undefined;
    const joinFields = child.ownAttr(RELATIONSHIP_ATTR_JOIN_FIELDS);
    if (!targetEntityName || !joinEntityName || !Array.isArray(joinFields) || joinFields.length !== 2) {
      throw new MetadataError(
        `N:M relationship '${relationName}' on '${sourceEntity.name}' requires @objectRef + @joinEntity + @joinFields: [sourceFk, targetFk]`,
        { entity: sourceEntity.name },
      );
    }
    const targetExists = root.ownChildren().some((c) => c.type === TYPE_OBJECT && c.name === targetEntityName);
    if (!targetExists) {
      throw new MetadataError(`Target entity '${targetEntityName}' not found`, { entity: sourceEntity.name });
    }
    const joinExists = root.ownChildren().some((c) => c.type === TYPE_OBJECT && c.name === joinEntityName);
    if (!joinExists) {
      throw new MetadataError(`Join entity '${joinEntityName}' not found`, { entity: sourceEntity.name });
    }
    return {
      sourceEntityName: sourceEntity.name,
      targetEntityName,
      joinEntityName,
      sourceJoinField: String(joinFields[0]),
      targetJoinField: String(joinFields[1]),
    };
  }
  return null;
}

export function buildN2mLazySpecs(
  desc: N2mDescriptor,
  sourceRecord: Row,
  root: MetaData,
): N2mLazyOutput {
  const joinEntity = mustGetEntity(root, desc.joinEntityName);
  const targetEntity = mustGetEntity(root, desc.targetEntityName);
  const sourcePkField = resolvePkFields(mustGetEntity(root, desc.sourceEntityName))[0]!;
  const sourcePkValue = sourceRecord[sourcePkField];

  const joinSpec = buildSelectSpec(joinEntity, { [desc.sourceJoinField]: sourcePkValue as PrimitiveValue }, {});

  const makeTargetSpec = (joinRows: Row[]): SelectSpec | null => {
    const targetIds = collectTargetIds(joinRows, desc.targetJoinField, joinEntity);
    if (targetIds.length === 0) return null;
    const targetPkField = resolvePkFields(targetEntity)[0]!;
    return buildSelectSpec(targetEntity, { [targetPkField]: targetIds }, {});
  };

  return { joinSpec, makeTargetSpec };
}

export function buildN2mBatchSpecs(
  desc: N2mDescriptor,
  sourceRecords: Row[],
  root: MetaData,
): N2mBatchOutput {
  const joinEntity = mustGetEntity(root, desc.joinEntityName);
  const targetEntity = mustGetEntity(root, desc.targetEntityName);
  const sourcePkField = resolvePkFields(mustGetEntity(root, desc.sourceEntityName))[0]!;
  const sourceIds = collectIds(sourceRecords, sourcePkField);

  const joinSpec = buildSelectSpec(joinEntity, { [desc.sourceJoinField]: sourceIds }, {});

  const makeTargetSpec = (joinRows: Row[]): SelectSpec | null => {
    const targetIds = collectTargetIds(joinRows, desc.targetJoinField, joinEntity);
    if (targetIds.length === 0) return null;
    const targetPkField = resolvePkFields(targetEntity)[0]!;
    return buildSelectSpec(targetEntity, { [targetPkField]: targetIds }, {});
  };

  return { joinSpec, makeTargetSpec };
}

function mustGetEntity(root: MetaData, name: string): MetaData {
  const e = root.ownChildren().find((c) => c.type === TYPE_OBJECT && c.name === name);
  if (!e) throw new MetadataError(`Entity '${name}' not found`, { entity: name });
  return e;
}

function collectIds(records: Row[], pkField: string): (string | number)[] {
  const seen = new Set<PrimitiveValue>();
  for (const r of records) {
    const v = r[pkField];
    if (v === null || v === undefined) continue;
    seen.add(v as PrimitiveValue);
  }
  return [...seen] as (string | number)[];
}

function collectTargetIds(joinRows: Row[], targetJoinField: string, joinEntity: MetaData): (string | number)[] {
  // joinRows are raw column-keyed (driver hasn't been to-JS-row'd yet); resolve the metadata field name to its DB column.
  const dbColumn = resolveJoinColumnName(joinEntity, targetJoinField);
  const seen = new Set<PrimitiveValue>();
  for (const r of joinRows) {
    const v = r[dbColumn];
    if (v === null || v === undefined) continue;
    seen.add(v as PrimitiveValue);
  }
  return [...seen] as (string | number)[];
}

export function resolveJoinColumnName(joinEntity: MetaData, fieldName: string): string {
  const field = joinEntity.ownChildren().find((c) => c.type === TYPE_FIELD && c.name === fieldName);
  if (!field) throw new MetadataError(`Join field '${fieldName}' not on '${joinEntity.name}'`);
  return resolveColumnName(field);
}
