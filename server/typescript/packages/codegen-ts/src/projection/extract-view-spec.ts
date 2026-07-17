import {
  TYPE_FIELD,
  TYPE_IDENTITY,
  TYPE_ORIGIN,
  TYPE_RELATIONSHIP,
  MetaSource,
  ORIGIN_SUBTYPE_PASSTHROUGH,
  ORIGIN_SUBTYPE_AGGREGATE,
  ORIGIN_SUBTYPE_COMPUTED,
  ORIGIN_SUBTYPE_FIRST,
  ORIGIN_PASSTHROUGH_ATTR_FROM,
  ORIGIN_PASSTHROUGH_ATTR_VIA,
  ORIGIN_AGGREGATE_ATTR_AGG,
  ORIGIN_AGGREGATE_ATTR_OF,
  ORIGIN_AGGREGATE_ATTR_VIA,
  ORIGIN_AGGREGATE_ATTR_FILTER,
  ORIGIN_ATTR_DISTINCT,
  ORIGIN_ATTR_ORDER_BY,
  ORIGIN_COMPUTED_ATTR_EXPR,
  ORIGIN_FIRST_ATTR_OF,
  ORIGIN_FIRST_ATTR_VIA,
  ORIGIN_FIRST_ATTR_FILTER,
  AGG_ANY,
  AGG_ALL,
  AGG_COLLECT,
  AGGREGATE_FUNCTIONS,
  FILTER_OP_EQ,
  FILTER_OP_NE,
  FILTER_OP_GT,
  FILTER_OP_GTE,
  FILTER_OP_LT,
  FILTER_OP_LTE,
  FILTER_OP_IS_NULL,
  FILTER_COMPOSE_AND,
  FILTER_COMPOSE_OR,
  SORT_ORDER_DESC,
  RELATIONSHIP_ATTR_OBJECT_REF,
  RELATIONSHIP_ATTR_CARDINALITY,
  CARDINALITY_ONE,
  IDENTITY_SUBTYPE_REFERENCE,
  IDENTITY_REFERENCE_ATTR_REFERENCES,
  FIELD_ATTR_COLUMN,
  OBJECT_PROJECTION_ATTR_FILTER,
  findReferenceBetween,
  stripPackage,
  type AggregateFunction,
} from "@metaobjectsdev/metadata";
import { type MetaData, type MetaField, type MetaRoot, MetaObject } from "@metaobjectsdev/metadata";
import {
  columnNameFromField,
  viewNameFromProjection,
} from "../naming.js";
// #213 — a write-through ENTITY (FR-024 §7 read-view) hosts its own view; the base
// is the entity itself, not an extends-anchored projection.
import { isWriteThrough } from "./projection-detector.js";
// #209 — the SAME NOT-NULL predicate that drives a column's `.notNull()` decides
// whether a belongs-to join is INNER (required FK) vs LEFT OUTER (nullable FK).
import { isRequired } from "../column-mapper.js";
import type { ColumnNamingStrategy } from "../metaobjects-config.js";
import type {
  JoinNode, JoinTree, SelectColumn, SelectSpec, ViewSpec, ViewFilterClause,
  ViewExprNode, ViewExprLiteral, ViewOrderKey,
} from "./view-spec.js";

/** Compose keys in the attr.filter shape. */
const FILTER_AND = FILTER_COMPOSE_AND;
const FILTER_OR = FILTER_COMPOSE_OR;

// #195 — the three expression-only op/fn names of the attr.expression grammar. They
// mirror EXPR_OP_IS_NOT_NULL / EXPR_OP_NOT / EXPR_FN_COALESCE in the metadata package's
// meta-attr-expression module, which is not re-exported through the public barrel; the
// remaining node ops (eq/ne/gt/… , isNull, and/or) are the shared FILTER_* vocabulary
// imported above.
const EXPR_OP_IS_NOT_NULL = "isNotNull";
const EXPR_OP_NOT = "not";
const EXPR_FN_COALESCE = "coalesce";

/** The scalar-reduce @agg values that map to the plain `aggregate` SelectColumn kind. */
const SCALAR_AGG_FUNCTIONS: ReadonlySet<string> = new Set(AGGREGATE_FUNCTIONS);
/** Expression comparison ops (share the filter vocabulary + per-subtype legality bands). */
const EXPR_COMPARISON_OPS: ReadonlySet<string> = new Set([
  FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE,
]);

/**
 * Desugar a single field clause to the canonical `{ op: value }` form (scalar→eq,
 * array→in, null→isNull, object→as-is). Mirrors metadata's attr.filter desugar so an
 * aggregate `@filter` works whether or not it was pre-desugared by the loader.
 */
function desugarClause(raw: unknown): Record<string, unknown> {
  if (raw === null) return { isNull: true };
  if (Array.isArray(raw)) return { in: raw };
  if (typeof raw === "object") return raw as Record<string, unknown>;
  return { eq: raw };
}

/**
 * Resolve an aggregate `@filter` (`{ field: value | { op: value }, and?, or? }`) into
 * a {@link ViewFilterClause} with column refs resolved to `alias.column` on the
 * aggregated entity. Multiple fields at one level compose with AND. Unknown fields are
 * skipped (defensive — the loader validates field existence elsewhere).
 */
