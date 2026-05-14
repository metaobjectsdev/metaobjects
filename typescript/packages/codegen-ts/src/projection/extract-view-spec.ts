import {
  TYPE_OBJECT,
  TYPE_FIELD,
  TYPE_ORIGIN,
  TYPE_RELATIONSHIP,
  TYPE_IDENTITY,
  TYPE_SOURCE,
  SOURCE_SUBTYPE_DB_VIEW,
  SOURCE_DB_VIEW_ATTR_NAME,
  ORIGIN_SUBTYPE_PASSTHROUGH,
  ORIGIN_SUBTYPE_AGGREGATE,
  ORIGIN_PASSTHROUGH_ATTR_FROM,
  ORIGIN_PASSTHROUGH_ATTR_VIA,
  ORIGIN_AGGREGATE_ATTR_AGG,
  ORIGIN_AGGREGATE_ATTR_OF,
  ORIGIN_AGGREGATE_ATTR_VIA,
  RELATIONSHIP_ATTR_OBJECT_REF,
  RELATIONSHIP_ATTR_FK_FIELD,
  RELATIONSHIP_ATTR_PARENT_FIELD,
  IDENTITY_SUBTYPE_PRIMARY,
  IDENTITY_ATTR_FIELDS,
  FIELD_ATTR_DB_COLUMN,
  type AggregateFunction,
} from "@metaobjects/metadata";
import type { MetaModel } from "@metaobjects/metadata";
import {
  columnNameFromField,
  viewNameFromProjection,
} from "../naming.js";
import type { ColumnNamingStrategy } from "../forge-config.js";
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

function findEntity(root: MetaModel, name: string): MetaModel | undefined {
  for (const child of root.children()) {
    if (child.type === TYPE_OBJECT && child.name === name) return child;
  }
  return undefined;
}

function findRelationship(obj: MetaModel, name: string): MetaModel | undefined {
  return obj.children().find(
    (c) => c.type === TYPE_RELATIONSHIP && c.name === name,
  );
}

function viewName(projection: MetaModel, ctx: ExtractContext): string {
  const dbView = projection.children().find(
    (c) => c.type === TYPE_SOURCE && c.subType === SOURCE_SUBTYPE_DB_VIEW,
  );
  const explicit = dbView?.attr(SOURCE_DB_VIEW_ATTR_NAME) as string | undefined;
  return explicit ?? viewNameFromProjection(projection.name, ctx.columnNamingStrategy);
}

function baseEntityFor(
  projection: MetaModel,
  root: MetaModel,
): MetaModel {
  // v1: base entity is the resolved super (set via `extends:` in metadata).
  const superModel = projection.superResolved;
  const superName = superModel?.name ?? projection.superRef;
  if (!superName) {
    throw new Error(
      `Projection ${projection.name}: missing extends — projections must extend a writable entity in v1.`,
    );
  }
  const base = superModel ?? findEntity(root, superName);
  if (!base) {
    throw new Error(
      `Projection ${projection.name}: extends "${superName}" does not resolve to any entity.`,
    );
  }
  return base;
}

