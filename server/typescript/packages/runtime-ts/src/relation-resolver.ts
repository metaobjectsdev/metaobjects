import type { ColumnNamingStrategy, MetaData, MetaObject } from "@metaobjectsdev/metadata";
import {
  TYPE_OBJECT, TYPE_RELATIONSHIP,
  RELATIONSHIP_ATTR_CARDINALITY, RELATIONSHIP_ATTR_OBJECT_REF,
  RELATIONSHIP_ATTR_SOURCE_REF_FIELD,
  CARDINALITY_ONE, CARDINALITY_MANY,
  DEFAULT_COLUMN_NAMING_STRATEGY,
  resolveRelationshipReference,
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
 * The FK field a `@cardinality: one` relationship navigates through.
 * #368: an entity may declare several identity.reference nodes onto the same
 * target, so the target alone is not enough — resolve through the shared ladder.
 */
function findReferenceFkField(
  holder: MetaData,
  targetName: string,
  relationshipName: string,
  sourceRefField?: string,
): string | undefined {
  const ref = resolveRelationshipReference(
    holder as unknown as MetaObject, relationshipName, targetName, sourceRefField,
  );
  return ref?.fields[0];
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
  // ADR-0039: effective children — a relationship may be inherited via extends.
  for (const child of sourceEntity.children()) {
    if (child.type !== TYPE_RELATIONSHIP) continue;
    if (child.name !== relationName) continue;
    // ADR-0039: effective attrs — @cardinality/@objectRef may be inherited.
    const card = child.attr(RELATIONSHIP_ATTR_CARDINALITY);
    if (card !== CARDINALITY_ONE) continue;
    const targetEntityName = child.attr(RELATIONSHIP_ATTR_OBJECT_REF) as string | undefined;
    if (!targetEntityName) {
      throw new MetadataError(
        `Relationship '${relationName}' on '${sourceEntity.name}' missing @objectRef`,
        { entity: sourceEntity.name },
      );
    }
    // ADR-0039: resolving — @sourceRefField may be inherited via extends.
    const declaredRefField = child.attr(RELATIONSHIP_ATTR_SOURCE_REF_FIELD) as string | undefined;
    const fkField = findReferenceFkField(sourceEntity, targetEntityName, child.name, declaredRefField);
    if (!fkField) {
      throw new MetadataError(
        `Relationship '${relationName}' on '${sourceEntity.name}' has no identity.reference targeting '${targetEntityName}'`,
        { entity: sourceEntity.name },
      );
    }
    // ADR-0039: effective children — resolve rather than rely on root being unextended.
    const target = root.children().find((c) => c.type === TYPE_OBJECT && c.name === targetEntityName);
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

  // ADR-0039: effective children — resolve rather than rely on root being unextended.
  for (const other of root.children()) {
    if (other.type !== TYPE_OBJECT) continue;
    if (other.name === sourceEntity.name) continue;
    // ADR-0039: effective children — a relationship may be inherited via extends.
    for (const child of other.children()) {
      if (child.type !== TYPE_RELATIONSHIP) continue;
      // ADR-0039: effective attrs — @cardinality/@objectRef may be inherited.
      const card = child.attr(RELATIONSHIP_ATTR_CARDINALITY);
      if (card !== CARDINALITY_ONE) continue;
      const targetEntityName = child.attr(RELATIONSHIP_ATTR_OBJECT_REF) as string | undefined;
      if (targetEntityName !== sourceEntity.name) continue;
      const inverseName = inversePluralName(other.name);
      if (inverseName !== relationName) continue;
      // ADR-0039: resolving — @sourceRefField may be inherited via extends. This
      // FK lives on `other` and belongs to `other`'s own relationship `child` —
      // not to anything declared on sourceEntity (see #368 module comment).
      const declaredRefField = child.attr(RELATIONSHIP_ATTR_SOURCE_REF_FIELD) as string | undefined;
      const fkField = findReferenceFkField(other, sourceEntity.name, child.name, declaredRefField);
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
  // ADR-0039: effective children — resolve rather than rely on root being unextended.
  const e = root.children().find((c) => c.type === TYPE_OBJECT && c.name === name);
  if (!e) throw new MetadataError(`Entity '${name}' not found`, { entity: name });
  return e;
}
