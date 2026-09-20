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
  RELATIONSHIP_ATTR_SOURCE_REF_FIELD,
  CARDINALITY_ONE,
  CARDINALITY_MANY,
  deriveM2MFields,
  resolveRelationshipReference,
  stripPackage,
} from "@metaobjectsdev/metadata";
import { variableNameFromEntity } from "./naming.js";
import { hasWritableRdbSource } from "./source-detect.js";
import { tphStorageObject } from "./templates/zod-validators.js";
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
 *
 * `onWarn`, when supplied, receives one line per M:N relationship whose junction FKs
 * could not be derived: the entry is skipped (a route that mounts nothing is an
 * ABSENCE, not an error), and the warning is the only thing that says so. The runner
 * passes its warnings channel; callers without one keep the silent skip.
 */
export function buildRelationMap(
  root: MetaRoot,
  onWarn?: (msg: string) => void,
): RelationMap {
  const result: RelationMap = new Map();

  const ensure = (name: string): RelationEntry[] => {
    if (!result.has(name)) result.set(name, []);
    return result.get(name)!;
  };

  // Files a CARDINALITY-ONE entry under the entity whose module renders the
  // relations() block. A TPH subtype has no module of its own — it is folded into
  // the discriminator base's single table, and the block renders on the BASE's.
  // So an entry must be filed under the entity that actually renders it, or it is
  // silently never emitted. `tphStorageName` is the seam for exactly this (its own
  // doc says "for the name-keyed relation map"); the TARGET side of relations-block
  // already resolves through it — only the SOURCE side was keyed raw.
  //
  // Because `obj.relationships()` RESOLVES, a base-declared relationship is reached
  // again through every subtype and would now land on the same key repeatedly, so an
  // entry structurally identical to one already filed is skipped. A name that collides
  // with a DIFFERENT shape is a real conflict the base's single block cannot express:
  // it is reported through `onWarn` rather than silently overwritten, because a
  // navigation that quietly resolves to another subtype's target is the worse failure.
  // True when a module renders a relations() block for this storage object — the
  // question the map's contract asks, not either cause of its answer. Both
  // non-abstractness and a writable source.rdb are required: the entity file
  // routes an object failing EITHER to renderValueObjectFile, which emits no
  // block. The oracle's tableBackedObjects walk makes the same exclusion. Filing
  // an entry without it would only document, in `meta docs`/api-model, a
  // `<Entity>Relations` export that no module emits.
  const rendersRelationsBlock = (storing: MetaObject): boolean =>
    !storing.isAbstract && hasWritableRdbSource(storing);

  const push = (obj: MetaObject, entry: RelationEntry): void => {
    const storing = tphStorageObject(obj);
    if (!rendersRelationsBlock(storing)) return;
    const key = storing.name;
    const entries = ensure(key);
    const clash = entries.find((e) => e.name === entry.name);
    if (clash !== undefined) {
      const same =
        clash.cardinality === entry.cardinality &&
        clash.targetEntity === entry.targetEntity &&
        clash.fkField === entry.fkField;
      if (!same) {
        onWarn?.(
          `relationship "${entry.name}" on entity "${obj.name}" gets no relations() entry: ` +
            `"${key}" already carries a different "${entry.name}" ` +
            `(-> ${clash.targetEntity} via ${clash.fkField}), and a single-table hierarchy ` +
            `renders ONE relations() block on the base, which cannot hold both. ` +
            `Rename one of them.`,
        );
      }
      return;
    }
    entries.push(entry);
  };

  for (const obj of root.objects()) {
    // Projections (source.dbView) are view-backed; they never emit a relations()
    // block, and their inherited belongs-to relationships would otherwise register
    // a spurious inverse-many on the target entity.
    if (isProjection(obj)) continue;

    // An ABSTRACT level's own declarations do not file. Its FK column reaches the
    // base's single table only through a CONCRETE @discriminatorValue descendant
    // (collectTphSubtypeFields folds effective fields per concrete subtype), and
    // that descendant's RESOLVING relationships() walk reaches this same
    // relationship and files the identical entry — the dedupe collapses the
    // copies. With no concrete descendant there is no folded column and no rows to
    // navigate, so absence is the honest output: an entry would make the base's
    // relations() block name a column the table does not have.
    if (obj.isAbstract) continue;

    for (const child of obj.relationships()) {
      // ADR-0039: resolving — a relationship may inherit @cardinality via extends.
      const cardinality = child.attr(RELATIONSHIP_ATTR_CARDINALITY) as string | undefined;

      // FR-018 M:N: `@cardinality: "many"` + `@through` — derive the junction FK
      // columns from the junction's identity.reference children and register a
      // many(junction) navigation on the source.
      // ADR-0039: resolving — @through may be inherited via extends.
      if (cardinality === CARDINALITY_MANY && child.attr(RELATIONSHIP_ATTR_THROUGH) !== undefined) {
        const m2m = buildM2mEntry(obj, child as MetaRelationship, root, onWarn);
        // NOT re-keyed to the storage base: the ROUTES tier reads this map to mount
        // an M:N under EACH concrete subtype's segment, so it needs the per-subtype
        // entries. Collapsing them onto the base key silently reduces four mounts to
        // one. Only the cardinality-one path below is re-keyed, because that is the
        // one the relations() block renders on the base's module.
        if (m2m) ensure(obj.name).push(m2m);
        continue;
      }

      if (cardinality !== CARDINALITY_ONE) continue;

      // ADR-0039: resolving — @objectRef may be inherited via extends.
      const targetEntityRaw = child.attr(RELATIONSHIP_ATTR_OBJECT_REF) as string | undefined;
      if (!targetEntityRaw) continue;
      const targetEntity = stripPackage(targetEntityRaw);

      // #368: an entity may hold more than one identity.reference onto the same
      // target, so the target alone does not identify the FK. Resolve through the
      // shared ladder (unique candidate -> @sourceRefField -> name pairing); the
      // loader has already refused anything it cannot resolve, so a miss here
      // means an unloadable model reached codegen — skip rather than guess.
      // ADR-0039: resolving — @sourceRefField may be inherited via extends.
      const declaredRefField = child.attr(RELATIONSHIP_ATTR_SOURCE_REF_FIELD) as string | undefined;
      const matching = resolveRelationshipReference(
        obj, child.name, targetEntity, declaredRefField,
      );
      if (!matching) continue;

      const fkField = matching.fields[0];
      if (!fkField) continue;

      push(obj, {
        name: child.name,
        cardinality: "one",
        targetEntity,
        fkField,
        targetPkField: "id",
      });
      // ADR-0038: do NOT register a reverse lazy `many()` on the target. Those
      // entries were named after the SOURCE entity (`variableNameFromEntity(obj)`),
      // so two relationships from the same source to the same target produced
      // duplicate object-literal keys and silently overwrote each other (the
      // same-pair collision). Reverse 1:N navigation is now provided as explicit,
      // unique-by-FK-field finders in the source's queries module
      // (find<SourcePlural>By<FkField>), which are framework-free and non-N+1.
      // The forward one() relation above stays.
    }
  }

  // FR-018: junction entities reached via @through need their two belongs-to
  // one() sides so the through-table is navigable in the Drizzle relational
  // query API (db.query.posts.findMany({ with: { tags: { with: { tag: true }}}})).
  // A junction is any entity named by some M:N relationship's @through.
  for (const junctionName of collectJunctionNames(root)) {
    const junction = root.findObject(junctionName);
    if (!junction) continue;
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
      push(junction, {
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
      // ADR-0039: resolving — @cardinality/@through may be inherited via extends.
      if (rel.attr(RELATIONSHIP_ATTR_CARDINALITY) !== CARDINALITY_MANY) continue;
      const through = rel.attr(RELATIONSHIP_ATTR_THROUGH) as string | undefined;
      if (through) names.add(stripPackage(through));
    }
  }
  return names;
}

/**
 * Build the source-side M:N navigation entry: derive the junction FK fields from
 * the junction's two identity.reference children (the SSOT), handling hetero /
 * directed-self-join / symmetric. Returns null (skips the entry) if derivation
 * fails, reporting the derivation's own reason through `onWarn` when supplied —
 * the loader's rules never check subject pairing, so a model can load clean and
 * still carry a junction this pass cannot pair (e.g. one whose identity.reference
 * names a concrete subtype of the declaring entity).
 */
function buildM2mEntry(
  source: MetaObject,
  rel: MetaRelationship,
  root: MetaRoot,
  onWarn?: (msg: string) => void,
): RelationEntry | null {
  // ADR-0039: resolving — @objectRef/@through may be inherited via extends.
  const targetRaw = rel.attr(RELATIONSHIP_ATTR_OBJECT_REF) as string | undefined;
  const throughRaw = rel.attr(RELATIONSHIP_ATTR_THROUGH) as string | undefined;
  if (!targetRaw || !throughRaw) return null;
  let fields;
  try {
    fields = deriveM2MFields(rel, source, root);
  } catch (err) {
    onWarn?.(
      `M:N relationship "${rel.name}" on entity "${source.name}" gets no traversal route: its ` +
        `@through junction "${stripPackage(throughRaw)}" could not be paired — ` +
        `${err instanceof Error ? err.message : String(err)}. The model loads, so the run ` +
        `continues, but the endpoint is absent (a 404).`,
    );
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
