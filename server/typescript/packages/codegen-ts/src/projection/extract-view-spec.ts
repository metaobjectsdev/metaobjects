import {
  TYPE_FIELD,
  TYPE_ORIGIN,
  TYPE_RELATIONSHIP,
  MetaSource,
  ORIGIN_SUBTYPE_PASSTHROUGH,
  ORIGIN_SUBTYPE_AGGREGATE,
  ORIGIN_PASSTHROUGH_ATTR_FROM,
  ORIGIN_PASSTHROUGH_ATTR_VIA,
  ORIGIN_AGGREGATE_ATTR_AGG,
  ORIGIN_AGGREGATE_ATTR_OF,
  ORIGIN_AGGREGATE_ATTR_VIA,
  RELATIONSHIP_ATTR_OBJECT_REF,
  RELATIONSHIP_ATTR_CARDINALITY,
  CARDINALITY_ONE,
  FIELD_ATTR_COLUMN,
  findReferenceBetween,
  type AggregateFunction,
} from "@metaobjectsdev/metadata";
import { type MetaData, type MetaRoot, MetaObject } from "@metaobjectsdev/metadata";
import {
  columnNameFromField,
  viewNameFromProjection,
} from "../naming.js";
import type { ColumnNamingStrategy } from "../metaobjects-config.js";
import type {
  JoinNode, JoinTree, SelectColumn, SelectSpec, ViewSpec,
} from "./view-spec.js";

// ---------------------------------------------------------------------------
// Public context type
// ---------------------------------------------------------------------------

