import type { ColumnNamingStrategy, MetaData } from "@metaobjectsdev/metadata";
import {
  TYPE_OBJECT, TYPE_RELATIONSHIP, TYPE_IDENTITY,
  IDENTITY_SUBTYPE_REFERENCE,
  IDENTITY_ATTR_FIELDS,
  IDENTITY_REFERENCE_ATTR_REFERENCES,
  RELATIONSHIP_ATTR_CARDINALITY, RELATIONSHIP_ATTR_OBJECT_REF,
  CARDINALITY_ONE, CARDINALITY_MANY,
  DEFAULT_COLUMN_NAMING_STRATEGY,
} from "@metaobjectsdev/metadata";
import { MetadataError } from "./errors.js";
import {
  buildSelectSpec, resolvePkFields,
} from "./query-builder.js";
import type { SelectSpec, PrimitiveValue, Row } from "./persistence-driver.js";

export interface RelationDescriptor {
  /** "one" = source holds the FK pointing at target. "many" = target holds the FK pointing back at source. */
  cardinality: typeof CARDINALITY_ONE | typeof CARDINALITY_MANY;
  /** Entity name we're loading rows OF. */
  targetEntityName: string;
  /** Field on the source record to read the lookup value from (one-side: FK column; many-side: source PK). */
  sourceField: string;
  /** Field on the target table to filter by (one-side: target PK; many-side: back-pointing FK). */
  targetField: string;
}

/**
 * Find an identity.reference declared on `holder` whose @references targets `targetName`.
 * Returns the FK field name (first field on the identity) or undefined.
 */
function findReferenceFkField(holder: MetaData, targetName: string): string | undefined {
  for (const child of holder.ownChildren()) {
    if (child.type !== TYPE_IDENTITY) continue;
    if (child.subType !== IDENTITY_SUBTYPE_REFERENCE) continue;
    const ref = child.ownAttr(IDENTITY_REFERENCE_ATTR_REFERENCES);
    if (typeof ref !== "string") continue;
    const dotIdx = ref.indexOf(".");
    const entityName = dotIdx === -1 ? ref : ref.slice(0, dotIdx);
    if (entityName !== targetName) continue;
    const fields = child.ownAttr(IDENTITY_ATTR_FIELDS);
    if (Array.isArray(fields) && fields.length > 0) return String(fields[0]);
    if (typeof fields === "string") {
      const first = fields.split(",")[0]?.trim();
      if (first) return first;
    }
  }
  return undefined;
}

/**
 * Walks one-side (relationship children of `sourceEntity`) then many-side (relationship
 * children of any OTHER entity pointing to `sourceEntity`). The inverse-side relation name
 * is computed via the same convention as SP2's relation-resolver: variableNameFromEntity
 * (lower-camel + plural) of the declaring source.
 *
 * FK direction is sourced from identity.reference declarations, not relationship attrs.
 */