function sourceColumnNameFor(
  entityField: MetaModel,
  ctx: ExtractContext,
): string {
  const explicit = entityField.attr(FIELD_ATTR_DB_COLUMN) as string | undefined;
  return explicit ?? columnNameFromField(entityField.name, ctx.columnNamingStrategy);
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

/**
 * Determine the field name on `parentEntity` that the FK references.
 * Priority: explicit `@parentField` attr on the relationship > parent's primary identity field > "id" fallback.
 */
function parentJoinColumnFor(parentEntity: MetaModel, relationship: MetaModel): string {
  // Explicit @parentField wins (e.g., for email-based joins).
  const explicit = relationship.attr(RELATIONSHIP_ATTR_PARENT_FIELD) as string | undefined;
  if (explicit) return explicit;
  // Default: parent's primary identity field name (use effectiveChildren for inherited identity).
  const primary = parentEntity.effectiveChildren().find(
    (c) => c.type === TYPE_IDENTITY && c.subType === IDENTITY_SUBTYPE_PRIMARY,
  );
  const fields = primary?.attr(IDENTITY_ATTR_FIELDS) as string | string[] | undefined;
  if (typeof fields === "string") {
    const first = fields.split(",")[0];
    if (first !== undefined) return first.trim();
  }
  if (Array.isArray(fields) && fields.length > 0) {
    const first = fields[0];
    if (first !== undefined) return String(first).trim();
  }
  return "id"; // last-resort fallback
}

interface PathStep {
  entity: MetaModel;
  relationship: string;
  fkField: string;
  parentJoinField: string;
  targetEntity: string;
}

type Path = PathStep[];

interface TrieNode {
  children: Map<string, TrieNode>;
  step?: PathStep;
}

function buildJoinTree(
  projection: MetaModel,
  base: MetaModel,
  root: MetaModel,
  usedAliases: Set<string>,
  baseAlias: string,
): JoinTree {
  const allPaths: Path[] = [];

  for (const field of projection.children()) {
    if (field.type !== TYPE_FIELD) continue;
    for (const origin of field.children()) {
      if (origin.type !== TYPE_ORIGIN) continue;
      const viaAttr = origin.subType === ORIGIN_SUBTYPE_AGGREGATE
        ? (origin.attr(ORIGIN_AGGREGATE_ATTR_VIA) as string | undefined)
        : (origin.attr(ORIGIN_PASSTHROUGH_ATTR_VIA) as string | undefined);
      if (!viaAttr) continue;

      const segments = viaAttr.split(".");
      const entityName = segments[0];
      const relSegments = segments.slice(1);
      if (!entityName) continue;
      let currentObj = findEntity(root, entityName);
      if (!currentObj) continue;

      const path: Path = [];
      for (const relName of relSegments) {
        const rel = findRelationship(currentObj, relName);
        if (!rel) break;
        const targetName = rel.attr(RELATIONSHIP_ATTR_OBJECT_REF) as string | undefined;
        const fkField = rel.attr(RELATIONSHIP_ATTR_FK_FIELD) as string | undefined;
        const target = targetName ? findEntity(root, targetName) : undefined;
        if (!target || !fkField || !targetName) break;
        path.push({
          entity: currentObj,
          relationship: relName,
          fkField,
          parentJoinField: parentJoinColumnFor(currentObj, rel),
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
      fkField: step.fkField,
      parentJoinField: step.parentJoinField,
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
  projection: MetaModel,
  base: MetaModel,
  joinTree: JoinTree,
  root: MetaModel,
  ctx: ExtractContext,
): SelectSpec {
  const columns: SelectColumn[] = [];

  // Inherited fields from extends parent — emit as passthrough on baseAlias.
  // Skip fields that the projection has overridden with an explicit origin.
  // Use effectiveChildren() on base so multi-level inheritance (base → BaseEntity) works.
  for (const baseField of base.effectiveChildren()) {
    if (baseField.type !== TYPE_FIELD) continue;
    const overridden = projection.children().find(
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
  for (const field of projection.children()) {
    if (field.type !== TYPE_FIELD) continue;
    const origin = field.children().find((c) => c.type === TYPE_ORIGIN);
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
      const from = origin.attr(ORIGIN_PASSTHROUGH_ATTR_FROM) as string;
      const dotIdx = from.indexOf(".");
      if (dotIdx < 1) continue;
      const entityName = from.slice(0, dotIdx);
      const fieldName = from.slice(dotIdx + 1);
      const targetEntity = findEntity(root, entityName);
      const sourceAlias = findAliasInTree(joinTree, entityName);
      if (!targetEntity || sourceAlias === undefined) continue;
      const targetField = targetEntity.children().find(
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
      const agg = origin.attr(ORIGIN_AGGREGATE_ATTR_AGG) as AggregateFunction;
      const of_ = origin.attr(ORIGIN_AGGREGATE_ATTR_OF) as string;
      if (!agg || !of_) continue;
      const dotIdx = of_.indexOf(".");
      if (dotIdx < 1) continue;
      const entityName = of_.slice(0, dotIdx);
      const fieldName = of_.slice(dotIdx + 1);
      const targetEntity = findEntity(root, entityName);
      const sourceAlias = findAliasInTree(joinTree, entityName);
      if (!targetEntity || sourceAlias === undefined) continue;
      const targetField = targetEntity.children().find(
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
 * @param projection  The projection entity MetaModel (has a source[dbView] child
 *                    and extends a writable entity).
 * @param root        The Loader's root MetaModel — all top-level objects are
 *                    direct children of root (returned by `Loader.loadJson()` /
 *                    `Loader.loadJsonStrings()` as `result.root`).
 * @param ctx         Column naming strategy for SQL identifiers.
 */
export function extractViewSpec(
  projection: MetaModel,
  root: MetaModel,
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