function resolveAggregateFilter(
  filter: unknown,
  entity: MetaObject,
  alias: string,
  ctx: ExtractContext,
): ViewFilterClause | undefined {
  if (typeof filter !== "object" || filter === null || Array.isArray(filter)) return undefined;
  const clauses: ViewFilterClause[] = [];
  for (const [key, val] of Object.entries(filter as Record<string, unknown>)) {
    if (key === FILTER_AND || key === FILTER_OR) {
      const subs = (Array.isArray(val) ? val : [])
        .map((s) => resolveAggregateFilter(s, entity, alias, ctx))
        .filter((c): c is ViewFilterClause => c !== undefined);
      if (subs.length > 0) clauses.push({ kind: key === FILTER_AND ? "and" : "or", clauses: subs });
      continue;
    }
    const field = entity.fields().find((f) => f.name === key);
    if (!field) continue;
    const opObj = desugarClause(val);
    const op = Object.keys(opObj)[0];
    if (!op) continue;
    clauses.push({
      kind: "cmp",
      ref: `${alias}.${sourceColumnNameFor(field, ctx)}`,
      op,
      value: opObj[op],
    });
  }
  if (clauses.length === 0) return undefined;
  return clauses.length === 1 ? clauses[0]! : { kind: "and", clauses };
}

/**
 * #207 — resolve a projection's row-scope `@filter` (the desugared canonical
 * `{ field: { op: value }, and?, or? }`) into a {@link ViewFilterClause} whose
 * refs are resolved against the projection's OWN declared columns (its SelectSpec),
 * NOT against a single aggregated entity+alias (that is `resolveAggregateFilter`).
 * Each field key names a declared projection field; it resolves by SelectColumn kind:
 *   - passthrough (base OR joined) → `sourceAlias.sourceColumn` — the machinery that
 *     makes `WHERE joined.status IS NULL OR joined.status = 1` work.
 *   - computed (origin.computed)   → the inlined resolved expression (`exprCmp`).
 *   - aggregate-derived (aggregate/predicateAgg/collectAgg/first) → THROW (a WHERE
 *     cannot see aggregates; HAVING is a separate later extension). The loader already
 *     fail-closes this (ERR_BAD_ATTR_FILTER) — this throw is a codegen belt-and-suspenders.
 *   - a ref naming no declared field → THROW (dangling; also loader-rejected).
 * Multiple fields at one level compose with AND (mirrors resolveAggregateFilter).
 */
function resolveViewFilter(
  filter: unknown,
  columnsByField: ReadonlyMap<string, SelectColumn>,
  projectionName: string,
): ViewFilterClause | undefined {
  if (typeof filter !== "object" || filter === null || Array.isArray(filter)) return undefined;
  const clauses: ViewFilterClause[] = [];
  for (const [key, val] of Object.entries(filter as Record<string, unknown>)) {
    if (key === FILTER_AND || key === FILTER_OR) {
      const subs = (Array.isArray(val) ? val : [])
        .map((s) => resolveViewFilter(s, columnsByField, projectionName))
        .filter((c): c is ViewFilterClause => c !== undefined);
      if (subs.length > 0) clauses.push({ kind: key === FILTER_AND ? "and" : "or", clauses: subs });
      continue;
    }
    const col = columnsByField.get(key);
    if (!col) {
      // The loader (validateProjectionFilter) already fail-closes a dangling or
      // aggregate-derived ref, so by codegen time a missing column means a DECLARED,
      // addressable field that buildSelectSpec could not resolve to a SELECT column
      // (an internal inconsistency) — report it as such, not as "dangling".
      throw new Error(
        `Projection ${projectionName}: view @filter field "${key}" did not resolve to a view column.`,
      );
    }
    // A field clause may carry MULTIPLE ops (a range like { gte: 100, lte: 500 }); each
    // becomes its own comparison, AND-composed (dropping all-but-the-first would silently
    // widen the exposed row set). The loader has already validated every op for this
    // field's subtype.
    for (const [op, value] of Object.entries(desugarClause(val))) {
      if (col.kind === "passthrough") {
        clauses.push({ kind: "cmp", ref: `${col.sourceAlias}.${col.sourceColumn}`, op, value });
      } else if (col.kind === "computed") {
        clauses.push({ kind: "exprCmp", expr: col.expr, op, value });
      } else {
        throw new Error(
          `Projection ${projectionName}: view @filter references "${key}", an aggregate-derived ` +
            `field — a WHERE cannot see aggregates. Filter on a passthrough or computed field instead.`,
        );
      }
    }
  }
  if (clauses.length === 0) return undefined;
  return clauses.length === 1 ? clauses[0]! : { kind: "and", clauses };
}

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
  // ADR-0039: resolving — a @via join hop may traverse a relationship the entity
  // inherits via extends; own-only would silently drop the join.
  return obj.children().find(
    (c) => c.type === TYPE_RELATIONSHIP && c.name === name,
  );
}