export function resolveRelationDescriptor(
  sourceEntity: MetaData,
  relationName: string,
  root: MetaData,
): RelationDescriptor {
  for (const child of sourceEntity.ownChildren()) {
    if (child.type !== TYPE_RELATIONSHIP) continue;
    if (child.name !== relationName) continue;
    const card = child.ownAttr(RELATIONSHIP_ATTR_CARDINALITY);
    if (card !== CARDINALITY_ONE) continue;
    const targetEntityName = child.ownAttr(RELATIONSHIP_ATTR_OBJECT_REF) as string | undefined;
    if (!targetEntityName) {
      throw new MetadataError(
        `Relationship '${relationName}' on '${sourceEntity.name}' missing @objectRef`,
        { entity: sourceEntity.name },
      );
    }
    const fkField = findReferenceFkField(sourceEntity, targetEntityName);
    if (!fkField) {
      throw new MetadataError(
        `Relationship '${relationName}' on '${sourceEntity.name}' has no identity.reference targeting '${targetEntityName}'`,
        { entity: sourceEntity.name },
      );
    }
    const target = root.ownChildren().find((c) => c.type === TYPE_OBJECT && c.name === targetEntityName);
    if (!target) {
      throw new MetadataError(
        `Target entity '${targetEntityName}' not found for relation '${relationName}' on '${sourceEntity.name}'`,
        { entity: sourceEntity.name },
      );
    }
    return {
      cardinality: "one",
      targetEntityName,
      sourceField: fkField,
      targetField: resolvePkFields(target)[0]!,
    };
  }

  for (const other of root.ownChildren()) {
    if (other.type !== TYPE_OBJECT) continue;
    if (other.name === sourceEntity.name) continue;
    for (const child of other.ownChildren()) {
      if (child.type !== TYPE_RELATIONSHIP) continue;
      const card = child.ownAttr(RELATIONSHIP_ATTR_CARDINALITY);
      if (card !== CARDINALITY_ONE) continue;
      const targetEntityName = child.ownAttr(RELATIONSHIP_ATTR_OBJECT_REF) as string | undefined;
      if (targetEntityName !== sourceEntity.name) continue;
      const inverseName = inversePluralName(other.name);
      if (inverseName !== relationName) continue;
      const fkField = findReferenceFkField(other, sourceEntity.name);
      if (!fkField) {
        throw new MetadataError(
          `Inverse relationship for '${relationName}' on '${sourceEntity.name}': entity '${other.name}' has no identity.reference targeting '${sourceEntity.name}'`,
          { entity: sourceEntity.name },
        );
      }
      return {
        cardinality: "many",
        targetEntityName: other.name,
        sourceField: resolvePkFields(sourceEntity)[0]!,
        targetField: fkField,
      };
    }
  }

  throw new MetadataError(
    `Unknown relation '${relationName}' on entity '${sourceEntity.name}'`,
    { entity: sourceEntity.name },
  );
}

// Mirrors codegen-ts's variableNameFromEntity: lower-camel + plural.
function inversePluralName(entityName: string): string {
  const camel = entityName.charAt(0).toLowerCase() + entityName.slice(1);
  if (/(s|x|z|ch|sh)$/i.test(camel)) return camel + "es";
  if (/[^aeiou]y$/i.test(camel)) return camel.slice(0, -1) + "ies";
  return camel + "s";
}

/** Returns null when the source-side lookup value is null — caller returns null/[]. */
export function buildLazyRelateSpec(
  desc: RelationDescriptor,
  sourceRecord: Row,
  root: MetaData,
  strategy: ColumnNamingStrategy = DEFAULT_COLUMN_NAMING_STRATEGY,
): SelectSpec | null {
  const lookup = sourceRecord[desc.sourceField];
  if (lookup === null || lookup === undefined) return null;
  const target = mustGetEntity(root, desc.targetEntityName);
  return buildSelectSpec(target, { [desc.targetField]: lookup as PrimitiveValue }, {}, undefined, strategy);
}

/** Builds one batched IN(...) lookup. Returns null when there are no non-null source values. */
export function buildIncludeBatchSpec(
  desc: RelationDescriptor,
  sourceRecords: Row[],
  root: MetaData,
  strategy: ColumnNamingStrategy = DEFAULT_COLUMN_NAMING_STRATEGY,
): SelectSpec | null {
  const seen = new Set<PrimitiveValue>();
  for (const rec of sourceRecords) {
    const v = rec[desc.sourceField];
    if (v === null || v === undefined) continue;
    seen.add(v as PrimitiveValue);
  }
  if (seen.size === 0) return null;
  const target = mustGetEntity(root, desc.targetEntityName);
  return buildSelectSpec(target, { [desc.targetField]: [...seen] as (string | number)[] }, {}, undefined, strategy);
}

function mustGetEntity(root: MetaData, name: string): MetaData {
  const e = root.ownChildren().find((c) => c.type === TYPE_OBJECT && c.name === name);
  if (!e) throw new MetadataError(`Entity '${name}' not found`, { entity: name });
  return e;
}
