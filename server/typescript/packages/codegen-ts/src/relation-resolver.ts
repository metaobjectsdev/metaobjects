// Relation resolver — pre-pass that builds the inverse-side map for relations() emission.
// For each entity, we need to know:
//   - Which outgoing belongs-to relationships it declares (one-side, reference on this entity)
//   - Which incoming relationships point to it (many-side, reference on the other entity)
//
// Reads identity.reference declarations to determine the physical reference side.

import type { MetaRoot, MetaObject, MetaRelationship } from "@metaobjectsdev/metadata";
import {
  RELATIONSHIP_ATTR_CARDINALITY,
  RELATIONSHIP_ATTR_OBJECT_REF,
  RELATIONSHIP_ATTR_THROUGH,
  CARDINALITY_ONE,
  CARDINALITY_MANY,
  deriveM2MFields,
  stripPackage,
} from "@metaobjectsdev/metadata";
import { variableNameFromEntity } from "./naming.js";
import { isProjection } from "./projection/projection-detector.js";

export interface RelationEntry {
  /** Name of the relationship (e.g., "author") */
  name: string;
  /** Cardinality: 'one' | 'many' */
  cardinality: "one" | "many";
  /** The other entity's name (e.g., "User") */
  targetEntity: string;
  /** For cardinality 'one': the field on THIS entity that holds the FK (e.g., "authorId") */
  fkField?: string;
  /** For cardinality 'one': the target entity's PK field (e.g., "id") */
  targetPkField?: string;
  /**
   * FR-018 M:N navigation fields. Present only for a many-to-many navigation (a
   * `@cardinality: "many"` relationship that declares `@through`). The Drizzle
   * relations() block emits `many(<junction>)` for these; the routes file emits
   * a `mountM2mRoute(...)` traversal. The junction FK fields are DERIVED from the
   * junction entity's two `identity.reference` children (the SSOT), never
   * restated on the relationship.
   */
  /** The junction/through entity name (e.g., "PostTag"). M:N entries only. */
  junctionEntity?: string;
  /** Junction FK field holding the source-side key (logical field name, e.g. "postId"). M:N only. */
  sourceJoinField?: string;
  /** Junction FK field holding the target-side key (logical field name, e.g. "tagId"). M:N only. */
  targetJoinField?: string;
  /** Undirected self-join: union both junction FK columns at read time. M:N only. */
  symmetric?: boolean;
}

/** Map from entity name → list of relations for that entity's relations() block */
export type RelationMap = Map<string, RelationEntry[]>;

/**
 * Walk all entities, collect relationship children, and also register inverse
 * many() sides on the target entity.
 */
export function buildRelationMap(root: MetaRoot): RelationMap {
  const result: RelationMap = new Map();

  const ensure = (name: string): RelationEntry[] => {
    if (!result.has(name)) result.set(name, []);
    return result.get(name)!;
  };

  for (const obj of root.objects()) {
    // Projections (source.dbView) are view-backed; they never emit a relations()
    // block, and their inherited belongs-to relationships would otherwise register
    // a spurious inverse-many on the target entity.
    if (isProjection(obj)) continue;

    for (const child of obj.relationships()) {
      const cardinality = child.ownAttr(RELATIONSHIP_ATTR_CARDINALITY) as string | undefined;

      // FR-018 M:N: `@cardinality: "many"` + `@through` — derive the junction FK
      // columns from the junction's identity.reference children and register a
      // many(junction) navigation on the source.
      if (cardinality === CARDINALITY_MANY && child.ownAttr(RELATIONSHIP_ATTR_THROUGH) !== undefined) {
        const m2m = buildM2mEntry(obj, child as MetaRelationship, root);
        if (m2m) ensure(obj.name).push(m2m);
        continue;
      }

      if (cardinality !== CARDINALITY_ONE) continue;

      const targetEntityRaw = child.ownAttr(RELATIONSHIP_ATTR_OBJECT_REF) as string | undefined;
      if (!targetEntityRaw) continue;
      const targetEntity = stripPackage(targetEntityRaw);

      // Find an identity.reference on `obj` whose @references targets this relationship's target.
      // Compare against package-stripped names since both relationship @objectRef and
      // identity.reference @references may carry package-qualified entity names.
      const refs = obj.referenceIdentities();
      const matching = refs.find((r) => stripPackage(r.targetEntity ?? "") === targetEntity);
      if (!matching) continue;

      const fkFields = matching.fields;
      if (fkFields.length === 0) continue;
      const fkField = fkFields[0]!;

      ensure(obj.name).push({
        name: child.name,
        cardinality: "one",
        targetEntity,
        fkField,
        targetPkField: "id",
      });
      ensure(targetEntity).push({
        name: variableNameFromEntity(obj.name),
        cardinality: "many",
        targetEntity: obj.name,
      });
    }
  }

  // FR-018: junction entities reached via @through need their two belongs-to
  // one() sides so the through-table is navigable in the Drizzle relational
  // query API (db.query.posts.findMany({ with: { tags: { with: { tag: true }}}})).
  // A junction is any entity named by some M:N relationship's @through.
  for (const junctionName of collectJunctionNames(root)) {
    const junction = root.findObject(junctionName);
    if (!junction) continue;
    const entries = ensure(junctionName);
    for (const ref of junction.referenceIdentities()) {
      const targetRaw = ref.targetEntity;
      const fkField = ref.fields[0];
      if (!targetRaw || !fkField) continue;
      const targetEntity = stripPackage(targetRaw);
      // The relation member is named after the target entity (camel singular);
      // multiple references to the same entity (self-join junction) are
      // disambiguated by the FK field name.
      const refName = ref.name && ref.name.length > 0
        ? ref.name
        : variableNameFromEntity(targetEntity);
      entries.push({
        name: refName,
        cardinality: "one",
        targetEntity,
        fkField,
        targetPkField: "id",
      });
    }
  }

  return result;
}

/** Names of all entities that are the `@through` junction of some M:N relationship. */
function collectJunctionNames(root: MetaRoot): Set<string> {
  const names = new Set<string>();
  for (const obj of root.objects()) {
    for (const rel of obj.relationships()) {
      if (rel.ownAttr(RELATIONSHIP_ATTR_CARDINALITY) !== CARDINALITY_MANY) continue;
      const through = rel.ownAttr(RELATIONSHIP_ATTR_THROUGH) as string | undefined;
      if (through) names.add(stripPackage(through));
    }
  }
  return names;
}

/**
 * Build the source-side M:N navigation entry: derive the junction FK fields from
 * the junction's two identity.reference children (the SSOT), handling hetero /
 * directed-self-join / symmetric. Returns null (skips the entry) if derivation
 * fails — the loader validation pass surfaces the actionable error separately.
 */
function buildM2mEntry(
  source: MetaObject,
  rel: MetaRelationship,
  root: MetaRoot,
): RelationEntry | null {
  const targetRaw = rel.ownAttr(RELATIONSHIP_ATTR_OBJECT_REF) as string | undefined;
  const throughRaw = rel.ownAttr(RELATIONSHIP_ATTR_THROUGH) as string | undefined;
  if (!targetRaw || !throughRaw) return null;
  let fields;
  try {
    fields = deriveM2MFields(rel, source, root);
  } catch {
    return null;
  }
  return {
    name: rel.name,
    cardinality: "many",
    targetEntity: stripPackage(targetRaw),
    junctionEntity: stripPackage(throughRaw),
    sourceJoinField: fields.sourceField,
    targetJoinField: fields.targetField,
    symmetric: rel.symmetric,
  };
}