/** FR-024: a `@via` hop may also name an `identity.reference` (a forward FK). */
function findReferenceHop(obj: MetaData, name: string): MetaData | undefined {
  return obj
    .children()
    .find(
      (c) => c.type === TYPE_IDENTITY && c.subType === IDENTITY_SUBTYPE_REFERENCE && c.name === name,
    );
}

/** Resolve a `@via` hop (relationship OR reference) to its target + cardinality.
 *  A reference hop is a to-one forward FK; its target is `@references`. */
function resolveHop(
  obj: MetaData,
  name: string,
): { hop: MetaData; targetName: string; cardinality: "one" | "many" } | undefined {
  const rel = findRelationship(obj, name);
  if (rel) {
    const targetName = rel.attr(RELATIONSHIP_ATTR_OBJECT_REF) as string | undefined;
    if (!targetName) return undefined;
    const cardAttr = rel.attr(RELATIONSHIP_ATTR_CARDINALITY) as string | undefined;
    return { hop: rel, targetName, cardinality: cardAttr === CARDINALITY_ONE ? "one" : "many" };
  }
  const ref = findReferenceHop(obj, name);
  if (ref) {
    const targetName = ref.attr(IDENTITY_REFERENCE_ATTR_REFERENCES) as string | undefined;
    if (!targetName) return undefined;
    return { hop: ref, targetName, cardinality: "one" };
  }
  return undefined;
}