export interface ExtractContext {
  readonly columnNamingStrategy: ColumnNamingStrategy;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function findRelationship(obj: MetaData, name: string): MetaData | undefined {
  return obj.ownChildren().find(
    (c) => c.type === TYPE_RELATIONSHIP && c.name === name,
  );
}

function viewName(projection: MetaObject, ctx: ExtractContext): string {
  // The read-only source carries the physical view name (@table).
  const viewSource = projection.ownChildren().find(
    (c): c is MetaSource => c instanceof MetaSource && c.isReadOnly(),
  );
  const explicit = viewSource?.tableName;
  return explicit ?? viewNameFromProjection(projection.name, ctx.columnNamingStrategy);
}

/**
 * The physical view name for a projection — its read-only source `@table`, else
 * derived from the projection name.
 *
 * Exposed for the read-model generator (`renderProjectionDecl`), which needs the
 * view name but NOT the join/DDL resolution. Read-model generation works for a
 * standalone read-only view-entity (explicit columns, no `extends`); only
 * {@link extractViewSpec} — which generates the join-backed view DDL — requires a
 * base entity to extend.
 */
export function projectionViewName(
  projection: MetaObject,
  columnNamingStrategy: ColumnNamingStrategy,
): string {
  return viewName(projection, { columnNamingStrategy });
}

function baseEntityFor(
  projection: MetaObject,
  root: MetaRoot,
): MetaObject {
  // v1: base entity is the resolved super (set via `extends:` in metadata).
  const superModel = projection.superResolved;
  const superName = superModel?.name ?? projection.superRef;
  if (!superName) {
    throw new Error(
      `Projection ${projection.name}: missing extends — projections must extend a writable entity in v1.`,
    );
  }
  const base =
    superModel instanceof MetaObject ? superModel : root.findObject(superName);
  if (!base) {
    throw new Error(
      `Projection ${projection.name}: extends "${superName}" does not resolve to any entity.`,
    );
  }
  return base;
}

function sourceColumnNameFor(
  entityField: MetaData,
  ctx: ExtractContext,
): string {
  const col = entityField.ownAttr(FIELD_ATTR_COLUMN);
  if (typeof col === "string" && col !== "") return col;
  return columnNameFromField(entityField.name, ctx.columnNamingStrategy);
}

function shortAliasFor(entityName: string, used: Set<string>): string {
  const base = (entityName[0] ?? "x").toLowerCase();
  if (!used.has(base)) { used.add(base); return base; }
  let i = 0;
  let candidate: string;
  do { candidate = `${base}${i}`; i++; } while (used.has(candidate));
  used.add(candidate);
  return candidate;
}

// ---------------------------------------------------------------------------
// JoinTree builder — walks all `@via` paths from origin children, dedupes via
// prefix into a trie, then converts to JoinNode tree.
// ---------------------------------------------------------------------------

interface PathStep {
  entity: MetaData;
  relationship: string;
  cardinality: "one" | "many";
  fkField: string;
  pkField: string;
  referenceHolder: "source" | "target";
  targetEntity: string;
}

type Path = PathStep[];

interface TrieNode {
  children: Map<string, TrieNode>;
  step?: PathStep;
}

function buildJoinTree(
  projection: MetaObject,
  base: MetaObject,
  root: MetaRoot,
  usedAliases: Set<string>,
  baseAlias: string,
): JoinTree {
  const allPaths: Path[] = [];

  for (const field of projection.ownChildren()) {
    if (field.type !== TYPE_FIELD) continue;
    for (const origin of field.ownChildren()) {
      if (origin.type !== TYPE_ORIGIN) continue;
      const viaAttr = origin.subType === ORIGIN_SUBTYPE_AGGREGATE
        ? (origin.ownAttr(ORIGIN_AGGREGATE_ATTR_VIA) as string | undefined)
        : (origin.ownAttr(ORIGIN_PASSTHROUGH_ATTR_VIA) as string | undefined);
      if (!viaAttr) continue;

      const segments = viaAttr.split(".");
      const entityName = segments[0];
      const relSegments = segments.slice(1);
      if (!entityName) continue;
      let currentObj = root.findObject(entityName);
      if (!currentObj) continue;

      const path: Path = [];
      for (const relName of relSegments) {
        const rel = findRelationship(currentObj, relName);
        if (!rel) break;
        const targetName = rel.ownAttr(RELATIONSHIP_ATTR_OBJECT_REF) as string | undefined;
        const target = targetName ? root.findObject(targetName) : undefined;
        if (!target || !targetName) break;

        const cardAttr = rel.ownAttr(RELATIONSHIP_ATTR_CARDINALITY) as string | undefined;
        const cardinality: "one" | "many" = cardAttr === CARDINALITY_ONE ? "one" : "many";

        const ref = findReferenceBetween(currentObj as MetaObject, target);
        if (!ref) break;

        const fkField = ref.referenceIdentity.fields[0];
        if (!fkField) break;

        const resolvedPkField = ref.referenceIdentity.resolvedTargetPkField(root) ?? "id";

        const referenceHolder: "source" | "target" =
          ref.holder.name === currentObj.name ? "source" : "target";

        path.push({
          entity: currentObj,
          relationship: relName,
          cardinality,
          fkField,
          pkField: resolvedPkField,
          referenceHolder,
          targetEntity: targetName,
        });
        currentObj = target;
      }
      if (path.length > 0) allPaths.push(path);
    }
  }

  // Dedupe by prefix: paths sharing a prefix collapse into one join branch.
  const trieRoot: TrieNode = { children: new Map() };
  for (const path of allPaths) {
    let node = trieRoot;
    for (const step of path) {
      let child = node.children.get(step.relationship);
      if (!child) {
        child = { children: new Map(), step };
        node.children.set(step.relationship, child);
      }
      node = child;
    }
  }

  function toJoinNode(node: TrieNode): JoinNode {
    const step = node.step!;
    return {
      relationship: step.relationship,
      targetEntity: step.targetEntity,
      alias: shortAliasFor(step.targetEntity, usedAliases),
      cardinality: step.cardinality,
      fkField: step.fkField,
      pkField: step.pkField,
      referenceHolder: step.referenceHolder,
      children: Array.from(node.children.values()).map(toJoinNode),
    };
  }

  return {
    baseEntity: base.name,
    baseAlias,
    joins: Array.from(trieRoot.children.values()).map(toJoinNode),
  };
}

// ---------------------------------------------------------------------------
// Helpers for SelectSpec building
// ---------------------------------------------------------------------------

function findAliasInTree(
  joinTree: JoinTree,
  entityName: string,
): string | undefined {
  if (joinTree.baseEntity === entityName) return joinTree.baseAlias;

  function recurse(nodes: readonly JoinNode[]): string | undefined {
    for (const n of nodes) {
      if (n.targetEntity === entityName) return n.alias;
      const found = recurse(n.children);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  return recurse(joinTree.joins);
}

function buildSelectSpec(
  projection: MetaObject,
  base: MetaObject,
  joinTree: JoinTree,
  root: MetaRoot,
  ctx: ExtractContext,
): SelectSpec {
  const columns: SelectColumn[] = [];

  // Inherited fields from extends parent — emit as passthrough on baseAlias.
  // Skip fields that the projection has overridden with an explicit origin.
  // fields() is effective-by-default, so multi-level inheritance (base → BaseEntity) works.
  for (const baseField of base.fields()) {
    const overridden = projection.ownChildren().find(
      (c) => c.type === TYPE_FIELD && c.name === baseField.name,
    );
    if (overridden) continue;
    columns.push({
      kind: "passthrough",
      fieldName: baseField.name,
      dbColAlias: sourceColumnNameFor(baseField, ctx),
      sourceAlias: joinTree.baseAlias,
      sourceColumn: sourceColumnNameFor(baseField, ctx),
    });
  }

  // Fields explicitly declared on the projection.
  for (const field of projection.ownChildren()) {
    if (field.type !== TYPE_FIELD) continue;
    const origin = field.ownChildren().find((c) => c.type === TYPE_ORIGIN);
    const dbCol = sourceColumnNameFor(field, ctx);

    if (!origin) {
      // Declared on projection but no origin — passthrough from base table.
      columns.push({
        kind: "passthrough",
        fieldName: field.name,
        dbColAlias: dbCol,
        sourceAlias: joinTree.baseAlias,
        sourceColumn: dbCol,
      });
      continue;
    }

    if (origin.subType === ORIGIN_SUBTYPE_PASSTHROUGH) {
      const from = origin.ownAttr(ORIGIN_PASSTHROUGH_ATTR_FROM) as string;
      const dotIdx = from.indexOf(".");
      if (dotIdx < 1) continue;
      const entityName = from.slice(0, dotIdx);
      const fieldName = from.slice(dotIdx + 1);
      const targetEntity = root.findObject(entityName);
      const sourceAlias = findAliasInTree(joinTree, entityName);
      if (!targetEntity || sourceAlias === undefined) continue;
      const targetField = targetEntity.ownChildren().find(
        (c) => c.type === TYPE_FIELD && c.name === fieldName,
      );
      if (!targetField) continue;
      columns.push({
        kind: "passthrough",
        fieldName: field.name,
        dbColAlias: dbCol,
        sourceAlias,
        sourceColumn: sourceColumnNameFor(targetField, ctx),
      });
    } else if (origin.subType === ORIGIN_SUBTYPE_AGGREGATE) {
      const agg = origin.ownAttr(ORIGIN_AGGREGATE_ATTR_AGG) as AggregateFunction;
      const of_ = origin.ownAttr(ORIGIN_AGGREGATE_ATTR_OF) as string;
      if (!agg || !of_) continue;
      const dotIdx = of_.indexOf(".");
      if (dotIdx < 1) continue;
      const entityName = of_.slice(0, dotIdx);
      const fieldName = of_.slice(dotIdx + 1);
      const targetEntity = root.findObject(entityName);
      const sourceAlias = findAliasInTree(joinTree, entityName);
      if (!targetEntity || sourceAlias === undefined) continue;
      const targetField = targetEntity.ownChildren().find(
        (c) => c.type === TYPE_FIELD && c.name === fieldName,
      );
      if (!targetField) continue;
      columns.push({
        kind: "aggregate",
        fieldName: field.name,
        dbColAlias: dbCol,
        agg,
        sourceAlias,
        sourceColumn: sourceColumnNameFor(targetField, ctx),
      });
    }
  }

  return { columns };
}

function buildGroupBy(spec: SelectSpec): string[] {
  const hasAgg = spec.columns.some((c) => c.kind === "aggregate");
  if (!hasAgg) return [];
  return spec.columns
    .filter((c) => c.kind === "passthrough")
    .map((c) => `${c.sourceAlias}.${c.sourceColumn}`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Walk a projection's origin children to produce a ViewSpec.
 *
 * @param projection  The projection entity (has a source[dbView] child
 *                    and extends a writable entity).
 * @param root        The loader's MetaRoot — all top-level objects are
 *                    direct children of root (returned by `MetaDataLoader.load()`
 *                    or `MetaDataLoader.fromDirectory()` as `result.root`).
 * @param ctx         Column naming strategy for SQL identifiers.
 */
export function extractViewSpec(
  projection: MetaObject,
  root: MetaRoot,
  ctx: ExtractContext,
): ViewSpec {
  const base = baseEntityFor(projection, root);
  const usedAliases = new Set<string>();
  const baseAlias = shortAliasFor(base.name, usedAliases);
  const joinTree = buildJoinTree(projection, base, root, usedAliases, baseAlias);
  const selectSpec = buildSelectSpec(projection, base, joinTree, root, ctx);
  const groupBy = buildGroupBy(selectSpec);

  return {
    viewName: viewName(projection, ctx),
    joinTree,
    selectSpec,
    groupBy,
  };
}
