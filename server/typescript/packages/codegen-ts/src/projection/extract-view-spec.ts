import {
  TYPE_FIELD,
  FIELD_ATTR_OBJECT_REF,
  TYPE_IDENTITY,
  TYPE_ORIGIN,
  TYPE_RELATIONSHIP,
  isMetaObject,
  TYPE_OBJECT,
  lookupCanonical,
  splitChildTail,
  isReadOnlySource,
  SOURCE_ROLE_PRIMARY,
  SOURCE_ATTR_SCHEMA,
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
  ORIGIN_PASSTHROUGH_ATTR_CONVERT,
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
  FILTER_OP_IN,
  FILTER_OP_LIKE,
  FIELD_SUBTYPE_ENUM,
  FILTER_COMPOSE_AND,
  FILTER_COMPOSE_OR,
  FILTER_RELATIVE_NOW,
  FILTER_RELATIVE_START_OF,
  FIELD_SUBTYPE_DATE,
  FIELD_SUBTYPE_TIMESTAMP,
  type RelativeStartOf,
  SORT_ORDER_DESC,
  RELATIONSHIP_ATTR_OBJECT_REF,
  RELATIONSHIP_ATTR_CARDINALITY,
  RELATIONSHIP_ATTR_SOURCE_REF_FIELD,
  CARDINALITY_ONE,
  IDENTITY_SUBTYPE_REFERENCE,
  IDENTITY_REFERENCE_ATTR_REFERENCES,
  FIELD_ATTR_COLUMN,
  effectiveProjectionFilter,
  OBJECT_SUBTYPE_PROJECTION,
  findReferencesBetween,
  findReverseReferenceHops,
  resolveRelationshipReference,
  resolveObjectRef,
  resolveFieldPathColumn,
  resolveFilterPath,
  isMetaRoot,
  isMetaField,
  type FilterPath,
  ORIGIN_ATTR_SEGMENT,
  FILTER_OPERAND_FIELD,
  FILTER_OP_IS_DISTINCT_FROM,
  FILTER_OP_IS_NOT_DISTINCT_FROM,
  refTarget,
  type AggregateFunction,
  type ReferenceLookup,
} from "@metaobjectsdev/metadata";
import { type MetaData, type MetaField, type MetaReferenceIdentity, type MetaRoot, type MetaSource, MetaObject } from "@metaobjectsdev/metadata";
import { intValueMapOf } from "../enum-meta.js";
import {
  columnNameFromField,
  viewNameFromProjection,
} from "../naming.js";
// #213 — a write-through ENTITY (FR-024 §7 read-view) hosts its own view; the base
// is the entity itself, not an extends-anchored projection.
import { isWriteThrough } from "./projection-detector.js";
import { tphDiscriminatorBase, tphDiscriminatorPin } from "../tph.js";
import type { ColumnNamingStrategy } from "../metaobjects-config.js";
import { fieldSqlType } from "@metaobjectsdev/migrate-ts/expected";
import { segmentClause, temporalOf } from "./report-sql.js";
import type { RelativeNow } from "./report-spec.js";
import type { ReportTemporal } from "./time-sql.js";
import type {
  JoinNode, JoinTree, SelectColumn, SelectSpec, ViewSpec, ViewFilterClause,
  ViewExprNode, ViewExprLiteral, ViewOrderKey, FirstInnerJoin, TphScope, FirstColumn, ColRef,
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
// `case` node keys (mirror meta-attr-expression's case grammar).
const EXPR_CASE = "case";
const EXPR_CASE_WHEN = "when";
const EXPR_CASE_THEN = "then";
const EXPR_CASE_ELSE = "else";
const EXPR_CASE_OPERAND = "operand";

/** The scalar-reduce @agg values that map to the plain `aggregate` SelectColumn kind. */
const SCALAR_AGG_FUNCTIONS: ReadonlySet<string> = new Set(AGGREGATE_FUNCTIONS);
/** Expression comparison ops (share the filter vocabulary + per-subtype legality bands). */
const EXPR_COMPARISON_OPS: ReadonlySet<string> = new Set([
  FILTER_OP_EQ, FILTER_OP_NE, FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE,
]);

/**
 * Desugar a single field clause to the canonical `{ op: value }` form (scalar→eq,
 * array→in, null→isNull, an object carrying a `now` key→eq, any other object→as-is).
 * Mirrors metadata's attr.filter desugar (`core/attr/meta-attr-filter.ts`) so an
 * aggregate `@filter` works whether or not it was pre-desugared by the loader.
 *
 * The `now` rule matters here: `{ now: "-P7D" }` is a relative-date VALUE (FR-044 F2),
 * never an op map. Read as-is, a programmatic, pre-desugar shorthand `{ f: { now: "x" } }`
 * would lower as op `now` with value `"x"`.
 */
export function desugarClause(raw: unknown): Record<string, unknown> {
  if (raw === null) return { [FILTER_OP_IS_NULL]: true };
  if (Array.isArray(raw)) return { [FILTER_OP_IN]: raw };
  if (typeof raw === "object") {
    return FILTER_RELATIVE_NOW in raw ? { [FILTER_OP_EQ]: raw } : (raw as Record<string, unknown>);
  }
  return { [FILTER_OP_EQ]: raw };
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
  /** The base row a `{ field }` operand names, and its alias (correlated filter). */
  outer?: OuterRow,
): ViewFilterClause | undefined {
  if (typeof filter !== "object" || filter === null || Array.isArray(filter)) return undefined;
  const clauses: ViewFilterClause[] = [];
  for (const [key, val] of Object.entries(filter as Record<string, unknown>)) {
    if (key === FILTER_AND || key === FILTER_OR) {
      const subs = (Array.isArray(val) ? val : [])
        .map((s) => resolveAggregateFilter(s, entity, alias, ctx, outer))
        .filter((c): c is ViewFilterClause => c !== undefined);
      if (subs.length > 0) clauses.push({ kind: key === FILTER_AND ? "and" : "or", clauses: subs });
      continue;
    }
    const field = entity.fields().find((f) => f.name === key);
    // The loader resolves every key; one that reaches here unresolved would drop a predicate.
    if (!field) throw new Error(`origin @filter key "${key}" names no field of "${entity.name}".`);
    const opObj = desugarClause(val);
    const ops = Object.keys(opObj);
    if (ops.length === 0) throw new Error(`origin @filter on "${key}" has no operator.`);
    // A field clause may carry several operators (a range { gte, lte }); each is its own
    // comparison and they compose with AND. Keeping one would widen the aggregated row set.
    const fieldClauses: ViewFilterClause[] = ops.map((op) => {
      const operand = opObj[op];
      return {
        kind: "cmp",
        ref: `${alias}.${sourceColumnNameFor(field, ctx)}`,
        op,
        // Same int-backed-enum encoding as the row-scope @filter below: this scoping
        // filter renders as a SQL literal too (FILTER (WHERE …) / CASE WHEN), so a
        // member symbol would land unencoded in an integer comparison. A relative date
        // and a base-row operand lower here too.
        value: lowerFilterValue(operand, op, field, key, `origin @filter over ${entity.name}`, outer, ctx),
      };
    });
    clauses.push(fieldClauses.length === 1 ? fieldClauses[0]! : { kind: "and", clauses: fieldClauses });
  }
  if (clauses.length === 0) return undefined;
  return clauses.length === 1 ? clauses[0]! : { kind: "and", clauses };
}

/** The row a `{ field: "<name>" }` filter operand reads, and its alias. */
export interface OuterRow {
  readonly entity: MetaObject;
  readonly alias: string;
}

/** A `{ field: "<name>" }` operand, not a relative date. */
function isFieldOperand(v: unknown): v is { field: string } {
  return isPlainObject(v) && typeof v[FILTER_OPERAND_FIELD] === "string" && !(FILTER_RELATIVE_NOW in v);
}

function isRelativeOperand(v: unknown): v is Record<string, unknown> {
  return isPlainObject(v) && FILTER_RELATIVE_NOW in v;
}

/** The relative-date kind of a temporal field; an instant for anything else. */
function temporalOfField(f: MetaField): ReportTemporal {
  return f.subType === FIELD_SUBTYPE_DATE || f.subType === FIELD_SUBTYPE_TIMESTAMP ? temporalOf(f) : "instant";
}

/** A relative-date operand on `field`, as the value the emitters render. */
function relativeNowOf(v: Record<string, unknown>, field: MetaData, key: string, where: string): RelativeNow {
  if (field.subType !== FIELD_SUBTYPE_DATE && field.subType !== FIELD_SUBTYPE_TIMESTAMP) {
    throw new Error(`${where}: a relative-date value on "${key}" needs a field.date or field.timestamp.`);
  }
  return {
    kind: "relativeNow",
    duration: String(v[FILTER_RELATIVE_NOW]),
    temporal: temporalOf(field as MetaField),
    ...(FILTER_RELATIVE_START_OF in v ? { startOf: v[FILTER_RELATIVE_START_OF] as RelativeStartOf } : {}),
  };
}

/**
 * One filter operand for `field`, as the emitters render it: a relative date, a base-row column
 * (only where an `outer` row exists), or a literal (an int-backed enum member as its integer).
 */
function lowerFilterValue(
  raw: unknown, op: string, field: MetaData, key: string, where: string, outer: OuterRow | undefined, ctx: ExtractContext,
): unknown {
  if (isRelativeOperand(raw)) return relativeNowOf(raw, field, key, where);
  if (Array.isArray(raw) && raw.some(isRelativeOperand)) {
    return raw.map((v) => (isRelativeOperand(v) ? relativeNowOf(v, field, key, where) : v));
  }
  if (isFieldOperand(raw)) {
    const name = raw[FILTER_OPERAND_FIELD];
    const other = outer?.entity.fields().find((f) => f.name === name);
    if (outer === undefined || other === undefined) {
      throw new Error(`${where}: "${key}" compares with base-row field "${name}", which the base row does not have.`);
    }
    return { kind: "colRef", ref: `${outer.alias}.${sourceColumnNameFor(other, ctx)}` } satisfies ColRef;
  }
  if (op === FILTER_OP_IS_DISTINCT_FROM || op === FILTER_OP_IS_NOT_DISTINCT_FROM) {
    throw new Error(`${where}: "${op}" on "${key}" needs a { field } operand.`);
  }
  return encodeIntEnumFilterValue(
    raw, op, field.subType === FIELD_SUBTYPE_ENUM ? intValueMapOf(field as MetaField) : undefined, key, where,
  );
}

/** An origin's `@segment` predicate over `entity` at `alias`, ANDed with its `@filter`. */
function originScope(
  origin: MetaData, filterAttr: unknown, entity: MetaObject, alias: string, ctx: ExtractContext, outer: OuterRow | undefined,
): ViewFilterClause | undefined {
  // ADR-0039: own (category 4) — origin.* never inherits (ADR-0029).
  const segment = origin.ownAttr(ORIGIN_ATTR_SEGMENT);
  const seg = typeof segment === "string"
    ? segmentClause(segment, entity, alias, ctx, `origin.${origin.subType} @segment`)
    : undefined;
  return andClauses(seg, filterAttr !== undefined ? resolveAggregateFilter(filterAttr, entity, alias, ctx, outer) : undefined);
}

/**
 * The `@intValueMap` of every int-backed `field.enum` the projection declares, keyed
 * by field name. Only int-backed enums appear, so a lookup miss means "no encoding".
 *
 * `fields()` (effective) and `intValueMapOf` (which reads `attr`, RESOLVING) — a
 * projection's fields are bound through `extends` to the base entity's, and post-#246
 * the map itself commonly lives one hop further up on a shared abstract declaration.
 * Own-only at either hop would silently emit the member symbol into an integer column
 * (ADR-0039).
 */
function intEnumMapsOf(projection: MetaObject): ReadonlyMap<string, Record<string, number>> {
  const out = new Map<string, Record<string, number>>();
  for (const f of projection.fields()) {
    if (f.subType !== FIELD_SUBTYPE_ENUM) continue;
    const map = intValueMapOf(f);
    if (map !== undefined) out.set(f.name, map);
  }
  return out;
}

/**
 * Lower a filter value for an int-backed `field.enum` from its member SYMBOL to the
 * INTEGER it persists as. A no-op for every other field (`intMap` undefined), so a
 * string-backed enum's SQL is byte-identical.
 *
 * `isNull` is skipped — its value is a boolean, not a member. `like` is unreachable:
 * `opsForField` removes it from an int-backed enum's band, so the loader rejects it
 * before codegen; the explicit throw makes that a loud failure rather than a
 * `LIKE NaN`. An unmapped member is likewise loader-unreachable (the key set is
 * pinned equal to `@values`) and throws for the same reason — silently emitting the
 * symbol would produce DDL that fails only at apply time, against a live database.
 */
export function encodeIntEnumFilterValue(
  value: unknown,
  op: string,
  intMap: Record<string, number> | undefined,
  fieldName: string,
  /** Names the filter being lowered, for the error text: the row-scope view @filter
   *  (`Projection P: view @filter`) or an aggregate's scoping filter
   *  (`origin.aggregate @filter over E`). */
  host: string,
): unknown {
  if (intMap === undefined) return value;
  if (op === FILTER_OP_IS_NULL) return value;
  if (op === FILTER_OP_LIKE) {
    throw new Error(
      `${host} uses "like" on "${fieldName}", an ` +
        `int-backed field.enum (@intValueMap) — it stores as an integer column, so a ` +
        `substring match is not expressible. Use eq/ne/in.`,
    );
  }
  const encode = (v: unknown): unknown => {
    if (typeof v !== "string") return v;
    const n = intMap[v];
    if (typeof n !== "number") {
      throw new Error(
        `${host} value "${v}" for "${fieldName}" has no ` +
          `entry in @intValueMap.`,
      );
    }
    return n;
  };
  return Array.isArray(value) ? value.map(encode) : encode(value);
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
  intMapsByField: ReadonlyMap<string, Record<string, number>>,
  /** The field each key names (a relative date reads its type to lower). */
  fieldsByKey: ReadonlyMap<string, MetaData> = new Map(),
): ViewFilterClause | undefined {
  if (typeof filter !== "object" || filter === null || Array.isArray(filter)) return undefined;
  const clauses: ViewFilterClause[] = [];
  for (const [key, val] of Object.entries(filter as Record<string, unknown>)) {
    if (key === FILTER_AND || key === FILTER_OR) {
      const subs = (Array.isArray(val) ? val : [])
        .map((s) => resolveViewFilter(s, columnsByField, projectionName, intMapsByField, fieldsByKey))
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
    for (const [op, rawValue] of Object.entries(desugarClause(val))) {
      // An INT-BACKED field.enum (@intValueMap, design D5) stores as an INTEGER
      // column, so the authored member SYMBOL must become its integer before it is
      // rendered as a SQL literal. The Drizzle customType handles the runtime query
      // path, but view DDL is emitted as literal SQL text and never touches Drizzle.
      const where = `Projection ${projectionName}: view @filter`;
      const keyField = fieldsByKey.get(key);
      const value = isRelativeOperand(rawValue) && keyField !== undefined
        ? relativeNowOf(rawValue, keyField, key, where)
        : encodeIntEnumFilterValue(rawValue, op, intMapsByField.get(key), key, where);
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
 *  A reference hop is a to-one forward FK; its target is `@references`. A hop naming
 *  neither may walk an identity.reference BACKWARDS (#560): `Project.timeEntries` is the
 *  reference TimeEntry holds onto Project, named by TimeEntry's collection name — a to-many
 *  hop whose target is the holder (`reverse`). It resolves only when exactly one reference
 *  answers the name; the loader refuses an ambiguous one (ERR_AMBIGUOUS_PATH). */
function resolveHop(
  obj: MetaData,
  name: string,
  root: MetaRoot,
): { hop: MetaData; target: MetaObject | undefined; cardinality: "one" | "many"; reverse?: true } | undefined {
  // ADR-0059 R3/R7 — a hop's target is the object its reference attribute binds to, resolved
  // in the package of the node that declares that attribute, never the walked entity's.
  const rel = findRelationship(obj, name);
  if (rel) {
    if (!rel.attr(RELATIONSHIP_ATTR_OBJECT_REF)) return undefined;
    const target = refTarget(rel, RELATIONSHIP_ATTR_OBJECT_REF);
    const cardAttr = rel.attr(RELATIONSHIP_ATTR_CARDINALITY) as string | undefined;
    return {
      hop: rel,
      target: isMetaObject(target) ? target : undefined,
      cardinality: cardAttr === CARDINALITY_ONE ? "one" : "many",
    };
  }
  const ref = findReferenceHop(obj, name);
  if (ref) {
    if (!ref.attr(IDENTITY_REFERENCE_ATTR_REFERENCES)) return undefined;
    const target = refTarget(ref, IDENTITY_REFERENCE_ATTR_REFERENCES);
    return { hop: ref, target: isMetaObject(target) ? target : undefined, cardinality: "one" };
  }
  if (!isMetaObject(obj)) return undefined;
  const reverse = findReverseReferenceHops(obj, name, root.objects());
  if (reverse.length !== 1) return undefined;
  const { holder, referenceIdentity } = reverse[0]!;
  return { hop: referenceIdentity, target: holder, cardinality: "many", reverse: true };
}

/**
 * #368: which identity.reference does a resolved `@via` hop actually mean?
 *
 * `resolveHop` already found the EXACT node the hop segment named — a
 * reference hop names the reference itself (nothing to disambiguate: two
 * references onto the same target can coexist, but the hop picked one of them
 * by name), and a relationship hop names a relationship whose backing
 * reference `resolveRelationshipReference` resolves via the same SSOT ladder
 * (unique candidate -> @sourceRefField -> unique name-pairing) that
 * relation-resolver.ts already uses for the identical question elsewhere.
 * Discarding `hop` and re-deriving purely from `holder`/`target` — as this
 * file did before — throws away that specificity and reintroduces the exact
 * ambiguity a named hop exists to resolve.
 *
 * Returns a single `ReferenceLookup` once resolved unambiguously, or the full
 * candidate list when even the ladder cannot choose (a relationship hop whose
 * name pairs with none of its candidates and no `@sourceRefField`) — the
 * caller reports that list as a genuine ambiguity.
 */
function resolveHopReference(
  holder: MetaObject,
  hop: MetaData,
  hopName: string,
  target: MetaObject,
  reverse = false,
): ReferenceLookup | ReferenceLookup[] {
  // #560 — a reverse hop walks the reference `target` holds onto `holder`.
  if (reverse) return { holder: target, other: holder, referenceIdentity: hop as unknown as MetaReferenceIdentity };
  if (hop.type === TYPE_IDENTITY && hop.subType === IDENTITY_SUBTYPE_REFERENCE) {
    return { holder, other: target, referenceIdentity: hop as unknown as MetaReferenceIdentity };
  }
  // ADR-0039: resolving — @sourceRefField may be inherited via extends.
  const sourceRefField = hop.attr(RELATIONSHIP_ATTR_SOURCE_REF_FIELD) as string | undefined;
  const matching = resolveRelationshipReference(holder, hopName, target, sourceRefField);
  if (matching) {
    return { holder, other: target, referenceIdentity: matching };
  }
  return findReferencesBetween(holder, target);
}

/**
 * The identity.reference one hop from `holder` crosses, resolved exactly as `walkViaPath`
 * resolves that hop (`resolveHop`, then `resolveHopReference`). Undefined when the hop does not
 * resolve or its reference is ambiguous; `walkViaPath` is what reports those. The Cube exporter
 * reads it for the reference's full `@fields` list, where a view join reads the first.
 */
export function hopReferenceIdentity(holder: MetaObject, hopName: string, root: MetaRoot): MetaReferenceIdentity | undefined {
  const resolved = resolveHop(holder, hopName, root);
  if (!resolved) return undefined;
  const target = resolved.target;
  if (!target) return undefined;
  const ref = resolveHopReference(holder, resolved.hop, hopName, target, resolved.reverse);
  if (Array.isArray(ref)) return ref.length === 1 ? ref[0]!.referenceIdentity : undefined;
  return ref.referenceIdentity;
}

function viewName(projection: MetaObject, ctx: ExtractContext): string {
  // The read-only source carries the physical view name. FR-016: physicalName
  // implements the four-step rule (kind-matching alias → legacy @table →
  // source.name → entity-name fallback), so `viewSource.physicalName` below
  // correctly resolves @view / @materializedView / legacy @table for projection
  // sources.
  // ADR-0039: own — projection source classification (mirrors C# projection
  // OwnSources / IsReadOnlyProjection): the view name comes from the object's
  // OWN read-only source, not one inherited via extends. `ERR_PROJECTION_
  // INHERITED_SOURCE` (subtype-rules.ts) already refuses a concrete projection
  // that would otherwise inherit a source, so own-only never drops a legally
  // reachable source here.
  //
  // This function serves TWO shapes — a plain projection, and a write-through
  // ENTITY's replica view (extractViewSpec's `writeThrough` branch, #213/#214;
  // the parameter name is historical) — which need DIFFERENT selection rules,
  // hence "prefer role:primary, else the first read-only source" rather than
  // "require role:primary":
  //   - A plain projection: EVERY own source must be read-only-kind
  //     (ERR_PROJECTION_SOURCE_WRITABLE), so if it has any sources at all,
  //     exactly one is role:"primary" (ERR_SOURCE_NO_PRIMARY /
  //     ERR_SOURCE_MULTIPLE_PRIMARY) and that one IS read-only — the primary
  //     branch always fires when there is a source.
  //   - A write-through entity: its role:"primary" source is the WRITABLE
  //     table (never read-only), so the primary branch never fires; its
  //     read-only companion (the replica view) is intentionally NOT primary.
  //     The fallback (first read-only own source) is what names it.
  //
  // Selecting the role:"primary" read-only source PREFERENTIALLY over
  // declaration order (rather than "first read-only source in file order") is
  // what makes this agree with `resolveTableName()` (the resolver every §A6
  // site defers to via `resolveObjectNames`): a plain projection declaring a
  // role:"replica" source before its role:"primary" one would otherwise bind a
  // different physical view depending on whether the names generator happened
  // to be active in the run.
  const readOnlySources = projection.ownChildren().filter(isReadOnlySource);
  const viewSource =
    readOnlySources.find((c) => c.role === SOURCE_ROLE_PRIMARY) ?? readOnlySources[0];
  const explicit = viewSource?.physicalName;
  // physicalName always returns a string; empty string means the source had
  // neither alias nor a name and the owning entity name was empty (impossible
  // for a real projection). Fall through to the helper anyway for safety.
  //
  // This fallback fires only when the object has NO own read-only source at
  // all. It differs from `resolveTableName()`'s own no-source fallback
  // (`v_<snake(name)>` here vs `pluralize(toSnakeCase(name))` there), but that
  // difference is UNOBSERVABLE: whenever a sourceless object reaches this
  // fallback, `resolveObjectNames()` also finds no primary source and returns
  // `undefined` before ever calling `resolveTableName()` — so no §A6 site has
  // a names constant to reference either way, and both the ON and OFF arms
  // land on THIS function's literal on the identical no-source condition. A
  // sourceless projection also fails `isProjection()` itself
  // (projection-detector.ts requires a read-only-kind source), so codegen's
  // dispatch never reaches `renderProjectionDecl`/this function for it in the
  // first place — doubly unreachable.
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
 * The `@schema` of the SAME source node {@link projectionViewName} names, or undefined.
 *
 * It re-uses that function's selection rule ("prefer role:primary read-only, else the first
 * read-only own source") deliberately, rather than asking the object for its schema: for a
 * write-through ENTITY the object's primary source is the WRITABLE table, so
 * `resolveTableSchema` would hand back the table's schema and qualify the replica view with
 * it. A view and the table it replicates need not live in the same schema, and a name paired
 * with someone else's schema is worse than no schema at all — it is confidently wrong.
 */
export function projectionViewSchema(projection: MetaObject): string | undefined {
  const schema = projectionViewSource(projection)?.attr(SOURCE_ATTR_SCHEMA);
  return typeof schema === "string" && schema !== "" ? schema : undefined;
}

/**
 * The source node {@link projectionViewName} names — the ONE selection, so the name, the
 * schema and the role cannot be picked by three functions that agree until they do not.
 *
 * Hoisted out of `projectionViewSchema`, which used to be the only place the rule was
 * written twice-removed from `viewName`. The third caller is what forced it: the names
 * artifact keys its sources by ROLE, so a consumer reaching for a write-through entity's
 * replica view has to know which role that view plays, and guessing `"replica"` would be
 * exactly the second derivation this file exists to avoid.
 */
export function projectionViewSource(projection: MetaObject): MetaSource | undefined {
  const readOnlySources = projection.ownChildren().filter(isReadOnlySource);
  return readOnlySources.find((c) => c.role === SOURCE_ROLE_PRIMARY) ?? readOnlySources[0];
}

/** The ROLE of that source — the key its entry has in `<Entity>Names.sources`. */
export function projectionViewRole(projection: MetaObject): string | undefined {
  return projectionViewSource(projection)?.role;
}

/**
 * FR-024 (ADR-0029): the entity NAMED by a node's dotted extends ref — the
 * owner part of `<owner>.<child>...` resolved as an object. Mirrors the
 * loader's `_refNamedOwner`: the ref names the anchor, never the physical
 * declaring ancestor of an inherited child.
 */
export function refNamedOwner(node: MetaData, root: MetaRoot): MetaObject | undefined {
  const ref = (node as { superRef?: string }).superRef;
  if (ref === undefined) return undefined;
  // The loader has rewritten `extends` to its canonical spelling (ADR-0059 R5), so the
  // owner is looked up exactly, with no referrer and no short-name match (R7).
  const { owner, tail } = splitChildTail(ref);
  if (tail === "") return undefined;
  const found = lookupCanonical(root, owner, { ownerType: TYPE_OBJECT });
  return isMetaObject(found) ? found : undefined;
}

/** Effective package of an object, taken from its resolution key ("<pkg>::<Name>"). */
export function packageOf(obj: MetaData): string {
  const key = obj.resolutionKey();
  const i = key.lastIndexOf("::");
  return i >= 0 ? key.slice(0, i) : "";
}

/**
 * Resolve an object reference (bare or fully-qualified) to its MetaObject, package-aware
 * per the ADR-0042 contract (`resolveObjectRef`): an FQN binds exactly, a bare ref binds
 * the referrer's package then a root-level object. Replaces the load-order-dependent
 * `root.findObject(stripPackage(ref))` the view-spec used to do, which discarded the
 * package qualifier and let a same-bare-named entity in another package win (#244).
 */
function resolveEntityRef(root: MetaRoot, ref: string, referrerPkg: string): MetaObject | undefined {
  const node = resolveObjectRef(root, ref, referrerPkg).node;
  return isMetaObject(node) ? node : undefined;
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
  // A projection extending another projection and anchoring nothing of its own has its super's
  // base entity (mirrors the loader's _deriveBaseEntity).
  const sup = projection.superResolved;
  if (targets.size === 0 && sup !== undefined && isMetaObject(sup) && sup.subType === OBJECT_SUBTYPE_PROJECTION) {
    return baseEntityFor(sup, root);
  }
  throw new Error(
    `Projection ${projection.name}: cannot derive the base entity — declare an ` +
      `extends-bound identity (identity.primary { name, extends: "<Entity>.<identity>" }) ` +
      `to anchor the base (FR-024).`,
  );
}

export function sourceColumnNameFor(
  entityField: MetaData,
  ctx: ExtractContext,
): string {
  const col = entityField.attr(FIELD_ATTR_COLUMN);
  if (typeof col === "string" && col !== "") return col;
  return columnNameFromField(entityField.name, ctx.columnNamingStrategy);
}

/**
 * The BASE table's column an extends-bound passthrough field SELECTS.
 *
 * A projection field may RENAME what it exposes
 * (`{ field.string: { name: bookingRef, extends: "Shipment.reference" } }`). The view's
 * OUTPUT alias is the projection field's own; the column it reads from the base table is
 * the extends TARGET's. Deriving both from the projection field emits
 * `SELECT s.booking_ref` against a table whose column is `reference` — SQL that SQLite
 * accepts at CREATE VIEW and only fails at the first SELECT, and that Postgres rejects
 * outright at migrate time.
 *
 * Caller contract: this is for a PLAIN projection only. A read-view HOST (`base ===
 * projection`) reads its own table, so its passthrough source is always the field's own
 * column and there is no rename to resolve — and a host field may legally `extends` a
 * SIBLING field of the same entity for shape reuse, which this would otherwise read as a
 * rename and silently serve the sibling's data under this field's name.
 *
 * Only a DOTTED extends naming the BASE entity redirects the source column:
 *
 *   - `extends: "Shipment.reference"` — binds a base column; the target's column wins.
 *   - `extends: "Code24"` (bare, a package-level abstract) — SHAPE REUSE, not a binding.
 *     `refNamedOwner` returns undefined, so the field's own name stays the source.
 *   - `extends: "Other.foo"` — names an entity that is not the base. The caller emits this
 *     column against `joinTree.baseAlias`, so borrowing another entity's column name would
 *     be a second wrong answer; keep the field's own.
 *
 * The alias is not always the projection's spelling: `sourceColumnNameFor` reads `@column`
 * with the RESOLVING accessor, so a renaming field whose base carries an explicit `@column`
 * inherits it and both sides land on that physical name. The rename then holds on the TS /
 * wire tier only. That is pre-existing and self-consistent — the Drizzle view decl binds
 * the same column — but it is not a promise this function makes.
 */
function baseColumnNameFor(
  field: MetaField,
  base: MetaObject,
  root: MetaRoot,
  ctx: ExtractContext,
): string {
  const target = field.superData;
  if (target === undefined) return sourceColumnNameFor(field, ctx);
  if (refNamedOwner(field, root) !== base) return sourceColumnNameFor(field, ctx);
  return sourceColumnNameFor(target, ctx);
}

/**
 * Physical column for a join FK/PK field — resolves @column + naming strategy the
 * same way passthrough columns do (EFFECTIVE fields, so inherited PKs resolve).
 * The JOIN ON clause must use the real column, not a hardcoded snake_case guess,
 * or it breaks under the `literal`/`kebab-case` strategies.
 */
export function joinColumnFor(entity: MetaObject, fieldName: string, ctx: ExtractContext): string {
  const f = entity.fields().find((x) => x.name === fieldName);
  if (f) return sourceColumnNameFor(f, ctx);
  // A reference may name a member of a flattened value object (`address.countryId`): its
  // column is on the entity's own table, under the embedding's prefix.
  return resolveFieldPathColumn(entity, fieldName, ctx.columnNamingStrategy)
    ?? columnNameFromField(fieldName, ctx.columnNamingStrategy);
}

/** The physical column of an entity's primary-key field — the LEFT-JOIN phantom guard
 *  (#195) tests `<joined>.<pk> IS NOT NULL`, and it is origin.first's tie-breaker. */
function primaryKeyColumn(entity: MetaObject, ctx: ExtractContext): string | undefined {
  // ADR-0039: resolving — a projection base may inherit its primary identity via extends.
  const pkField = entity.primaryIdentity()?.fields[0];
  return pkField ? joinColumnFor(entity, pkField, ctx) : undefined;
}

/**
 * Walk a `@via` dotted path to its terminal (related) entity. any/all carry no
 * `@of` to name the aggregated entity, so it is derived from the last `@via` hop.
 * Returns undefined if any hop fails to resolve (a prior loader error already fired).
 */
function viaTerminalEntity(via: string, root: MetaRoot, referrerPkg: string): MetaObject | undefined {
  const segments = via.split(".");
  const rawEntity = segments[0];
  if (!rawEntity) return undefined;
  let currentObj = resolveEntityRef(root, rawEntity, referrerPkg);
  if (!currentObj) return undefined;
  for (const relName of segments.slice(1)) {
    const resolved = resolveHop(currentObj, relName, root);
    if (!resolved) return undefined;
    const target = resolved.target;
    if (!target) return undefined;
    currentObj = target;
  }
  return currentObj;
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
  /** A ref naming one of the projection's own fields, resolved to its column expression (and the
   *  field, for a `now` beside it); undefined → a field of the base. */
  lookup?: (name: string) => ResolvedRef | undefined,
  /** The kind a relative instant takes here: that of the field it is compared with. */
  nowTemporal: ReportTemporal = "instant",
): ViewExprNode | undefined {
  if (!isPlainObject(raw)) return undefined;
  const sub = (x: unknown, temporal: ReportTemporal = nowTemporal): ViewExprNode | undefined =>
    resolveExprNode(x, base, baseAlias, ctx, lookup, temporal);
  // The field a `{ field }` operand names, for a `now` compared with it.
  const fieldOf = (x: unknown): MetaField | undefined => {
    if (!isPlainObject(x) || typeof x.field !== "string") return undefined;
    return lookup?.(x.field)?.field ?? base.fields().find((f) => f.name === x.field);
  };

  if ("field" in raw) {
    const name = raw.field;
    if (typeof name !== "string") return undefined;
    const own = lookup?.(name);
    if (own !== undefined) return own.expr;
    const field = base.fields().find((f) => f.name === name);
    if (!field) return undefined;
    return { kind: "col", ref: `${baseAlias}.${sourceColumnNameFor(field, ctx)}` };
  }
  if ("value" in raw) {
    return { kind: "lit", value: raw.value as ViewExprLiteral };
  }
  if (FILTER_RELATIVE_NOW in raw) {
    return {
      kind: "now",
      value: {
        kind: "relativeNow",
        duration: String(raw[FILTER_RELATIVE_NOW]),
        temporal: nowTemporal,
        ...(FILTER_RELATIVE_START_OF in raw ? { startOf: raw[FILTER_RELATIVE_START_OF] as RelativeStartOf } : {}),
      },
    };
  }
  if (EXPR_CASE in raw) {
    const arms = raw[EXPR_CASE];
    if (!Array.isArray(arms)) return undefined;
    const operand = EXPR_CASE_OPERAND in raw ? sub(raw[EXPR_CASE_OPERAND]) : undefined;
    if (EXPR_CASE_OPERAND in raw && operand === undefined) return undefined;
    const whens: { when: ViewExprNode; then: ViewExprNode }[] = [];
    for (const arm of arms) {
      if (!isPlainObject(arm)) return undefined;
      const when = sub(arm[EXPR_CASE_WHEN]);
      const then = sub(arm[EXPR_CASE_THEN]);
      if (when === undefined || then === undefined) return undefined;
      whens.push({ when, then });
    }
    const otherwise = EXPR_CASE_ELSE in raw ? sub(raw[EXPR_CASE_ELSE]) : undefined;
    if (EXPR_CASE_ELSE in raw && otherwise === undefined) return undefined;
    return {
      kind: "case",
      ...(operand !== undefined ? { operand } : {}),
      whens,
      ...(otherwise !== undefined ? { else: otherwise } : {}),
    };
  }
  if ("fn" in raw) {
    if (raw.fn !== EXPR_FN_COALESCE || !Array.isArray(raw.args)) return undefined;
    const args = raw.args.map((a) => sub(a));
    if (args.some((a) => a === undefined)) return undefined;
    return { kind: "coalesce", args: args as ViewExprNode[] };
  }
  if ("op" in raw && typeof raw.op === "string") {
    const op = raw.op;
    if (EXPR_COMPARISON_OPS.has(op)) {
      // A `now` takes the kind of the field it is compared with.
      const lf = fieldOf(raw.left);
      const rf = fieldOf(raw.right);
      const left = sub(raw.left, rf !== undefined ? temporalOfField(rf) : nowTemporal);
      const right = sub(raw.right, lf !== undefined ? temporalOfField(lf) : nowTemporal);
      return left && right ? { kind: "cmp", op, left, right } : undefined;
    }
    if (op === FILTER_OP_IS_NULL || op === EXPR_OP_IS_NOT_NULL) {
      const arg = sub(raw.arg);
      return arg ? { kind: "nullTest", negated: op === EXPR_OP_IS_NOT_NULL, arg } : undefined;
    }
    if (op === EXPR_OP_NOT) {
      const arg = sub(raw.arg);
      return arg ? { kind: "not", arg } : undefined;
    }
    if (op === FILTER_COMPOSE_AND || op === FILTER_COMPOSE_OR) {
      if (!Array.isArray(raw.args)) return undefined;
      const args = raw.args.map((a) => sub(a));
      if (args.some((a) => a === undefined)) return undefined;
      return { kind: "logic", op: op === FILTER_COMPOSE_AND ? "and" : "or", args: args as ViewExprNode[] };
    }
  }
  return undefined;
}

/** A projection field resolved for an expression: its column expression, and the field. */
interface ResolvedRef {
  readonly expr: ViewExprNode;
  readonly field: MetaField;
}

export function shortAliasFor(entityName: string, used: Set<string>): string {
  // Derive from the SHORT name — an entity ref may now be a resolutionKey ("pkg::Name",
  // #244); the alias must stay the first letter of the entity, so existing single-package
  // view SQL is byte-identical (a changed alias would churn `verify --db` fingerprints).
  const short = entityName.includes("::") ? entityName.slice(entityName.lastIndexOf("::") + 2) : entityName;
  const base = (short[0] ?? "x").toLowerCase();
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

export interface PathStep {
  entity: MetaData;
  relationship: string;
  cardinality: "one" | "many";
  /** Physical column names (strategy + @column resolved), ready for the ON clause. */
  fkColumn: string;
  pkColumn: string;
  referenceHolder: "source" | "target";
  /** Always `left`: a generated view join never drops a base row. */
  joinType: "left";
  targetEntity: string;
  /** The target is a TPH level: the discriminator values that scope the join to its rows. */
  tphScope?: TphScope;
}

export type Path = PathStep[];

/**
 * A TPH level's rows on its base's shared table: the discriminator column and the values stored
 * for it (an int-backed discriminator enum stores its integers) - a concrete subtype's own value
 * and those of every concrete subtype beneath it; an abstract intermediate level has only the
 * latter. Undefined for the discriminator base and anything outside a TPH hierarchy.
 */
export function tphScopeOf(entity: MetaObject, ctx: ExtractContext): TphScope | undefined {
  const base = tphDiscriminatorBase(entity);
  if (base === undefined || base === entity) return undefined;
  const root = entity.root();
  const objects = isMetaRoot(root) ? root.objects() : [];
  const descends = (o: MetaObject): boolean => {
    for (let up = o.superResolved; up !== undefined; up = isMetaObject(up) ? up.superResolved : undefined) {
      if (up === entity) return true;
    }
    return false;
  };
  const levels = [entity, ...objects.filter((o) => o !== entity && descends(o))];
  const values: (string | number)[] = [];
  let column: string | undefined;
  for (const level of levels) {
    const pin = tphDiscriminatorPin(level);
    if (pin === undefined) continue;
    const field = level.fields().find((f) => f.name === pin.fieldName);
    if (field === undefined) continue;
    const map = field.subType === FIELD_SUBTYPE_ENUM ? intValueMapOf(field) : undefined;
    column = sourceColumnNameFor(field, ctx);
    values.push(map?.[pin.value] ?? pin.value);
  }
  return column === undefined ? undefined : { column, values };
}

/** A TPH scope as a filter clause over `alias`: one value compares, several are a list. */
function tphScopeClause(scope: TphScope, alias: string): ViewFilterClause {
  const ref = `${alias}.${scope.column}`;
  return scope.values.length === 1
    ? { kind: "cmp", ref, op: "eq", value: scope.values[0] }
    : { kind: "cmp", ref, op: FILTER_OP_IN, value: scope.values };
}

/** `a AND b`, where either may be absent. */
function andClauses(a: ViewFilterClause | undefined, b: ViewFilterClause | undefined): ViewFilterClause | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return { kind: "and", clauses: [a, b] };
}

interface TrieNode {
  children: Map<string, TrieNode>;
  step?: PathStep;
}

/** Walk one dotted `@via` (`Owner.hop[.hop…]`) into join steps. Returns [] when the
 *  head or any hop does not resolve. Throws on an ambiguous hop (#368). A report dimension
 *  joins through this same walk as a projection origin, so hop resolution, the ambiguity
 *  errors and the #209 join type are one implementation. */
export function walkViaPath(via: string, root: MetaRoot, referrerPkg: string, ctx: ExtractContext): Path {
  const segments = via.split(".");
  const rawEntity = segments[0];
  const relSegments = segments.slice(1);
  if (!rawEntity) return [];
  // @via may be package-qualified ("pkg::Entity.rel"). Resolve package-aware and key
  // the joinTree on resolutionKey() (FQN) so a same-bare-named entity in another
  // package can't win — the passthrough @from lookups key on the same FQN (#244).
  let currentObj = resolveEntityRef(root, rawEntity, referrerPkg);
  if (!currentObj) return [];

  const path: Path = [];
  for (const relName of relSegments) {
    // FR-024: a hop may name a relationship OR a reference-only FK
    // (identity.reference — a to-one forward-FK edge). ADR-0039: resolving —
    // a traversed relationship/reference may inherit its target via extends.
    const resolved = resolveHop(currentObj, relName, root);
    if (!resolved) break;
    const { hop, target, cardinality, reverse } = resolved;
    if (!target) break;

    // #368: two identity.reference declarations onto the same target are legal
    // (e.g. Match.homeTeamRef/awayTeamRef -> Team) — resolveHopReference prefers
    // the SPECIFIC reference/relationship the hop already named over re-deriving
    // one from the target alone, so an explicit `@via: "Match.homeTeamRef"` (or a
    // relationship disambiguated by @sourceRefField/name-pairing) resolves cleanly.
    // Only a relationship hop that even the ladder cannot choose reaches the throw.
    const resolvedRef = resolveHopReference(currentObj as MetaObject, hop, relName, target, reverse);
    let ref: ReferenceLookup | undefined;
    if (Array.isArray(resolvedRef)) {
      if (resolvedRef.length > 1) {
        // #368 round 2: @sourceRefField cannot fix this, but WHY differs by shape, and
        // asserting the wrong reason for a given shape is itself a bug (fix round 1 of
        // this cleanup caught exactly that). resolveRelationshipReference's ladder reads
        // ONLY the hop's own entity's candidates (referenceCandidatesFor(currentObj, ...));
        // it never even looks at `target`'s references. So:
        //  - If `currentObj` itself holds one of the ambiguous candidates, resolution
        //    already tried @sourceRefField/name-pairing against it and failed — and that
        //    is only reachable at all when @cardinality isn't "one": a @cardinality "one"
        //    relationship with 2+ own-side candidates is rejected at LOAD by rule (e)
        //    (validateOneSideReferenceResolution) using this exact same ladder, so if we
        //    got this far with an own-side candidate, @cardinality is provably not "one",
        //    and @sourceRefField is provably illegal here (rule (d)).
        //  - If NONE of the candidates are `currentObj`'s own, @sourceRefField could not
        //    have mattered regardless of @cardinality — it only ever consults the hop's
        //    OWN identity.reference children, and it has none targeting `target`. This is
        //    rule (e)'s zero-candidate gap (validation-passes.ts:2226, `<= 1` skips 0 too):
        //    a @cardinality "one" relationship can reach here with the FK entirely on the
        //    far side, so @cardinality itself must NOT be asserted in this branch.
        const holderName = (currentObj as MetaObject).name;
        const holderOwnsACandidate = resolvedRef.some((r) => r.holder.name === holderName);
        const whySourceRefFieldCannotHelp = holderOwnsACandidate
          ? `it only disambiguates a @cardinality "${CARDINALITY_ONE}" relationship, and this ` +
            `relationship's @cardinality is not "${CARDINALITY_ONE}" (declaring @sourceRefField on it ` +
            `is itself a load error)`
          : `it only consults "${holderName}"'s own identity.reference children, and "${holderName}" ` +
            `declares none targeting "${target.name}" -- every candidate above belongs to the other side ` +
            `of this join`;
        throw new Error(
          `projection join hop "${relName}" from "${holderName}" to "${target.name}" is ambiguous: ` +
            `${resolvedRef.map((r) => r.referenceIdentity.name).join(", ")}. ` +
            `@sourceRefField cannot resolve this: ${whySourceRefFieldCannotHelp}. There is no attribute ` +
            `that disambiguates a hop like this -- remove the extra identity.reference between these two ` +
            `entities, or restructure the model so only one remains.`,
        );
      }
      ref = resolvedRef[0];
    } else {
      ref = resolvedRef;
    }
    if (!ref) break;

    const fkField = ref.referenceIdentity.fields[0];
    if (!fkField) break;

    const resolvedPkField = ref.referenceIdentity.resolvedTargetPkField(root) ?? "id";

    // A reverse hop's reference is always on the far side, even on a self-reference.
    const referenceHolder: "source" | "target" =
      !reverse && ref.holder.name === currentObj.name ? "source" : "target";

    // FK lives on the holder; PK on the entity it references. Resolve both to
    // physical columns now so the ON clause is naming-strategy correct.
    const fkHolder = referenceHolder === "source" ? currentObj : target;
    const pkHolder = referenceHolder === "source" ? target : currentObj;

    // Every generated view join is LEFT OUTER, so a join never drops a base row (an INNER join over a
    // required key would drop one whose reference names no row: an unenforced reference, or a TPH
    // subtype target). A view that must require the related row says so in its @filter, e.g.
    // `{ "<hop>.id": { isNull: false } }`. A report dimension's `required` reads the model.
    const joinType = "left" as const;

    path.push({
      entity: currentObj,
      relationship: relName,
      cardinality,
      fkColumn: joinColumnFor(fkHolder, fkField, ctx),
      pkColumn: joinColumnFor(pkHolder, resolvedPkField, ctx),
      referenceHolder,
      joinType,
      targetEntity: target.resolutionKey(),
      ...(tphScopeOf(target, ctx) !== undefined ? { tphScope: tphScopeOf(target, ctx)! } : {}),
    });
    currentObj = target;
  }
  return path;
}

/** Prefix-dedupe paths into JoinNodes, assigning aliases. */
export function pathsToJoins(paths: readonly Path[], usedAliases: Set<string>): JoinNode[] {
  // Dedupe by prefix: paths sharing a prefix collapse into one join branch.
  const trieRoot: TrieNode = { children: new Map() };
  for (const path of paths) {
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
      ...(step.tphScope !== undefined ? { tphScope: step.tphScope } : {}),
      children: Array.from(node.children.values()).map(toJoinNode),
    };
  }

  return Array.from(trieRoot.children.values()).map(toJoinNode);
}

function buildJoinTree(
  projection: MetaObject,
  base: MetaObject,
  root: MetaRoot,
  usedAliases: Set<string>,
  baseAlias: string,
  ctx: ExtractContext,
  extraPaths: readonly Path[] = [],
): JoinTree {
  // The to-one paths a view @filter walks join like any origin's @via.
  const allPaths: Path[] = [...extraPaths];
  // Referrer package for resolving a bare @via head: the origins are authored on the
  // projection, so bare refs bind package-locally to it (FQN refs ignore this).
  const projPkg = packageOf(projection);

  // ADR-0039: own — a projection's DECLARED field set IS the exposure (FR-024/
  // ADR-0028, inclusive + fail-closed); iterate the projection's own fields and
  // each field's own origin. origin.* NEVER inherits (ADR-0029), so origin reads
  // below are own by policy (category 4).
  // The EFFECTIVE fields: a projection extending another projection inherits its fields and
  // their origins (base first), so its view joins what they need.
  for (const field of projection.fields()) {
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

      const path = walkViaPath(viaAttr, root, projPkg, ctx);
      if (path.length > 0) allPaths.push(path);
    }
  }

  return {
    baseEntity: base.resolutionKey(),
    baseAlias,
    joins: pathsToJoins(allPaths, usedAliases),
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

/**
 * The alias of the join a walked `@via` path ends on: follow its hops down the join tree by
 * relationship name (pathsToJoins collapsed every path into this trie, so the walk is exact).
 * Undefined when the path is empty or does not end on `targetEntity` — the caller then refuses.
 */
function aliasForVia(joinTree: JoinTree, path: Path, targetEntity: string): string | undefined {
  if (path.length === 0) return joinTree.baseEntity === targetEntity ? joinTree.baseAlias : undefined;
  let nodes: readonly JoinNode[] = joinTree.joins;
  let node: JoinNode | undefined;
  for (const step of path) {
    node = nodes.find((n) => n.relationship === step.relationship);
    if (node === undefined) return undefined;
    nodes = node.children;
  }
  return node !== undefined && node.targetEntity === targetEntity ? node.alias : undefined;
}

/**
 * The loaders accept this field's origin, but the view lowering cannot express it. Refuse it
 * by name: dropping the column would leave a view without a column the generated type declares.
 */
function cannotLower(projection: MetaObject, field: MetaData, why: string): never {
  throw new Error(
    `Projection ${projection.name}: field "${field.name}" cannot be lowered into the view: ${why}.`,
  );
}

/** Refuse by name: `fail` names the field (and projection) the lowering was building. */
type Refuse = (why: string) => never;

/** An origin's `@segment` and `@filter`, resolved for this field, or refused naming the field it is on. */
function originFilterFor(
  fail: Refuse,
  origin: MetaData,
  filterAttr: unknown,
  entity: MetaObject,
  alias: string,
  ctx: ExtractContext,
  outer: OuterRow,
): ViewFilterClause | undefined {
  try {
    return originScope(origin, filterAttr, entity, alias, ctx, outer);
  } catch (e) {
    return fail((e as Error).message.replace(/\.$/, ""));
  }
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
  // Referrer package for resolving bare @from/@of/@via entity refs (FQN refs ignore it).
  const projPkg = packageOf(projection);

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
  // A read-view HOST reads its OWN table (base === projection), so every passthrough
  // sources from the field's own column; a plain projection reads the base's, which an
  // extends-bound field may rename. The flag decides both the field set and the source.
  const isReadViewHost = base === projection;
  const declaredFields: MetaField[] = isReadViewHost
    ? base.fields()
    : projection.fields();
  const pendingComputed = new Map<string, { index: number; origin: MetaData; field: MetaField }>();
  for (const field of declaredFields) {
    const origin = field.ownChildren().find((c) => c.type === TYPE_ORIGIN);
    const dbCol = sourceColumnNameFor(field, ctx);

    if (!origin) {
      // A field bound to a DERIVED base field has no base column: its derivation is inlined on the base row.
      const bound = isReadViewHost ? undefined : field.superData;
      if (bound !== undefined && isMetaField(bound) && isDerivedField(bound) && refNamedOwner(field, root) === base) {
        const expr = inlineEntityDerived(bound, base, joinTree.baseAlias, root, usedAliases, ctx, `Projection ${projection.name}: "${field.name}"`);
        columns.push({ kind: "computed", fieldName: field.name, dbColAlias: dbCol, expr });
        continue;
      }
      // Declared on projection but no origin — passthrough from base table. The alias is
      // this field's own column; the SOURCE is the extends target's, which differs
      // whenever the projection renames the base field.
      columns.push({
        kind: "passthrough",
        fieldName: field.name,
        dbColAlias: dbCol,
        sourceAlias: joinTree.baseAlias,
        sourceColumn: isReadViewHost ? dbCol : baseColumnNameFor(field, base, root, ctx),
      });
      continue;
    }

    const fail: Refuse = (why) => cannotLower(projection, field, why);
    const outer: OuterRow = { entity: base, alias: joinTree.baseAlias };

    if (origin.subType === ORIGIN_SUBTYPE_PASSTHROUGH) {
      // ADR-0039: own (category 4) — origin.* never inherits (ADR-0029).
      const from = origin.ownAttr(ORIGIN_PASSTHROUGH_ATTR_FROM) as string;
      const dotIdx = from.indexOf(".");
      if (dotIdx < 1) cannotLower(projection, field, 'its @of/@from is not "Entity.field"');
      // @from may be package-qualified ("pkg::Entity.field"). Resolve package-aware and
      // key the alias lookup on the SAME resolutionKey() the joinTree stored (#244).
      const fieldName = from.slice(dotIdx + 1);
      const targetEntity = resolveEntityRef(root, from.slice(0, dotIdx), projPkg);
      if (!targetEntity) cannotLower(projection, field, "its @of/@from names no entity");
      // The alias of the join this origin's own @via walked: two references onto one target
      // join it twice, and the entity alone cannot say which join a field reads.
      // ADR-0039: own (category 4) — origin.* never inherits (ADR-0029).
      const via = origin.ownAttr(ORIGIN_PASSTHROUGH_ATTR_VIA) as string | undefined;
      const sourceAlias = via !== undefined
        ? aliasForVia(joinTree, walkViaPath(via, root, projPkg, ctx), targetEntity.resolutionKey())
        : findAliasInTree(joinTree, targetEntity.resolutionKey());
      if (sourceAlias === undefined) cannotLower(projection, field, "the entity it reads is not joined into the view");
      // EFFECTIVE fields — the source column may be inherited via `extends`
      // (e.g. created_at/updated_at/created_by from an audited base), which
      // ownChildren() would miss. A member of a flattened value object (`address.city`) is a
      // column of the entity's own table.
      const targetField = targetEntity.fields().find((f) => f.name === fieldName);
      const sourceColumn = targetField !== undefined
        ? sourceColumnNameFor(targetField, ctx)
        : resolveFieldPathColumn(targetEntity, fieldName, ctx.columnNamingStrategy);
      if (sourceColumn === undefined) cannotLower(projection, field, "its @of/@from names no field of that entity");
      // A derived field of the entity has no column on its table; its origin is inlined where reached.
      if (targetField !== undefined && isDerivedField(targetField)) {
        const expr = inlineEntityDerived(targetField, targetEntity, sourceAlias, root, usedAliases, ctx, `Projection ${projection.name}: "${field.name}" @from`);
        columns.push({ kind: "computed", fieldName: field.name, dbColAlias: dbCol, expr });
        continue;
      }
      columns.push({
        kind: "passthrough",
        fieldName: field.name,
        dbColAlias: dbCol,
        sourceAlias,
        sourceColumn,
        // @convert acknowledges the declared type differs from the source's; the view yields the declared one.
        // ADR-0039: own — origin.* never inherits (ADR-0029).
        ...(origin.ownAttr(ORIGIN_PASSTHROUGH_ATTR_CONVERT) === true ? { castTo: fieldSqlType(field) } : {}),
      });
    } else if (origin.subType === ORIGIN_SUBTYPE_AGGREGATE) {
      // ADR-0039: own (category 4) — origin.* never inherits (ADR-0029).
      const agg = origin.ownAttr(ORIGIN_AGGREGATE_ATTR_AGG) as string | undefined;
      if (!agg) cannotLower(projection, field, "it declares no @agg");
      const filterAttr = origin.ownAttr(ORIGIN_AGGREGATE_ATTR_FILTER);

      if (agg === AGG_ANY || agg === AGG_ALL) {
        // #195 predicate quantifier — no @of; the related entity is @via's terminal
        // hop, and @filter is the (required) quantified predicate.
        const via = origin.ownAttr(ORIGIN_AGGREGATE_ATTR_VIA) as string | undefined;
        if (!via) cannotLower(projection, field, "it declares no @via");
        const relatedEntity = viaTerminalEntity(via, root, projPkg);
        if (!relatedEntity) cannotLower(projection, field, "its @via does not resolve");
        const sourceAlias = aliasForVia(joinTree, walkViaPath(via, root, projPkg, ctx), relatedEntity.resolutionKey());
        if (sourceAlias === undefined) cannotLower(projection, field, "the entity it reads is not joined into the view");
        const joinedPk = primaryKeyColumn(relatedEntity, ctx);
        if (joinedPk === undefined) cannotLower(projection, field, "the related entity has no primary key");
        const pred = originFilterFor(fail, origin, filterAttr, relatedEntity, sourceAlias, ctx, outer);
        if (pred === undefined) cannotLower(projection, field, "its @filter does not resolve");
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

      // #335 — @of ABSENT on collect is a WHOLE-OBJECT rollup. This arm sits ABOVE
      // the `if (!of_) continue;` guard on purpose: that guard used to swallow this
      // shape, so the metadata LOADED and the column was silently dropped from the
      // CREATE VIEW while the generated type still declared the field.
      // The related entity comes from @via's terminal hop, not from @of — exactly as
      // the any/all arm above resolves it.
      const wholeObjectCollect =
        agg === AGG_COLLECT && origin.ownAttr(ORIGIN_AGGREGATE_ATTR_OF) === undefined;
      if (wholeObjectCollect) {
        // Every `continue` below is a loader-guaranteed impossibility (the load fails
        // with ERR_COLLECT_WHOLE_OBJECT / ERR_SUBTYPE_RULE_VIOLATION /
        // ERR_COLLECT_MEMBER_UNRESOLVED before codegen runs); they are defence for a
        // caller that reached codegen without loading, never a silent-drop path.
        const via = origin.ownAttr(ORIGIN_AGGREGATE_ATTR_VIA) as string | undefined;
        if (!via) cannotLower(projection, field, "it declares no @via");
        const relatedEntity = viaTerminalEntity(via, root, projPkg);
        if (!relatedEntity) cannotLower(projection, field, "its @via does not resolve");
        const sourceAlias = aliasForVia(joinTree, walkViaPath(via, root, projPkg, ctx), relatedEntity.resolutionKey());
        if (sourceAlias === undefined) cannotLower(projection, field, "the entity it reads is not joined into the view");
        const joinedPk = primaryKeyColumn(relatedEntity, ctx);
        if (joinedPk === undefined) cannotLower(projection, field, "the related entity has no primary key");
        // ADR-0059 R7 — the VO the loader bound for @objectRef, resolved where it was declared.
        // ADR-0039: resolving — @objectRef may be inherited via extends.
        const vo = refTarget(field, FIELD_ATTR_OBJECT_REF);
        if (!vo) cannotLower(projection, field, "its @objectRef does not resolve");
        // ADR-0039: resolving — a value object may inherit members via extends, and the
        // terminal entity may inherit fields. The VO's member list IS the exposure: a
        // field the terminal has but the VO omits is deliberately not projected (#270).
        const members: { memberName: string; sourceColumn: string }[] = [];
        for (const m of vo.children().filter((c): c is MetaField => c.type === TYPE_FIELD)) {
          const target = relatedEntity.fields().find((f) => f.name === m.name);
          if (target === undefined) cannotLower(projection, field, "a member of its value object is not a field of the related entity");
          members.push({ memberName: m.name, sourceColumn: sourceColumnNameFor(target, ctx) });
        }
        if (members.length === 0) cannotLower(projection, field, "no member of its value object resolves on the related entity");
        columns.push({
          kind: "collectObjectAgg",
          fieldName: field.name,
          dbColAlias: dbCol,
          sourceAlias,
          joinedPkColumn: joinedPk,
          members,
          // @orderBy resolves against the @via TERMINAL entity, not @of — there is no
          // @of entity. Empty ⇒ the emitter's default of related-PK ascending.
          orderBy: resolveOrderByKeys(origin.ownAttr(ORIGIN_ATTR_ORDER_BY), relatedEntity, ctx),
        });
        continue;
      }

      // collect + the scalar reduces (count/sum/avg/min/max) all name @of.
      const of_ = origin.ownAttr(ORIGIN_AGGREGATE_ATTR_OF) as string | undefined;
      if (!of_) cannotLower(projection, field, "it declares no @of");
      const dotIdx = of_.indexOf(".");
      if (dotIdx < 1) cannotLower(projection, field, 'its @of/@from is not "Entity.field"');
      const fieldName = of_.slice(dotIdx + 1);
      const targetEntity = resolveEntityRef(root, of_.slice(0, dotIdx), projPkg);
      if (!targetEntity) cannotLower(projection, field, "its @of/@from names no entity");
      // The join its own @via walked (see the passthrough branch). ADR-0039: own (category 4).
      const aggVia = origin.ownAttr(ORIGIN_AGGREGATE_ATTR_VIA) as string | undefined;
      const sourceAlias = aggVia !== undefined
        ? aliasForVia(joinTree, walkViaPath(aggVia, root, projPkg, ctx), targetEntity.resolutionKey())
        : findAliasInTree(joinTree, targetEntity.resolutionKey());
      if (sourceAlias === undefined) cannotLower(projection, field, "the entity it reads is not joined into the view");
      const targetField = targetEntity.fields().find((f) => f.name === fieldName);
      if (!targetField) cannotLower(projection, field, "its @of/@from names no field of that entity");

      if (agg === AGG_COLLECT) {
        // #195 array rollup — collect @of across the related set. @distinct = set
        // semantics; @orderBy (non-distinct) sets element order, else value-ascending.
        const joinedPk = primaryKeyColumn(targetEntity, ctx);
        if (joinedPk === undefined) cannotLower(projection, field, "the related entity has no primary key");
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
        const filter = originFilterFor(fail, origin, filterAttr, targetEntity, sourceAlias, ctx, outer);
        columns.push({
          kind: "aggregate",
          fieldName: field.name,
          dbColAlias: dbCol,
          agg: agg as AggregateFunction,
          sourceAlias,
          sourceColumn: sourceColumnNameFor(targetField, ctx),
          ...(filter !== undefined ? { filter } : {}),
        });
      } else {
        cannotLower(projection, field, `@agg "${agg}" has no view lowering`);
      }
    } else if (origin.subType === ORIGIN_SUBTYPE_COMPUTED) {
      // #195 row-level computed value (@expr tree, no @via). Its refs may name other projection
      // fields, so it resolves after every column exists (the second pass below), in this place.
      pendingComputed.set(field.name, { index: columns.length, origin, field });
      columns.push({ kind: "computed", fieldName: field.name, dbColAlias: dbCol, expr: { kind: "lit", value: null } });
    } else if (origin.subType === ORIGIN_SUBTYPE_FIRST) {
      // #195 correlated latest-row — argmax-then-project. Resolves to a correlated
      // subquery (NOT a join). ADR-0039: own — origin.* never inherits (ADR-0029).
      const first = buildFirstColumn(field, origin, base, joinTree.baseAlias, root, projPkg, usedAliases, ctx, fail);
      columns.push(first);
    } else {
      cannotLower(projection, field, `origin.${origin.subType} has no view lowering`);
    }
  }

  // Resolve every origin.computed now that the columns it may name exist: a ref to a projection
  // field reads that column (a passthrough's source, an origin.first's subquery, another
  // computed's expression); anything else is a base field. An aggregate is not readable.
  const byName = new Map(columns.map((c) => [c.fieldName, c] as const));
  const fieldByName = new Map(declaredFields.map((f) => [f.name, f] as const));
  const resolving = new Set<string>();
  const resolveComputed = (name: string): ViewExprNode | undefined => {
    const pending = pendingComputed.get(name)!;
    if (resolving.has(name)) {
      throw new Error(`Projection ${projection.name}: origin.computed "${name}" refers to itself through ${[...resolving].join(" -> ")}.`);
    }
    resolving.add(name);
    const lookup = (ref: string): ResolvedRef | undefined => {
      if (ref === name) return undefined; // its own name is the base field's
      const f = fieldByName.get(ref);
      const c = byName.get(ref);
      if (f === undefined || c === undefined) return undefined;
      if (pendingComputed.has(ref)) {
        const expr = resolveComputed(ref);
        return expr === undefined ? undefined : { expr, field: f };
      }
      if (c.kind === "passthrough") return { expr: { kind: "col", ref: `${c.sourceAlias}.${c.sourceColumn}` }, field: f };
      if (c.kind === "computed") return { expr: c.expr, field: f };
      if (c.kind === "first") return { expr: { kind: "first", column: { ...c, outerAlias: joinTree.baseAlias } }, field: f };
      throw new Error(`Projection ${projection.name}: origin.computed "${name}" refers to "${ref}", an aggregate; a computed value cannot read one.`);
    };
    // ADR-0039: own — origin.* never inherits (ADR-0029).
    const expr = resolveExprNode(pending.origin.ownAttr(ORIGIN_COMPUTED_ATTR_EXPR), base, joinTree.baseAlias, ctx, lookup);
    resolving.delete(name);
    pendingComputed.delete(name);
    if (expr === undefined) cannotLower(projection, pending.field, "its @expr uses a node the view lowering does not support yet");
    // A bare NULL in a view is text, so any other declared type needs the cast.
    const declared = fieldSqlType(pending.field);
    const castNull = expr.kind === "lit" && expr.value === null && !(declared.kind === "text" && declared.maxLength === undefined);
    const resolved: SelectColumn = {
      kind: "computed", fieldName: name, dbColAlias: sourceColumnNameFor(pending.field, ctx), expr,
      ...(castNull ? { castTo: declared } : {}),
    };
    columns[pending.index] = resolved;
    byName.set(name, resolved);
    return expr;
  };
  for (const name of [...pendingComputed.keys()]) {
    if (pendingComputed.has(name)) resolveComputed(name); // else resolved through another
  }
  return { columns };
}

/** origin.first's column: the selected related row's @of, correlated to `base`'s row at `baseAlias` (#195). */
function buildFirstColumn(
  field: MetaData,
  origin: MetaData,
  base: MetaObject,
  baseAlias: string,
  root: MetaRoot,
  projPkg: string,
  usedAliases: Set<string>,
  ctx: ExtractContext,
  fail: Refuse,
): FirstColumn {
  const dbCol = sourceColumnNameFor(field, ctx);
  const of_ = origin.ownAttr(ORIGIN_FIRST_ATTR_OF) as string | undefined;
  if (!of_) fail("it declares no @of");
  const dotIdx = of_.indexOf(".");
  if (dotIdx < 1) fail('its @of/@from is not "Entity.field"');
  const ofFieldName = of_.slice(dotIdx + 1);
  const childEntity = resolveEntityRef(root, of_.slice(0, dotIdx), projPkg);
  if (!childEntity) fail("its @of names no entity");
  const ofField = childEntity.fields().find((f) => f.name === ofFieldName);
  if (!ofField) fail("its @of names no field of that entity");
  // The base↔child correlation FK — resolved exactly as buildJoinTree resolves a
  // single hop (the identity.reference is the FK-direction SSOT). Single-hop @via;
  // a multi-hop @via on origin.first is not lowered here (rare, and validated away).
  // #368: two identity.reference declarations onto the same target are legal, so
  // this correlation cannot silently take the first — refuse rather than guess.
  // Unlike buildJoinTree's @via hop (a named relationship/reference this file can
  // resolve via resolveHopReference), origin.first's OWN @via (ORIGIN_FIRST_ATTR_VIA)
  // is never read anywhere in this file — buildJoinTree explicitly skips it
  // (ORIGIN_SUBTYPE_FIRST falls through to `continue` there) and this branch derives
  // childEntity from @of alone, so there is no hop name here to prefer. Fixing that is
  // a separate, larger change (wiring @via/single-hop-unique inference into this
  // branch to match _validateViaPath/_inferViaSingleHop) — out of scope for #368's
  // silent-first-match fix; the message below reflects the real, narrower remedy.
  // A @via of two or more hops is lowered along that path — the first hop correlated to the
  // base, the rest INNER-joined inside the subquery. One hop (or none) keeps the direct
  // correlation below, so its SQL is unchanged.
  const firstVia = origin.ownAttr(ORIGIN_FIRST_ATTR_VIA);
  if (typeof firstVia === "string" && firstVia.split(".").length > 2) {
    return firstAlongPath(field.name, dbCol, firstVia, ofField, childEntity, origin, root, projPkg, usedAliases, ctx, { entity: base, alias: baseAlias });
  }
  const refs = findReferencesBetween(base, childEntity);
  // findReferencesBetween walks BOTH directions ([base,child] then [child,base]),
  // so ">1 entry" is not by itself #368 ambiguity: a mutual 1:1 —
  // Customer.primaryAddressRef -> Address PLUS Address.customerRef -> Customer —
  // returns two entries pointing in OPPOSITE directions. That shape is legal
  // (findReferenceBetween's own contract calls it "rare, but legal", and the
  // referenceHolder: "source" | "target" branch below exists to serve it), and
  // refusing it broke codegen for a model #368 says nothing about. The real
  // ambiguity is two references declared by the SAME holder onto the other side —
  // that is what the first-match below cannot choose between.
  const ambiguousHolder = [base, childEntity].find(
    (holder) => refs.filter((r) => r.holder === holder).length > 1,
  );
  if (ambiguousHolder !== undefined) {
    const ambiguous = refs.filter((r) => r.holder === ambiguousHolder);
    throw new Error(
      `origin.first correlation from "${base.name}" to "${childEntity.name}" is ambiguous: ` +
        `"${ambiguousHolder.name}" declares ${ambiguous.length} identity.reference nodes ` +
        `onto the other side (${ambiguous.map((r) => r.referenceIdentity.name).join(", ")}). ` +
        `origin.first's own @via is not consulted for this correlation — reduce to a ` +
        `single identity.reference between these two entities.`,
    );
  }
  const ref = refs[0];
  if (!ref) fail("no identity.reference correlates the base with the @of entity");
  const fkField = ref.referenceIdentity.fields[0];
  if (!fkField) fail("its correlating reference names no field");
  const pkField = ref.referenceIdentity.resolvedTargetPkField(root) ?? "id";
  const referenceHolder: "source" | "target" =
    ref.holder.name === base.name ? "source" : "target";
  const fkHolder = referenceHolder === "source" ? base : childEntity;
  const pkHolder = referenceHolder === "source" ? childEntity : base;
  const childPk = primaryKeyColumn(childEntity, ctx);
  if (childPk === undefined) fail("the @of entity has no primary key");
  // A FRESH alias — the subquery is an independent correlated scope, never the
  // JOIN-tree alias (reserved against usedAliases so it can never collide).
  const childAlias = shortAliasFor(childEntity.name, usedAliases);
  const orderBy = resolveOrderByKeys(origin.ownAttr(ORIGIN_ATTR_ORDER_BY), childEntity, ctx);
  const filterAttr = origin.ownAttr(ORIGIN_FIRST_ATTR_FILTER);
  const childScope = tphScopeOf(childEntity, ctx);
  const filter = andClauses(
    originFilterFor(fail, origin, filterAttr, childEntity, childAlias, ctx, { entity: base, alias: baseAlias }),
    childScope !== undefined ? tphScopeClause(childScope, childAlias) : undefined,
  );
  return {
    kind: "first",
    // FQN so it lines up with the resolutionKey()-keyed joinTables in build-projection-views (#244).
    fieldName: field.name,
    dbColAlias: dbCol,
    childEntity: childEntity.resolutionKey(),
    childAlias,
    sourceColumn: sourceColumnNameFor(ofField, ctx),
    referenceHolder,
    fkColumn: joinColumnFor(fkHolder, fkField, ctx),
    pkColumn: joinColumnFor(pkHolder, pkField, ctx),
    childPkColumn: childPk,
    orderBy,
    ...(filter !== undefined ? { filter } : {}),
  };

}

/**
 * An `origin.first` whose `@via` has two or more hops. The first hop is the correlation to the
 * base row; every later hop is an INNER JOIN inside the subquery, and the selected row, its
 * ordering, filter and tie-breaker are the last hop's (the `@of` entity). A path that does not
 * walk to the `@of` entity is refused here rather than dropped.
 */
function firstAlongPath(
  fieldName: string,
  dbCol: string,
  via: string,
  ofField: MetaData,
  ofEntity: MetaObject,
  origin: MetaData,
  root: MetaRoot,
  projPkg: string,
  usedAliases: Set<string>,
  ctx: ExtractContext,
  outer: OuterRow,
): FirstColumn {
  const path = walkViaPath(via, root, projPkg, ctx);
  const hops = via.split(".").length - 1;
  const last = path[path.length - 1];
  if (path.length !== hops || last === undefined || last.targetEntity !== ofEntity.resolutionKey()) {
    throw new Error(
      `origin.first @via "${via}" (field "${fieldName}"): the path does not walk to the @of entity ` +
        `"${ofEntity.name}", so the column cannot be lowered.`,
    );
  }
  const childPk = primaryKeyColumn(ofEntity, ctx);
  if (childPk === undefined) {
    throw new Error(`origin.first @via "${via}" (field "${fieldName}"): "${ofEntity.name}" has no primary key column.`);
  }
  const [first, ...rest] = path as [PathStep, ...PathStep[]];
  const childAlias = shortAliasFor(first.targetEntity, usedAliases);
  const innerJoins: FirstInnerJoin[] = rest.map((step) => ({
    entity: step.targetEntity,
    alias: shortAliasFor(step.targetEntity, usedAliases),
    referenceHolder: step.referenceHolder,
    fkColumn: step.fkColumn,
    pkColumn: step.pkColumn,
    ...(step.tphScope !== undefined ? { tphScope: step.tphScope } : {}),
  }));
  const termAlias = innerJoins[innerJoins.length - 1]!.alias;
  const filterAttr = origin.ownAttr(ORIGIN_FIRST_ATTR_FILTER);
  // The later hops carry their TPH scope on their ON clause; the correlated first hop's goes in the WHERE.
  const firstScope = first.tphScope;
  const filter = andClauses(
    originScope(origin, filterAttr, ofEntity, termAlias, ctx, outer),
    firstScope !== undefined ? tphScopeClause(firstScope, childAlias) : undefined,
  );
  return {
    kind: "first",
    fieldName,
    dbColAlias: dbCol,
    childEntity: first.targetEntity,
    childAlias,
    sourceColumn: sourceColumnNameFor(ofField, ctx),
    referenceHolder: first.referenceHolder,
    fkColumn: first.fkColumn,
    pkColumn: first.pkColumn,
    childPkColumn: childPk,
    orderBy: resolveOrderByKeys(origin.ownAttr(ORIGIN_ATTR_ORDER_BY), ofEntity, ctx),
    ...(filter !== undefined ? { filter } : {}),
    innerJoins,
  };
}

/** Every field key of a (desugared) filter, through and/or. */
function filterKeysOf(filter: unknown, out: string[] = []): string[] {
  if (!isPlainObject(filter)) return out;
  for (const [key, val] of Object.entries(filter)) {
    if (key === FILTER_AND || key === FILTER_OR) {
      if (Array.isArray(val)) for (const sub of val) filterKeysOf(sub, out);
    } else out.push(key);
  }
  return out;
}

/** A field with an origin child (origin.first / origin.computed on an entity): derived, with no column of its own. */
function isDerivedField(field: MetaData): boolean {
  // ADR-0039: own — origin.* never inherits (ADR-0029).
  return field.ownChildren().some((c) => c.type === TYPE_ORIGIN);
}

/**
 * A derived field of `entity`, inlined where a projection reaches the entity at `alias`: an
 * origin.computed becomes its expression over that alias, an origin.first its correlated
 * subquery keyed on it. An aggregate (or anything else) has no row-level form and is refused.
 */
export function inlineEntityDerived(
  field: MetaData,
  entity: MetaObject,
  alias: string,
  root: MetaRoot,
  usedAliases: Set<string>,
  ctx: ExtractContext,
  where: string,
): ViewExprNode {
  // ADR-0039: own — origin.* never inherits (ADR-0029).
  const origin = field.ownChildren().find((c) => c.type === TYPE_ORIGIN);
  const refuse: Refuse = (why) => {
    throw new Error(`${where}: "${entity.name}.${field.name}" is derived and cannot be inlined where it is reached: ${why}.`);
  };
  if (origin?.subType === ORIGIN_SUBTYPE_COMPUTED) {
    // ADR-0039: own — origin.* never inherits (ADR-0029).
    const expr = resolveExprNode(origin.ownAttr(ORIGIN_COMPUTED_ATTR_EXPR), entity, alias, ctx);
    if (expr !== undefined) return expr;
    return refuse("its @expr uses a node the view lowering does not support yet");
  }
  if (origin?.subType === ORIGIN_SUBTYPE_FIRST) {
    const first = buildFirstColumn(field, origin, entity, alias, root, packageOf(entity), usedAliases, ctx, refuse);
    return { kind: "first", column: { ...first, outerAlias: alias } };
  }
  return refuse(`origin.${origin?.subType ?? "?"} has no row-level form`);
}

/**
 * The column a view @filter compares for a field read on `alias` (the base, or the end of a
 * to-one path). A derived field has no column there: it is inlined at that alias.
 */
function filterColumnFor(
  key: string,
  field: MetaData,
  entity: MetaObject,
  alias: string,
  root: MetaRoot,
  usedAliases: Set<string>,
  ctx: ExtractContext,
  projectionName: string,
): SelectColumn {
  if (isDerivedField(field)) {
    const expr = inlineEntityDerived(field, entity, alias, root, usedAliases, ctx, `Projection ${projectionName}: view @filter "${key}"`);
    return { kind: "computed", fieldName: key, dbColAlias: key, expr };
  }
  return { kind: "passthrough", fieldName: key, dbColAlias: key, sourceAlias: alias, sourceColumn: sourceColumnNameFor(field, ctx) };
}

/** The inflation-sensitive aggregate kinds: a non-distinct row multiplication corrupts
 *  their value (sum/avg double-count; a non-distinct collect duplicates elements).
 *  count is DISTINCT-guarded; min/max and any/all are inflation-immune. */
function isInflationSensitive(c: SelectColumn): boolean {
  if (c.kind === "aggregate") return c.agg === "sum" || c.agg === "avg";
  if (c.kind === "collectAgg") return !c.distinct;
  // #335 — a whole-object collect is ALWAYS non-distinct (the loader refuses @distinct
  // on this form), so it is unconditionally inflation-sensitive.
  if (c.kind === "collectObjectAgg") return true;
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
  // predicateAgg (bool_or/bool_and), collectAgg (array_agg) and collectObjectAgg
  // (jsonb_agg) are real aggregates and force GROUP BY too; computed/first are
  // scalar-per-row and never grouped.
  const hasAgg = spec.columns.some(
    (c) => c.kind === "aggregate" || c.kind === "predicateAgg"
      || c.kind === "collectAgg" || c.kind === "collectObjectAgg",
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
  // The effective @filter (every level of an extends chain, supers first, ANDed). A write-through
  // entity read-view is never filtered: a filtered replica breaks read-your-writes totality.
  const rawFilter = writeThrough ? undefined : effectiveProjectionFilter(projection);
  // A filter key that is not a field of the projection may be a path of to-one hops from the base
  // then a field of the entity they reach; the view joins along it (sharing an origin's join).
  const ownFieldNames = new Set(projection.fields().map((f) => f.name));
  const filterPaths = new Map<string, { readonly reached: FilterPath; readonly joins: Path }>();
  for (const key of filterKeysOf(rawFilter)) {
    if (ownFieldNames.has(key)) continue;
    const reached = resolveFilterPath(base, key);
    if (reached === undefined || typeof reached === "string") continue;
    const joins = walkViaPath(`${base.resolutionKey()}.${reached.hops.join(".")}`, root, packageOf(projection), ctx);
    if (joins.length > 0) filterPaths.set(key, { reached, joins });
  }
  const joinTree = buildJoinTree(
    projection, base, root, usedAliases, baseAlias, ctx, [...filterPaths.values()].map((p) => p.joins),
  );
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
    if (rawFilter !== undefined) {
      const columnsByField = new Map<string, SelectColumn>(
        selectSpec.columns.map((c) => [c.fieldName, c] as const),
      );
      const intMaps = new Map(intEnumMapsOf(projection));
      const fieldsByKey = new Map<string, MetaData>(projection.fields().map((f) => [f.name, f] as const));
      const reached = (key: string, f: MetaField, entity: MetaObject, alias: string): void => {
        columnsByField.set(key, filterColumnFor(key, f, entity, alias, root, usedAliases, ctx, projection.name));
        fieldsByKey.set(key, f);
        const map = f.subType === FIELD_SUBTYPE_ENUM ? intValueMapOf(f) : undefined;
        if (map !== undefined) intMaps.set(key, map);
      };
      // A base-entity field the view does not output is filtered on its base column; a projection
      // field of the same name wins. Only the keys the filter names are reached.
      const baseFields = new Map(base.fields().map((f) => [f.name, f] as const));
      for (const key of new Set(filterKeysOf(rawFilter))) {
        if (columnsByField.has(key) || filterPaths.has(key)) continue;
        const f = baseFields.get(key);
        if (f !== undefined) reached(key, f, base, joinTree.baseAlias);
      }
      // A path key reads the reached entity's column on the alias its joins gave it.
      for (const [key, { reached: target, joins }] of filterPaths) {
        const alias = aliasForVia(joinTree, joins, target.entity.resolutionKey());
        if (alias === undefined) {
          throw new Error(`Projection ${projection.name}: view @filter path "${key}" did not join.`);
        }
        reached(key, target.field as MetaField, target.entity, alias);
      }
      where = resolveViewFilter(rawFilter, columnsByField, projection.name, intMaps, fieldsByKey);
    }
  }

  // A subtype base reads only its rows of the shared table.
  const baseScope = writeThrough ? undefined : tphScopeOf(base, ctx);
  if (baseScope !== undefined) where = andClauses(where, tphScopeClause(baseScope, joinTree.baseAlias));

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