function viewName(projection: MetaObject, ctx: ExtractContext): string {
  // The read-only source carries the physical view name. FR-016: physicalName
  // implements the four-step rule (kind-matching alias → legacy @table →
  // source.name → entity-name fallback), so the call below correctly resolves
  // @view / @materializedView / legacy @table for projection sources.
  // ADR-0039: own — projection source classification (mirrors C# projection
  // OwnSources / IsReadOnlyProjection): the view name comes from the projection's
  // OWN read-only source, not one inherited via extends.
  const viewSource = projection.ownChildren().find(
    (c): c is MetaSource => c instanceof MetaSource && c.isReadOnly(),
  );
  const explicit = viewSource?.physicalName;
  // physicalName always returns a string; empty string means the source had
  // neither alias nor a name and the owning entity name was empty (impossible
  // for a real projection). Fall through to the helper anyway for safety.
  return explicit !== undefined && explicit !== ""
    ? explicit
    : viewNameFromProjection(projection.name, ctx.columnNamingStrategy);
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

/**
 * FR-024 (ADR-0029): the entity NAMED by a node's dotted extends ref — the
 * owner part of `<owner>.<child>...` resolved as an object. Mirrors the
 * loader's `_refNamedOwner`: the ref names the anchor, never the physical
 * declaring ancestor of an inherited child.
 */
function refNamedOwner(node: MetaData, root: MetaRoot): MetaObject | undefined {
  const ref = (node as { superRef?: string }).superRef;
  if (ref === undefined) return undefined;
  const lastSep = ref.lastIndexOf("::");
  const tail = lastSep === -1 ? ref : ref.slice(lastSep + 2);
  const dot = tail.indexOf(".");
  if (dot <= 0) return undefined;
  return root.findObject(tail.slice(0, dot)) ?? undefined;
}

function baseEntityFor(
  projection: MetaObject,
  root: MetaRoot,
): MetaObject {
  // FR-024 base-anchor rules (mirror the loader's _deriveBaseEntity):
  // 1) the extends-bound identity anchors the base entity;
  // 2) else the single distinct entity targeted by extends-bound fields.
  // The pre-FR-024 object-level `extends:` firehose is removed (B4b cutover).
  //
  // COUPLING NOTE: this intentionally derives the anchor ONLY from the ref's
  // named owner (refNamedOwner), NOT the loader's `superResolved.parent`
  // fallback for a non-dotted identity extends. That fallback is unreachable
  // here because the loader gate (validate-identity-passthrough →
  // ERR_PROJECTION_IDENTITY_NOT_EXTENDED) rejects any projection whose identity
  // is not dotted-extends-bound before codegen runs. If that loader gate is
  // ever loosened, this function must grow the same fallback.
  // ADR-0039: own — the base anchor is derived from the projection's OWN
  // extends-bound declarations (refNamedOwner reads each node's own superRef,
  // which only exists on locally-declared nodes); an inherited node carries no
  // projection-local superRef, so own-iteration is correct here.
  for (const identity of projection
    .ownChildren()
    .filter((c) => c.type === TYPE_IDENTITY)) {
    const named = refNamedOwner(identity, root);
    if (named !== undefined) return named;
  }
  const targets = new Set<MetaObject>();
  // ADR-0039: own — see above; base-entity derivation reads own extends-bound fields.
  for (const f of projection.ownChildren().filter((c) => c.type === TYPE_FIELD)) {
    const named = refNamedOwner(f, root);
    if (named !== undefined && named !== projection) targets.add(named);
  }
  if (targets.size === 1) return [...targets][0]!;
  throw new Error(
    `Projection ${projection.name}: cannot derive the base entity — declare an ` +
      `extends-bound identity (identity.primary { name, extends: "<Entity>.<identity>" }) ` +
      `to anchor the base (FR-024).`,
  );
}

function sourceColumnNameFor(
  entityField: MetaData,
  ctx: ExtractContext,
): string {
  const col = entityField.attr(FIELD_ATTR_COLUMN);
  if (typeof col === "string" && col !== "") return col;
  return columnNameFromField(entityField.name, ctx.columnNamingStrategy);
}

/**
 * Physical column for a join FK/PK field — resolves @column + naming strategy the
 * same way passthrough columns do (EFFECTIVE fields, so inherited PKs resolve).
 * The JOIN ON clause must use the real column, not a hardcoded snake_case guess,
 * or it breaks under the `literal`/`kebab-case` strategies.
 */
function joinColumnFor(entity: MetaObject, fieldName: string, ctx: ExtractContext): string {
  const f = entity.fields().find((x) => x.name === fieldName);
  return f ? sourceColumnNameFor(f, ctx) : columnNameFromField(fieldName, ctx.columnNamingStrategy);
}

/** The physical column of an entity's primary-key field — the LEFT-JOIN phantom guard
 *  (#195) tests `<joined>.<pk> IS NOT NULL`, and it is origin.first's tie-breaker. */
function primaryKeyColumn(entity: MetaObject, ctx: ExtractContext): string | undefined {
  // ADR-0039: resolving — a projection base may inherit its primary identity via extends.
  const pkField = entity.primaryIdentity()?.fields[0];
  return pkField ? joinColumnFor(entity, pkField, ctx) : undefined;
}

/**
 * Walk a `@via` dotted path to its terminal (related) entity name. any/all carry no
 * `@of` to name the aggregated entity, so it is derived from the last `@via` hop.
 * Returns undefined if any hop fails to resolve (a prior loader error already fired).
 */
function viaTerminalEntity(via: string, root: MetaRoot): string | undefined {
  const segments = via.split(".");
  const rawEntity = segments[0];
  if (!rawEntity) return undefined;
  let currentObj = root.findObject(stripPackage(rawEntity));
  if (!currentObj) return undefined;
  let terminal = currentObj.name;
  for (const relName of segments.slice(1)) {
    const resolved = resolveHop(currentObj, relName);
    if (!resolved) return undefined;
    const target = root.findObject(stripPackage(resolved.targetName));
    if (!target) return undefined;
    currentObj = target;
    terminal = target.name;
  }
  return terminal;
}

/**
 * Resolve `@orderBy` keys ('field[:asc|desc]') against `entity`'s effective fields into
 * physical {column, dir} pairs (naming strategy applied). Default direction is asc; nulls
 * placement is pinned (nulls-last) at emit, not spelled here. Unknown keys are skipped
 * (the loader validates key existence — `_validateOrderByKeys`).
 */
function resolveOrderByKeys(
  orderBy: unknown,
  entity: MetaObject,
  ctx: ExtractContext,
): ViewOrderKey[] {
  if (!Array.isArray(orderBy)) return [];
  const keys: ViewOrderKey[] = [];
  for (const raw of orderBy) {
    if (typeof raw !== "string") continue;
    const colonIdx = raw.indexOf(":");
    const name = colonIdx === -1 ? raw : raw.slice(0, colonIdx);
    const dir = colonIdx === -1 ? undefined : raw.slice(colonIdx + 1);
    const field = entity.fields().find((f) => f.name === name);
    if (!field) continue;
    keys.push({ column: sourceColumnNameFor(field, ctx), dir: dir === SORT_ORDER_DESC ? "desc" : "asc" });
  }
  return keys;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Resolve a raw `attr.expression` node (from origin.computed `@expr`) into a {@link
 * ViewExprNode} whose `{field}` refs are lowered to the base alias's physical columns
 * (naming strategy applied). The emitter then walks the resolved tree. Returns undefined
 * if any node is structurally malformed or references a non-base field — the loader's
 * origin.computed validation already rejects those, so this is defensive only.
 */
function resolveExprNode(
  raw: unknown,
  base: MetaObject,
  baseAlias: string,
  ctx: ExtractContext,
): ViewExprNode | undefined {
  if (!isPlainObject(raw)) return undefined;

  if ("field" in raw) {
    const name = raw.field;
    if (typeof name !== "string") return undefined;
    const field = base.fields().find((f) => f.name === name);
    if (!field) return undefined;
    return { kind: "col", ref: `${baseAlias}.${sourceColumnNameFor(field, ctx)}` };
  }
  if ("value" in raw) {
    return { kind: "lit", value: raw.value as ViewExprLiteral };
  }
  if ("fn" in raw) {
    if (raw.fn !== EXPR_FN_COALESCE || !Array.isArray(raw.args)) return undefined;
    const args = raw.args.map((a) => resolveExprNode(a, base, baseAlias, ctx));
    if (args.some((a) => a === undefined)) return undefined;
    return { kind: "coalesce", args: args as ViewExprNode[] };
  }
  if ("op" in raw && typeof raw.op === "string") {
    const op = raw.op;
    if (EXPR_COMPARISON_OPS.has(op)) {
      const left = resolveExprNode(raw.left, base, baseAlias, ctx);
      const right = resolveExprNode(raw.right, base, baseAlias, ctx);
      return left && right ? { kind: "cmp", op, left, right } : undefined;
    }
    if (op === FILTER_OP_IS_NULL || op === EXPR_OP_IS_NOT_NULL) {
      const arg = resolveExprNode(raw.arg, base, baseAlias, ctx);
      return arg ? { kind: "nullTest", negated: op === EXPR_OP_IS_NOT_NULL, arg } : undefined;
    }
    if (op === EXPR_OP_NOT) {
      const arg = resolveExprNode(raw.arg, base, baseAlias, ctx);
      return arg ? { kind: "not", arg } : undefined;
    }
    if (op === FILTER_COMPOSE_AND || op === FILTER_COMPOSE_OR) {
      if (!Array.isArray(raw.args)) return undefined;
      const args = raw.args.map((a) => resolveExprNode(a, base, baseAlias, ctx));
      if (args.some((a) => a === undefined)) return undefined;
      return { kind: "logic", op: op === FILTER_COMPOSE_AND ? "and" : "or", args: args as ViewExprNode[] };
    }
  }
  return undefined;
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
  /** Physical column names (strategy + @column resolved), ready for the ON clause. */
  fkColumn: string;
  pkColumn: string;
  referenceHolder: "source" | "target";
  /** #209 — derived join type: `inner` for a required belongs-to FK, else `left`. */
  joinType: "inner" | "left";
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
  ctx: ExtractContext,
): JoinTree {
  const allPaths: Path[] = [];

  // ADR-0039: own — a projection's DECLARED field set IS the exposure (FR-024/
  // ADR-0028, inclusive + fail-closed); iterate the projection's own fields and
  // each field's own origin. origin.* NEVER inherits (ADR-0029), so origin reads
  // below are own by policy (category 4).
  for (const field of projection.ownChildren()) {
    if (field.type !== TYPE_FIELD) continue;
    for (const origin of field.ownChildren()) {
      if (origin.type !== TYPE_ORIGIN) continue;
      // ADR-0039: own (category 4) — origin.* never inherits (ADR-0029).
      // Only aggregate (count/sum/avg/min/max/any/all/collect) and passthrough origins
      // contribute a LEFT-JOIN branch. origin.computed is row-level (no @via); origin.first
      // (#195) lowers to a CORRELATED subquery, NOT a join — its @via must NOT enter the
      // join tree (both @from-via and @first-via share the physical name "via", so an
      // unguarded read would wrongly join a `first`).
      let viaAttr: string | undefined;
      if (origin.subType === ORIGIN_SUBTYPE_AGGREGATE) {
        viaAttr = origin.ownAttr(ORIGIN_AGGREGATE_ATTR_VIA) as string | undefined;
      } else if (origin.subType === ORIGIN_SUBTYPE_PASSTHROUGH) {
        viaAttr = origin.ownAttr(ORIGIN_PASSTHROUGH_ATTR_VIA) as string | undefined;
      } else {
        continue;
      }
      if (!viaAttr) continue;

      const segments = viaAttr.split(".");
      const rawEntity = segments[0];
      const relSegments = segments.slice(1);
      if (!rawEntity) continue;
      // @via may be package-qualified ("pkg::Entity.rel"); the joinTree + findObject
      // key on bare names (so they line up with bare passthrough @from lookups).
      const entityName = stripPackage(rawEntity);
      let currentObj = root.findObject(entityName);
      if (!currentObj) continue;

      const path: Path = [];
      for (const relName of relSegments) {
        // FR-024: a hop may name a relationship OR a reference-only FK
        // (identity.reference — a to-one forward-FK edge). ADR-0039: resolving —
        // a traversed relationship/reference may inherit its target via extends.
        const resolved = resolveHop(currentObj, relName);
        if (!resolved) break;
        const { targetName, cardinality } = resolved;
        // @objectRef/@references may be package-qualified ("pkg::Entity") — the directory
        // loader qualifies a same-package ref even when authored bare — but findObject
        // keys on the BARE name (like the @via/@of/@from paths above). Strip first, or
        // the join (and every aggregate traversing it) is silently dropped.
        const target = root.findObject(stripPackage(targetName));
        if (!target) break;

        const ref = findReferenceBetween(currentObj as MetaObject, target);
        if (!ref) break;

        const fkField = ref.referenceIdentity.fields[0];
        if (!fkField) break;

        const resolvedPkField = ref.referenceIdentity.resolvedTargetPkField(root) ?? "id";

        const referenceHolder: "source" | "target" =
          ref.holder.name === currentObj.name ? "source" : "target";

        // FK lives on the holder; PK on the entity it references. Resolve both to
        // physical columns now so the ON clause is naming-strategy correct.
        const fkHolder = referenceHolder === "source" ? currentObj : target;
        const pkHolder = referenceHolder === "source" ? target : currentObj;

        // #209 — a belongs-to hop (FK on the parent) whose FK is NOT NULL is
        // semantically INNER: every base row has a match, so INNER and LEFT OUTER
        // return the same set, and INNER matches the hand-written view it stands in
        // for (and keeps `verify --db` fingerprints aligned). A nullable belongs-to
        // FK, or ANY has-many hop (FK on the child — a base row may have zero
        // children), stays LEFT OUTER so no base row is dropped.
        const fkFieldObj = (fkHolder as MetaObject).findField(fkField);
        const selfInner =
          referenceHolder === "source" && fkFieldObj !== undefined && isRequired(fkFieldObj);
        // Nested-chain safety: joins render flat + left-associative, so an INNER hop
        // BELOW any LEFT ancestor drops the base row (its ON references a column the
        // LEFT ancestor NULLed). An INNER only survives when the ENTIRE ancestor chain
        // is INNER; otherwise demote to LEFT (lossless — under a LEFT ancestor, LEFT is
        // the correct type). `path` holds this chain's ancestor hops accumulated so far.
        const joinType: "inner" | "left" =
          selfInner && path.every((prior) => prior.joinType === "inner") ? "inner" : "left";

        path.push({
          entity: currentObj,
          relationship: relName,
          cardinality,
          fkColumn: joinColumnFor(fkHolder, fkField, ctx),
          pkColumn: joinColumnFor(pkHolder, resolvedPkField, ctx),
          referenceHolder,
          joinType,
          targetEntity: stripPackage(targetName),
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
      fkColumn: step.fkColumn,
      pkColumn: step.pkColumn,
      referenceHolder: step.referenceHolder,
      joinType: step.joinType,
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
  usedAliases: Set<string>,
): SelectSpec {
  const columns: SelectColumn[] = [];

  // FR-024 (ADR-0028): the projection's DECLARED field set IS the exposure —
  // the inclusive list, fail-closed by construction. The pre-FR-024 loop that
  // emitted every base-entity field as an implicit passthrough (the firehose)
  // is removed with the B4b cutover: base columns are declared explicitly as
  // extends-bound fields (`{ field.int: { name: id, extends: "Program.id" } }`).

  // #213 — an entity read-view HOST (base === projection, FR-024 §7) exposes its
  // EFFECTIVE field set: the `o.*` includes fields inherited via extends (a
  // BaseEntity id/createdAt). A plain projection exposes only its DECLARED (own)
  // fields — the declared set IS the exposure (FR-024/ADR-0028). Either way, each
  // field's own origin decides passthrough-from-base vs derived-from-join. origin.*
  // NEVER inherits (ADR-0029), so the origin reads below are own (category 4).
  const declaredFields: MetaField[] =
    base === projection
      ? base.fields()
      : projection.ownChildren().filter((c): c is MetaField => c.type === TYPE_FIELD);
  for (const field of declaredFields) {
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
      // ADR-0039: own (category 4) — origin.* never inherits (ADR-0029).
      const from = origin.ownAttr(ORIGIN_PASSTHROUGH_ATTR_FROM) as string;
      const dotIdx = from.indexOf(".");
      if (dotIdx < 1) continue;
      // @from is package-qualified ("pkg::Entity.field"); the joinTree + findObject
      // key on the BARE entity name, so strip the package before resolving.
      const entityName = stripPackage(from.slice(0, dotIdx));
      const fieldName = from.slice(dotIdx + 1);
      const targetEntity = root.findObject(entityName);
      const sourceAlias = findAliasInTree(joinTree, entityName);
      if (!targetEntity || sourceAlias === undefined) continue;
      // EFFECTIVE fields — the source column may be inherited via `extends`
      // (e.g. created_at/updated_at/created_by from an audited base), which
      // ownChildren() would miss.
      const targetField = targetEntity.fields().find((f) => f.name === fieldName);
      if (!targetField) continue;
      columns.push({
        kind: "passthrough",
        fieldName: field.name,
        dbColAlias: dbCol,
        sourceAlias,
        sourceColumn: sourceColumnNameFor(targetField, ctx),
      });
    } else if (origin.subType === ORIGIN_SUBTYPE_AGGREGATE) {
      // ADR-0039: own (category 4) — origin.* never inherits (ADR-0029).
      const agg = origin.ownAttr(ORIGIN_AGGREGATE_ATTR_AGG) as string | undefined;
      if (!agg) continue;
      const filterAttr = origin.ownAttr(ORIGIN_AGGREGATE_ATTR_FILTER);

      if (agg === AGG_ANY || agg === AGG_ALL) {
        // #195 predicate quantifier — no @of; the related entity is @via's terminal
        // hop, and @filter is the (required) quantified predicate.
        const via = origin.ownAttr(ORIGIN_AGGREGATE_ATTR_VIA) as string | undefined;
        if (!via) continue;
        const relatedName = viaTerminalEntity(via, root);
        if (!relatedName) continue;
        const relatedEntity = root.findObject(relatedName);
        const sourceAlias = findAliasInTree(joinTree, relatedName);
        if (!relatedEntity || sourceAlias === undefined) continue;
        const joinedPk = primaryKeyColumn(relatedEntity, ctx);
        if (joinedPk === undefined) continue;
        const pred = filterAttr !== undefined
          ? resolveAggregateFilter(filterAttr, relatedEntity, sourceAlias, ctx)
          : undefined;
        if (pred === undefined) continue; // loader requires @filter on any/all
        columns.push({
          kind: "predicateAgg",
          fieldName: field.name,
          dbColAlias: dbCol,
          quant: agg === AGG_ANY ? "any" : "all",
          sourceAlias,
          joinedPkColumn: joinedPk,
          pred,
        });
        continue;
      }

      // collect + the scalar reduces (count/sum/avg/min/max) all name @of.
      const of_ = origin.ownAttr(ORIGIN_AGGREGATE_ATTR_OF) as string | undefined;
      if (!of_) continue;
      const dotIdx = of_.indexOf(".");
      if (dotIdx < 1) continue;
      const entityName = stripPackage(of_.slice(0, dotIdx));
      const fieldName = of_.slice(dotIdx + 1);
      const targetEntity = root.findObject(entityName);
      const sourceAlias = findAliasInTree(joinTree, entityName);
      if (!targetEntity || sourceAlias === undefined) continue;
      const targetField = targetEntity.fields().find((f) => f.name === fieldName);
      if (!targetField) continue;

      if (agg === AGG_COLLECT) {
        // #195 array rollup — collect @of across the related set. @distinct = set
        // semantics; @orderBy (non-distinct) sets element order, else value-ascending.
        const joinedPk = primaryKeyColumn(targetEntity, ctx);
        if (joinedPk === undefined) continue;
        const distinct = origin.ownAttr(ORIGIN_ATTR_DISTINCT) === true;
        const orderBy = resolveOrderByKeys(origin.ownAttr(ORIGIN_ATTR_ORDER_BY), targetEntity, ctx);
        columns.push({
          kind: "collectAgg",
          fieldName: field.name,
          dbColAlias: dbCol,
          sourceAlias,
          sourceColumn: sourceColumnNameFor(targetField, ctx),
          joinedPkColumn: joinedPk,
          distinct,
          orderBy,
        });
        continue;
      }

      if (SCALAR_AGG_FUNCTIONS.has(agg)) {
        // Optional scoping filter — resolved against the aggregated entity (the @of
        // entity, reached at `sourceAlias`), e.g. max(version) over only active rows.
        const filter = filterAttr !== undefined
          ? resolveAggregateFilter(filterAttr, targetEntity, sourceAlias, ctx)
          : undefined;
        columns.push({
          kind: "aggregate",
          fieldName: field.name,
          dbColAlias: dbCol,
          agg: agg as AggregateFunction,
          sourceAlias,
          sourceColumn: sourceColumnNameFor(targetField, ctx),
          ...(filter !== undefined ? { filter } : {}),
        });
      }
    } else if (origin.subType === ORIGIN_SUBTYPE_COMPUTED) {
      // #195 row-level computed value from the base entity's own fields (@expr tree,
      // no @via). ADR-0039: own — origin.* never inherits (ADR-0029).
      const rawExpr = origin.ownAttr(ORIGIN_COMPUTED_ATTR_EXPR);
      const expr = resolveExprNode(rawExpr, base, joinTree.baseAlias, ctx);
      if (expr === undefined) continue;
      columns.push({ kind: "computed", fieldName: field.name, dbColAlias: dbCol, expr });
    } else if (origin.subType === ORIGIN_SUBTYPE_FIRST) {
      // #195 correlated latest-row — argmax-then-project. Resolves to a correlated
      // subquery (NOT a join). ADR-0039: own — origin.* never inherits (ADR-0029).
      const of_ = origin.ownAttr(ORIGIN_FIRST_ATTR_OF) as string | undefined;
      if (!of_) continue;
      const dotIdx = of_.indexOf(".");
      if (dotIdx < 1) continue;
      const childName = stripPackage(of_.slice(0, dotIdx));
      const ofFieldName = of_.slice(dotIdx + 1);
      const childEntity = root.findObject(childName);
      if (!childEntity) continue;
      const ofField = childEntity.fields().find((f) => f.name === ofFieldName);
      if (!ofField) continue;
      // The base↔child correlation FK — resolved exactly as buildJoinTree resolves a
      // single hop (the identity.reference is the FK-direction SSOT). Single-hop @via;
      // a multi-hop @via on origin.first is not lowered here (rare, and validated away).
      const ref = findReferenceBetween(base, childEntity);
      if (!ref) continue;
      const fkField = ref.referenceIdentity.fields[0];
      if (!fkField) continue;
      const pkField = ref.referenceIdentity.resolvedTargetPkField(root) ?? "id";
      const referenceHolder: "source" | "target" =
        ref.holder.name === base.name ? "source" : "target";
      const fkHolder = referenceHolder === "source" ? base : childEntity;
      const pkHolder = referenceHolder === "source" ? childEntity : base;
      const childPk = primaryKeyColumn(childEntity, ctx);
      if (childPk === undefined) continue;
      // A FRESH alias — the subquery is an independent correlated scope, never the
      // JOIN-tree alias (reserved against usedAliases so it can never collide).
      const childAlias = shortAliasFor(childEntity.name, usedAliases);
      const orderBy = resolveOrderByKeys(origin.ownAttr(ORIGIN_ATTR_ORDER_BY), childEntity, ctx);
      const filterAttr = origin.ownAttr(ORIGIN_FIRST_ATTR_FILTER);
      const filter = filterAttr !== undefined
        ? resolveAggregateFilter(filterAttr, childEntity, childAlias, ctx)
        : undefined;
      columns.push({
        kind: "first",
        fieldName: field.name,
        dbColAlias: dbCol,
        childEntity: childEntity.name,
        childAlias,
        sourceColumn: sourceColumnNameFor(ofField, ctx),
        referenceHolder,
        fkColumn: joinColumnFor(fkHolder, fkField, ctx),
        pkColumn: joinColumnFor(pkHolder, pkField, ctx),
        childPkColumn: childPk,
        orderBy,
        ...(filter !== undefined ? { filter } : {}),
      });
    }
  }

  return { columns };
}

/** The inflation-sensitive aggregate kinds: a non-distinct row multiplication corrupts
 *  their value (sum/avg double-count; a non-distinct collect duplicates elements).
 *  count is DISTINCT-guarded; min/max and any/all are inflation-immune. */
function isInflationSensitive(c: SelectColumn): boolean {
  if (c.kind === "aggregate") return c.agg === "sum" || c.agg === "avg";
  if (c.kind === "collectAgg") return !c.distinct;
  return false;
}

/** Count top-level join branches that traverse at least one to-many hop. Two or more
 *  independent many-branches multiply (cartesian) and inflate sensitive aggregates. */
function countManyBranches(joinTree: JoinTree): number {
  const hasMany = (node: JoinNode): boolean =>
    node.cardinality === "many" || node.children.some(hasMany);
  return joinTree.joins.filter(hasMany).length;
}

function buildGroupBy(spec: SelectSpec): string[] {
  // predicateAgg (bool_or/bool_and) and collectAgg (array_agg) are real aggregates and
  // force GROUP BY too; computed/first are scalar-per-row and never grouped.
  const hasAgg = spec.columns.some(
    (c) => c.kind === "aggregate" || c.kind === "predicateAgg" || c.kind === "collectAgg",
  );
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
  // #213 — a write-through entity (FR-024 §7) IS its own base: stored fields SELECT
  // from the base alias (o.*), derived (origin.*) fields from the joins. A plain
  // projection anchors its base via an extends binding (baseEntityFor).
  const writeThrough = isWriteThrough(projection);
  const base = writeThrough ? projection : baseEntityFor(projection, root);
  const usedAliases = new Set<string>();
  const baseAlias = shortAliasFor(base.name, usedAliases);
  const joinTree = buildJoinTree(projection, base, root, usedAliases, baseAlias, ctx);
  const selectSpec = buildSelectSpec(projection, base, joinTree, root, ctx, usedAliases);
  const groupBy = buildGroupBy(selectSpec);

  const view = viewName(projection, ctx);
  warnOnJoinInflation(projection, view, joinTree, selectSpec);

  // #207 — a projection's OWN row-scope @filter lowers to the view's outer WHERE.
  // Gated to projections only (v1 scope): a write-through entity read-view is
  // NEVER filtered — a filtered replica breaks read-your-writes totality, and the
  // @filter attr is registered on object.projection (not object.entity), so a
  // write-through entity cannot carry one anyway. The stored value is already the
  // desugared canonical { field: { op: value } } form (FilterAttr.desugar at parse).
  let where: ViewFilterClause | undefined;
  if (!writeThrough) {
    const rawFilter = projection.ownAttr(OBJECT_PROJECTION_ATTR_FILTER);
    if (rawFilter !== undefined) {
      const columnsByField = new Map<string, SelectColumn>(
        selectSpec.columns.map((c) => [c.fieldName, c] as const),
      );
      where = resolveViewFilter(rawFilter, columnsByField, projection.name);
    }
  }

  return {
    viewName: view,
    joinTree,
    selectSpec,
    groupBy,
    ...(where !== undefined ? { where } : {}),
  };
}

/**
 * #195 (spec §6, risk 2) — emit a load-time WARN when an inflation-sensitive aggregate
 * (`sum`/`avg`/non-distinct `collect`) coexists with ≥2 independent to-many join
 * branches in one view. Two many-branches multiply (cartesian), silently double-counting
 * — a latent bug for `sum`/`avg` today, now surfaced. count is DISTINCT-guarded and
 * min/max/any/all are inflation-immune, so they never trip it.
 */
function warnOnJoinInflation(
  projection: MetaObject,
  viewName: string,
  joinTree: JoinTree,
  spec: SelectSpec,
): void {
  if (countManyBranches(joinTree) < 2) return;
  const sensitive = spec.columns.filter(isInflationSensitive).map((c) => c.fieldName);
  if (sensitive.length === 0) return;
  console.warn(
    `[codegen-ts] projection "${projection.name}" (view ${viewName}): inflation-sensitive ` +
      `aggregate field(s) [${sensitive.join(", ")}] coexist with ${countManyBranches(joinTree)} ` +
      `independent to-many join branches — the joins multiply, so these values may double-count. ` +
      `Split them into separate projections, or scope with @filter/@distinct.`,
  );
}
