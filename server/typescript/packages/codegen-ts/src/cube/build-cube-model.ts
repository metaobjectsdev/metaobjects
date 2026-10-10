// FR-044 Plan 4 — buildCubeModel, the pure stage of the cube-model reference generator: a
// loaded model's reporting vocabulary (dimension.*, measure.*, segment.filter on entities) as
// Cube data-model data (contract Tables A to G), and each served object.report as a rollup and
// a scope segment on its @from cube (Table F, cube-reports.ts). It writes no file; the YAML
// renderer does.
//
// One definition of the SQL. `@of`, `@via`, segments and filters resolve through the functions
// the report view lowering calls (projection/report-resolve.ts, report-sql.ts), so a reference
// the view joins is the reference Cube joins. A join's ON predicate pairs the columns of the
// hop `walkViaPath` resolves, rewritten with `{CUBE}` / `{Target}`, and pairs every column of a
// composite reference (the view joins on the first). Conditions render through the report SQL
// module's own `cond`, with a renderer that escapes for Cube (cube-sql.ts).
//
// An alias cube (Table E) is a standalone cube over its entity's table, never an
// `extends`: Cube's `extends` copies every member and pre-aggregation of the parent, so an alias
// would expose the target's measures again and rebuild its rollups. It holds the primary key,
// the members the dimensions reaching it read, and the joins of the paths that continue through
// it. A cube is emitted when a selected entity's cube reaches it through joins.
//
// Lossless or an error: what Cube cannot hold is a CubeModelError naming the node.

import {
  CARDINALITY_ONE,
  CHILD_REF_SEPARATOR,
  FIELD_SUBTYPE_ENUM,
  FILTER_OP_EQ,
  IDENTITY_SUBTYPE_REFERENCE,
  OBJECT_REPORT_ATTR_FILTER,
  OBJECT_REPORT_ATTR_SEGMENT,
  RELATIONSHIP_ATTR_CARDINALITY,
  RELATIONSHIP_ATTR_OBJECT_REF,
  TYPE_DIMENSION,
  TYPE_IDENTITY,
  TYPE_MEASURE,
  TYPE_RELATIONSHIP,
  TYPE_SEGMENT,
  isMetaObject,
  reportShape,
  reportSpine,
  reportSpineHops,
  resolveObjectRef,
  resolveTableName,
  resolveTableSchema,
  type MetaData,
  type MetaDimension,
  type MetaField,
  type MetaMeasure,
  type MetaObject,
  type MetaReferenceIdentity,
  type MetaRoot,
  type MetaSegment,
  type ReportShape,
} from "@metaobjectsdev/metadata";
import { intValueMapOf } from "../enum-meta.js";
import type { ColumnNamingStrategy } from "../metaobjects-config.js";
import { hasWritableRdbSource, servedReport } from "../source-detect.js";
import { isTphSubtype, tphDiscriminatorBase, tphDiscriminatorPin } from "../templates/zod-validators.js";
import {
  encodeIntEnumFilterValue,
  hopReferenceIdentity,
  joinColumnFor,
  packageOf,
  shortAliasFor,
  sourceColumnNameFor,
  walkViaPath,
  type Path,
  type PathStep,
} from "../projection/extract-view-spec.js";
import { dimensionOfField, ratioOperand, resolveDimensionViaPath } from "../projection/report-resolve.js";
import { andOf, cond, resolveReportFilter, segmentClause } from "../projection/report-sql.js";
import type { ViewFilterClause } from "../projection/view-spec.js";
import {
  CubeModelError,
  ERR_CUBE_AMBIGUOUS_PATH,
  ERR_CUBE_NO_PRIMARY_KEY,
  ERR_CUBE_UNMAPPABLE_DIMENSION,
  ERR_CUBE_UNMAPPABLE_JOIN,
  ERR_CUBE_UNMAPPABLE_REPORT,
} from "./cube-errors.js";
import {
  dimensionColumn,
  docOf,
  grainsOf,
  measureMembers,
  memberKey,
  rawMeasureName,
  segmentSpec,
  type MemberContext,
} from "./cube-members.js";
import type {
  CubeDialect,
  CubeDimensionSpec,
  CubeJoinSpec,
  CubeMeasureSpec,
  CubeModel,
  CubeRollupSpec,
  CubeSegmentSpec,
  CubeSource,
  CubeSpec,
  CubeViewCubeSpec,
  CubeViewIncludeSpec,
  CubeViewSpec,
} from "./cube-model-spec.js";
import { assertCubeNames, MemberNamespace } from "./cube-names.js";
import { coarsestFirst, reportContribution } from "./cube-reports.js";
import { cubeColumn, cubeSqlRenderer, joinedColumn, memberRef, tableRef } from "./cube-sql.js";

export interface CubeModelOptions {
  readonly dialect: CubeDialect;
  readonly columnNamingStrategy: ColumnNamingStrategy;
  /**
   * The entities the model covers: an entity's cube is built only when it matches. The
   * cube-model generator passes its own `filter` (fixed config, so a cube's content never
   * depends on the run), never the run's entity selection. A served report is not matched
   * itself: its rollup and scope segment are members of its @from cube, written whenever that
   * cube is built as the entity's own (Table F).
   */
  readonly matches?: (obj: MetaObject) => boolean;
}

const REPORTING_TYPES: ReadonlySet<string> = new Set([TYPE_DIMENSION, TYPE_MEASURE, TYPE_SEGMENT]);

/** Cube's own syntax for a view's join path: cube names, each a join of the one before (`Program.Week`). */
const JOIN_PATH_SEPARATOR = ".";

/**
 * `entity` declares (or inherits) reporting vocabulary; `joinTarget` is only reached (Table A);
 * `alias` is one hop's own copy of the entity it reaches (Table E). A served `@spine` report adds
 * `facts`, its scoped copy of @from (`<Report>Facts`), and for a spine of more than one hop a
 * `chain` cube for each entity between @from and the spine entity (`<Report>_<hop>`).
 */
type CubeKind = "entity" | "joinTarget" | "alias" | "facts" | "chain";

/**
 * One join a cube holds onto another cube (Table E): a to-one hop, or, from a `@spine` report's
 * spine cube and chain cubes, a hop walked back towards the facts (`one_to_many`).
 */
interface Hop {
  /** The reference or relationship name. */
  readonly hop: string;
  readonly node: MetaData;
  readonly step: PathStep;
  /** The identity.reference the hop crosses: this cube's own, or the far entity's. */
  readonly reference: MetaReferenceIdentity;
  readonly relationship: "many_to_one" | "one_to_one" | "one_to_many";
  /** True when this cube's entity holds the reference's foreign key; false when the joined cube's does. */
  readonly fkOnSelf: boolean;
  /** The joined cube: the target's own, or the alias cube `<Cube>_<hop>`. */
  readonly joined: CubeDraft;
}

/**
 * A served report with `@spine`, as Cube holds it (the zero-rows / measure-defaults build): a view
 * rooted at the spine cube, which joins its facts cube, directly or through chain cubes.
 */
interface SpinePlan {
  readonly report: MetaObject;
  readonly shape: ReportShape;
  /** The @from entity's own cube, whose `@via` dimensions the view reads. */
  readonly from: CubeDraft;
  /** How many hops the spine has: the spine cube is each listed dimension's cube at this depth. */
  readonly depth: number;
  /** The view's last join path: the spine cube, the chain cubes, the facts cube. */
  readonly factsPath: readonly string[];
}

/** Entity short names along a `@via` path, for messages. */
function pathText(from: MetaObject, path: Path): string {
  const short = (key: string): string => (key.includes("::") ? key.slice(key.lastIndexOf("::") + 2) : key);
  return [from.name, ...path.map((s) => short(s.targetEntity))].join(" -> ");
}

interface CubeDraft {
  readonly name: string;
  readonly entity: MetaObject;
  readonly kind: CubeKind;
  /** The `@spine` report a facts or chain cube belongs to. */
  readonly report?: MetaObject;
  readonly namespace: MemberNamespace;
  readonly hops: Hop[];
  readonly keyDims: CubeDimensionSpec[];
  /** Declared dimensions in declaration order; a `@via` one is filled once every cube's joins exist. */
  readonly declaredOrder: MetaDimension[];
  readonly declaredDims: Map<MetaDimension, CubeDimensionSpec>;
  readonly viaPaths: Map<MetaDimension, Path>;
  /** The cubes each `@via` dimension's joins pass through, this cube first. */
  readonly viaCubes: Map<MetaDimension, CubeDraft[]>;
  /** The member each `@via` dimension reads, on the last of its cubes. */
  readonly viaMembers: Map<MetaDimension, string>;
  /** A facts cube's own SELECT (the report's scope in it), in place of the entity's table. */
  sql?: string;
  readonly addedDims: CubeDimensionSpec[];
  readonly measures: CubeMeasureSpec[];
  /** Declared segments, then the served reports' scope segments in report order. */
  readonly segments: CubeSegmentSpec[];
  /** One rollup per served report written into this cube, in report order (Table F); written coarsest first. */
  readonly preAggregations: CubeRollupSpec[];
  /** Field name → the first declared dimension without `@via` over it (Table E reuse). */
  readonly declaredByField: Map<string, string>;
  /** Field name → the member the exporter added over it (a key or reached-column dimension). */
  readonly addedByField: Map<string, string>;
}

export function buildCubeModel(root: MetaRoot, options: CubeModelOptions): CubeModel {
  // CubeDialect admits only these; a caller outside the type system gets a refusal, not SQLite SQL.
  if (options.dialect !== "postgres" && options.dialect !== "mysql") {
    throw new Error(`buildCubeModel: dialect '${String(options.dialect)}' is not a Cube data source this exporter writes (postgres, mysql).`);
  }
  return new CubeModelBuilder(root, options).build();
}

/**
 * Table A: a concrete entity with a table that declares or inherits reporting vocabulary, which
 * is the entity's own cube, named after it. The cube-model generator selects by the same rule.
 */
export function hasReportingVocabulary(obj: MetaObject): boolean {
  // ADR-0039: resolving children(), so a member declared on an abstract base counts.
  return !obj.isAbstract && hasWritableRdbSource(obj) && obj.children().some((c) => REPORTING_TYPES.has(c.type));
}

function hopLabel(node: MetaData): string {
  const kind = node.type === TYPE_IDENTITY ? "identity.reference" : `relationship.${node.subType}`;
  return `${kind} '${memberKey(node)}'`;
}

/** True when `hop` is the join a `@via` step crosses. */
function crosses(hop: Hop, step: PathStep, root: MetaRoot): boolean {
  if (hop.step.targetEntity !== step.targetEntity) return false;
  // A belongs-to step (through a reference, or a relationship backed by one) crosses the
  // reference's join, matched by the reference itself: two composite references onto one
  // entity may share their first column (tenantId), so the step's fkColumn cannot tell them
  // apart. A step whose reference the far entity holds crosses its relationship's join.
  if (step.referenceHolder === "source") {
    return (
      hop.relationship === "many_to_one" &&
      isMetaObject(step.entity) &&
      hop.reference === hopReferenceIdentity(step.entity, step.relationship, root)
    );
  }
  return hop.relationship === "one_to_one" && hop.hop === step.relationship;
}

/** How many routes an ERR_CUBE_AMBIGUOUS_PATH message lists before it says more exist. */
const LISTED_PATHS = 8;

/** Every simple path from `from` to `to` in the cube join graph, up to `limit`. */
function simplePaths(graph: ReadonlyMap<string, readonly string[]>, from: string, to: string, limit: number): string[][] {
  const out: string[][] = [];
  const walk = (node: string, path: string[]): void => {
    if (out.length >= limit) return;
    if (node === to) {
      out.push(path);
      return;
    }
    for (const next of graph.get(node) ?? []) if (!path.includes(next)) walk(next, [...path, next]);
  };
  walk(from, [from]);
  return out;
}

/** Cube name → the cubes its joins reach. An alias cube's edges are its own joins. */
function cubeGraph(cubes: readonly CubeDraft[]): Map<string, string[]> {
  return new Map(cubes.map((c) => [c.name, c.hops.map((h) => h.joined.name)]));
}

class CubeModelBuilder {
  private readonly d: CubeDialect;
  private readonly mc: MemberContext;
  private readonly byKey = new Map<string, MetaObject>();
  /** Keyed by entity resolution key, in model order. */
  private readonly drafts = new Map<string, CubeDraft>();
  /** Alias cubes, in the order their hops were declared. */
  private readonly aliases: CubeDraft[] = [];
  /** The facts and chain cubes of the served `@spine` reports, in report order. */
  private readonly reportCubes: CubeDraft[] = [];

  constructor(
    private readonly root: MetaRoot,
    private readonly options: CubeModelOptions,
  ) {
    this.d = options.dialect;
    this.mc = { root, dialect: options.dialect, extract: { columnNamingStrategy: options.columnNamingStrategy } };
  }

  build(): CubeModel {
    const objects = this.root.objects();
    for (const o of objects) this.byKey.set(o.resolutionKey(), o);

    // Table A: the selected entities, and every entity their `@via` dimensions pass through.
    const selected = new Map<string, Map<MetaDimension, Path>>();
    const reached = new Set<string>();
    for (const o of objects) {
      if (!hasReportingVocabulary(o) || !(this.options.matches?.(o) ?? true)) continue;
      const paths = new Map<MetaDimension, Path>();
      for (const dim of this.declaredDimensions(o)) {
        if (dim.via() === undefined) continue;
        const path = this.viaPath(dim, o);
        paths.set(dim, path);
        for (const step of path) reached.add(step.targetEntity);
      }
      selected.set(o.resolutionKey(), paths);
    }
    for (const o of objects) {
      const key = o.resolutionKey();
      const paths = selected.get(key);
      if (paths !== undefined) this.drafts.set(key, this.draft(o, "entity", paths));
      else if (reached.has(key)) this.drafts.set(key, this.draft(o, "joinTarget", new Map()));
    }

    for (const draft of this.drafts.values()) {
      this.addKeyDimensions(draft);
      if (draft.kind === "entity") this.addDeclaredMembers(draft);
    }
    for (const draft of this.drafts.values()) this.addJoins(draft);
    // Each @via's cubes, which also gives an alias cube the joins of the paths through it.
    for (const draft of this.drafts.values()) {
      for (const [dim, path] of draft.viaPaths) draft.viaCubes.set(dim, this.viaCubes(draft, dim, path));
    }
    // The served @spine reports' facts and chain cubes, and the joins onto them, before any name is
    // checked: they are cubes like any other, and each report's view shares Cube's one namespace.
    const spines: SpinePlan[] = [];
    for (const o of objects) {
      const plan = servedReport(o) ? this.spinePlan(o) : undefined;
      if (plan !== undefined) spines.push(plan);
    }
    const emitted = this.emittedCubes();
    assertCubeNames([
      ...emitted.map((c) => ({ name: c.name, what: this.cubeLabel(c) })),
      ...spines.map((p) => ({ name: p.report.name, what: `the view '${p.report.name}' of report '${p.report.resolutionKey()}'` })),
    ]);
    this.assertJoinKeys(emitted);

    const graph = cubeGraph(emitted);
    for (const draft of this.drafts.values()) {
      for (const [dim, cubes] of draft.viaCubes) draft.declaredDims.set(dim, this.viaDimension(draft, dim, cubes, graph));
    }
    // Table F: in model order, so scope segments are in report order and rollups collect in report
    // order. cubeSpec then writes the rollups coarsest first, so the first rollup Cube can answer a
    // report's query from is the one built for it, not a finer one (cube-reports.ts). A @spine report
    // is a view instead, with no rollup and no scope segment.
    for (const o of objects) if (servedReport(o) && reportSpine(o) === undefined) this.addReport(o);

    return { cubes: emitted.map((c) => this.cubeSpec(c)), views: spines.map((p) => this.viewSpec(p)) };
  }

  /** What a cube was made from, for a name-collision message. */
  private cubeLabel(c: CubeDraft): string {
    switch (c.kind) {
      case "entity":
      case "joinTarget":
        return `entity '${c.entity.resolutionKey()}'`;
      case "alias":
        return `the alias cube '${c.name}' of '${c.entity.resolutionKey()}'`;
      case "facts":
      case "chain":
        return `the ${c.kind} cube '${c.name}' of report '${c.report?.resolutionKey() ?? ""}'`;
    }
  }

  private draft(
    entity: MetaObject,
    kind: CubeKind,
    viaPaths: Map<MetaDimension, Path>,
    name = entity.name,
    report?: MetaObject,
  ): CubeDraft {
    return {
      name,
      entity,
      kind,
      ...(report !== undefined ? { report } : {}),
      namespace: new MemberNamespace(name),
      hops: [],
      keyDims: [],
      declaredOrder: [],
      declaredDims: new Map(),
      viaPaths,
      viaCubes: new Map(),
      viaMembers: new Map(),
      addedDims: [],
      measures: [],
      segments: [],
      preAggregations: [],
      declaredByField: new Map(),
      addedByField: new Map(),
    };
  }

  private declaredDimensions(entity: MetaObject): MetaDimension[] {
    // ADR-0039: resolving children(). The type string identifies the node (no `instanceof`
    // across packages); the cast is type-only.
    return entity.children().filter((c) => c.type === TYPE_DIMENSION) as MetaDimension[];
  }

  /**
   * A `@via` dimension's join path, resolved by the report view's own resolver, then held to
   * what a Cube member reference can read: to-one hops, onto entities with a table, and back
   * onto an entity already on the path only through a self-referencing hop (its alias cube).
   */
  private viaPath(dim: MetaDimension, from: MetaObject): Path {
    const where = `cube '${from.name}': dimension '${memberKey(dim)}'`;
    const via = dim.via() ?? "";
    const path = resolveDimensionViaPath(dim, from, this.root, this.mc.extract, where);
    const onPath = new Set([from.resolutionKey()]);
    for (const step of path) {
      if (step.cardinality !== CARDINALITY_ONE) {
        throw new CubeModelError(
          ERR_CUBE_UNMAPPABLE_DIMENSION,
          `${where} @via '${via}' crosses the to-many hop '${step.relationship}'. A dimension reads one value ` +
            `per row, which Cube reads through to-one joins only. Make every hop of the @via to-one.`,
        );
      }
      const selfHop = step.targetEntity === step.entity.resolutionKey();
      if (onPath.has(step.targetEntity) && !selfHop) {
        throw new CubeModelError(
          ERR_CUBE_UNMAPPABLE_DIMENSION,
          `${where} @via '${via}' comes back to '${step.targetEntity}' at hop '${step.relationship}' ` +
            `(${pathText(from, path)}). Cube reads a member by cube name, and that cube is already on the ` +
            `path, so the dimension would read the wrong row. Remove the dimension, or reach the value without ` +
            `returning to an entity already on the path.`,
        );
      }
      onPath.add(step.targetEntity);
      const target = this.byKey.get(step.targetEntity);
      if (target === undefined || target.isAbstract || !hasWritableRdbSource(target)) {
        throw new CubeModelError(
          ERR_CUBE_UNMAPPABLE_DIMENSION,
          `${where} @via '${via}' reaches '${step.targetEntity}', which has no table (it is abstract or ` +
            `declares no writable source.rdb), so no cube can hold the member the dimension reads. Give ` +
            `'${step.targetEntity}' a source, or remove the dimension.`,
        );
      }
    }
    return path;
  }

  /** Table C, rendered for the node `where` names. */
  private columnOf(field: MetaField, where: string): ReturnType<typeof dimensionColumn> {
    return dimensionColumn(field, where, cubeSqlRenderer(where), this.mc);
  }

  /** Table B: one primary-key dimension per key field, named after the field. */
  private addKeyDimensions(draft: CubeDraft): void {
    // ADR-0039: resolving, so a key declared on an abstract base is found.
    const identity = draft.entity.primaryIdentity();
    if (identity === undefined) return;
    for (const fieldName of identity.fields) {
      const field = draft.entity.fields().find((f) => f.name === fieldName);
      const label = `primary-key dimension '${fieldName}' (identity.primary '${memberKey(identity)}')`;
      const where = `cube '${draft.name}': ${label}`;
      if (field === undefined) throw new Error(`${where} names a field '${draft.entity.name}' does not declare.`);
      draft.namespace.add(fieldName, label);
      const { sql, type } = this.columnOf(field, where);
      draft.keyDims.push({ name: fieldName, sql, type, primaryKey: true });
      // A @via onto a key field reads the key dimension: it is the member named after that field.
      draft.addedByField.set(fieldName, fieldName);
    }
  }

  /** The declared dimensions, measures and segments of a vocabulary cube, in declaration order. */
  private addDeclaredMembers(draft: CubeDraft): void {
    // ADR-0039: resolving children(), so members declared on an abstract base land here.
    for (const child of draft.entity.children()) {
      if (!REPORTING_TYPES.has(child.type)) continue;
      // The type string identifies the node (no `instanceof` across packages); casts are type-only.
      if (child.type === TYPE_DIMENSION && this.mergeIntoKeyDimension(draft, child as MetaDimension)) continue;
      const label = `${child.type} '${memberKey(child)}'`;
      draft.namespace.add(child.name, label);
      const where = `cube '${draft.name}': ${label}`;
      if (child.type === TYPE_DIMENSION) {
        const dim = child as MetaDimension;
        draft.declaredOrder.push(dim);
        if (dim.via() === undefined) draft.declaredDims.set(dim, this.ownDimension(draft, dim, where));
      } else if (child.type === TYPE_MEASURE) {
        const { raw, measure } = measureMembers(draft.entity, child as MetaMeasure, where, this.mc);
        if (raw !== undefined) {
          // A defaulted measure.aggregate: its aggregate is the member the exporter adds, `<m>Raw`.
          draft.namespace.add(raw.name, `the measure '${raw.name}' the exporter adds for the @default of ${label}`);
          draft.measures.push(raw);
        }
        draft.measures.push(measure);
      } else {
        draft.segments.push(segmentSpec(draft.entity, child as MetaSegment, where, this.mc));
      }
    }
  }

  /**
   * A declared dimension without `@via` that is named after one of the entity's key fields and
   * reads that field: Cube gets ONE dimension, the key dimension, made `public: true` and carrying
   * the declared dimension's title, description and grains. Both would have the same name and the
   * same SQL, and the declaration says the key is meant to be queried. True when it merged. A
   * same-named dimension over another field is left to the namespace, which reports the collision.
   */
  private mergeIntoKeyDimension(draft: CubeDraft, dim: MetaDimension): boolean {
    if (dim.via() !== undefined) return false;
    const index = draft.keyDims.findIndex((k) => k.name === dim.name);
    if (index < 0) return false;
    // Without @via the field is read from the cube's own entity, so a name match is that key field.
    if (dimensionOfField(dim, draft.entity, this.root)?.name !== dim.name) return false;
    draft.keyDims[index] = { ...draft.keyDims[index]!, public: true, ...grainsOf(dim), ...docOf(dim) };
    if (!draft.declaredByField.has(dim.name)) draft.declaredByField.set(dim.name, dim.name);
    return true;
  }

  /** A dimension over the owning cube's own column (no `@via`). */
  private ownDimension(draft: CubeDraft, dim: MetaDimension, where: string): CubeDimensionSpec {
    // A dimension without @via is about `from`'s own rows: the field is read from `from`.
    const of = dimensionOfField(dim, draft.entity, this.root);
    if (of === undefined) throw new Error(`${where} @of '${dim.of() ?? ""}' does not resolve.`);
    const { sql, type } = this.columnOf(of, where);
    // An attribute and a time dimension over one field have the same Table C SQL, so either
    // serves a @via that reaches the field.
    if (!draft.declaredByField.has(of.name)) draft.declaredByField.set(of.name, dim.name);
    return { name: dim.name, sql, type, ...grainsOf(dim), ...docOf(dim) };
  }

  /**
   * Table E: each to-one hop this cube holds onto another cube, in declaration order. Two or
   * more hops onto one entity each get an alias cube, never the plain target for one of them,
   * and so does a hop onto the cube's own entity: Cube cannot join a cube to itself.
   */
  private addJoins(draft: CubeDraft): void {
    const entity = draft.entity;
    const self = entity.resolutionKey();
    const candidates: Omit<Hop, "joined" | "fkOnSelf">[] = [];
    // ADR-0039: resolving children(), so an inherited reference or relationship is a join too.
    for (const child of entity.children()) {
      let relationship: Hop["relationship"];
      if (child.type === TYPE_IDENTITY && child.subType === IDENTITY_SUBTYPE_REFERENCE) {
        relationship = "many_to_one";
      } else if (child.type === TYPE_RELATIONSHIP && child.attr(RELATIONSHIP_ATTR_CARDINALITY) === CARDINALITY_ONE) {
        // Resolved first, so a relationship onto an entity that is no cube is never walked.
        const targetRef = child.attr(RELATIONSHIP_ATTR_OBJECT_REF);
        const target = typeof targetRef === "string" ? resolveObjectRef(this.root, targetRef, packageOf(entity)).node : undefined;
        if (!isMetaObject(target) || !this.drafts.has(target.resolutionKey())) continue;
        relationship = "one_to_one";
      } else {
        continue;
      }
      const hop = this.resolveHop(draft, child);
      if (hop === undefined || !this.drafts.has(hop.step.targetEntity)) continue;
      // A to-one relationship whose reference this entity holds is that reference's join.
      if ((relationship === "many_to_one") !== (hop.step.referenceHolder === "source")) continue;
      candidates.push({ hop: child.name, node: child, step: hop.step, reference: hop.reference, relationship });
    }
    const perTarget = new Map<string, number>();
    for (const h of candidates) perTarget.set(h.step.targetEntity, (perTarget.get(h.step.targetEntity) ?? 0) + 1);
    for (const h of candidates) {
      const target = this.drafts.get(h.step.targetEntity)!;
      // Cube allows one join per target cube, and none onto the cube itself.
      const aliased = h.step.targetEntity === self || (perTarget.get(h.step.targetEntity) ?? 0) > 1;
      // many_to_one: this cube holds the foreign key. one_to_one: the far entity holds it.
      const fkOnSelf = h.relationship === "many_to_one";
      draft.hops.push({ ...h, fkOnSelf, joined: aliased ? this.alias(`${draft.name}_${h.hop}`, target.entity) : target });
    }
  }

  /** Table E: an alias cube, standalone over `entity`'s table, holding its primary key. */
  private alias(name: string, entity: MetaObject): CubeDraft {
    const alias = this.draft(entity, "alias", new Map(), name);
    this.addKeyDimensions(alias);
    this.aliases.push(alias);
    return alias;
  }

  /** The cubes a selected entity's cube reaches through joins, itself included: what is written. */
  private emittedCubes(): CubeDraft[] {
    const reached = new Set<CubeDraft>();
    const visit = (c: CubeDraft): void => {
      if (reached.has(c)) return;
      reached.add(c);
      for (const h of c.hops) visit(h.joined);
    };
    for (const d of this.drafts.values()) if (d.kind === "entity") visit(d);
    return [...this.drafts.values(), ...this.aliases, ...this.reportCubes].filter((c) => reached.has(c));
  }

  /**
   * One hop by the view's own walk (`walkViaPath`, so the ON columns are the ones the view joins
   * on) and the identity.reference it crosses. A hop the walk refuses (an ambiguous to-one
   * relationship, #368) is a join Cube cannot be given: refused, naming the hop, with the reason.
   */
  private resolveHop(draft: CubeDraft, node: MetaData): { step: PathStep; reference: MetaReferenceIdentity } | undefined {
    const entity = draft.entity;
    let step: PathStep | undefined;
    let reference: MetaReferenceIdentity | undefined;
    try {
      step = walkViaPath(`${entity.name}${CHILD_REF_SEPARATOR}${node.name}`, this.root, packageOf(entity), this.mc.extract)[0];
      reference = hopReferenceIdentity(entity, node.name, this.root);
    } catch (e) {
      throw new CubeModelError(
        ERR_CUBE_UNMAPPABLE_JOIN,
        `cube '${draft.name}': ${hopLabel(node)} cannot be joined: ${(e as Error).message}`,
      );
    }
    // An unresolvable hop is the loader's to report; it joins nothing.
    return step === undefined || reference === undefined ? undefined : { step, reference };
  }

  /** Cube needs a primary key on both sides of a join. */
  private assertJoinKeys(cubes: readonly CubeDraft[]): void {
    for (const draft of cubes) {
      for (const h of draft.hops) {
        for (const side of [draft.entity, h.joined.entity]) {
          if (side.primaryIdentity() !== undefined) continue;
          throw new CubeModelError(
            ERR_CUBE_NO_PRIMARY_KEY,
            `cube '${draft.name}': the join '${h.joined.name}' (${hopLabel(h.node)}) joins '${side.resolutionKey()}', ` +
              `which declares no identity.primary, and Cube needs a primary key on both sides of a join. ` +
              `Declare an identity.primary on '${side.resolutionKey()}'.`,
          );
        }
      }
    }
  }

  /**
   * Table E: the cubes a `@via` dimension's joins pass through, the owning cube first. Each hop
   * is the join its holder entity's cube declares. When the path reaches that entity through an
   * alias cube, the alias holds the join itself: it is a standalone cube with no joins but these.
   */
  private viaCubes(draft: CubeDraft, dim: MetaDimension, path: Path): CubeDraft[] {
    const where = `cube '${draft.name}': dimension '${memberKey(dim)}'`;
    const cubes: CubeDraft[] = [draft];
    for (const step of path) {
      const holder = this.drafts.get(step.entity.resolutionKey());
      const hop = holder?.hops.find((h) => crosses(h, step, this.root));
      if (hop === undefined) throw new Error(`${where}: no join crosses its @via hop '${step.relationship}'.`);
      // A second self-referencing hop crosses the same alias cube again (Node.fkParent.fkParent
      // lands on Node_fkParent twice), so the member it names would be the first hop's row.
      if (cubes.includes(hop.joined)) {
        throw new CubeModelError(
          ERR_CUBE_UNMAPPABLE_DIMENSION,
          `${where} @via '${dim.via() ?? ""}' passes through one cube twice ` +
            `(${[...cubes, hop.joined].map((c) => c.name).join(" -> ")}), so the member it reads would belong ` +
            `to the earlier hop's row. Remove the dimension, or reach the value through distinct cubes.`,
        );
      }
      const at = cubes[cubes.length - 1]!;
      if (at !== holder && !at.hops.includes(hop)) at.hops.push(hop);
      cubes.push(hop.joined);
    }
    return cubes;
  }

  /** Table E: a `@via` dimension reads a member of the cube its last hop joins. */
  private viaDimension(
    draft: CubeDraft,
    dim: MetaDimension,
    cubes: readonly CubeDraft[],
    graph: ReadonlyMap<string, readonly string[]>,
  ): CubeDimensionSpec {
    const label = `dimension '${memberKey(dim)}'`;
    const where = `cube '${draft.name}': ${label}`;
    const joined = cubes[cubes.length - 1]!;
    // A multi-hop path: Cube follows the joins itself, so exactly one route may reach the cube.
    // An alias cube's routes are its own joins only (it extends nothing).
    if (cubes.length > 2) {
      // One more than is listed, so the message can say when the search stopped short.
      const paths = simplePaths(graph, draft.name, joined.name, LISTED_PATHS + 1);
      if (paths.length > 1) {
        const listed = paths.slice(0, LISTED_PATHS).map((p) => p.join(" -> "));
        const more = paths.length > LISTED_PATHS ? "; and more paths, not listed" : "";
        const two = paths.length === 2;
        throw new CubeModelError(
          ERR_CUBE_AMBIGUOUS_PATH,
          `${where} reads '${joined.name}' through @via '${dim.via() ?? ""}', and the cube graph reaches ` +
            `'${joined.name}' from '${draft.name}' by more than one path ` +
            `(${listed.join("; ")}${more}), so Cube could join it by ${two ? "either" : "any of them"}. Remove ` +
            `the identity.reference that makes the other ${two ? "path" : "paths"}, or read the value through a ` +
            `single hop.`,
        );
      }
    }
    // With @via, the field is read from the entity its @of names.
    const of = dimensionOfField(dim, draft.entity, this.root);
    if (of === undefined) throw new Error(`${where} @of '${dim.of() ?? ""}' does not resolve.`);
    const { type } = this.columnOf(of, where);
    const member = this.reachedMember(joined, of, label);
    draft.viaMembers.set(dim, member);
    return { name: dim.name, sql: memberRef(member, joined.name), type, ...grainsOf(dim), ...docOf(dim) };
  }

  /**
   * The member of `target` a `@via` onto `field` reads: a declared dimension (attribute or time)
   * without `@via` over the field, else the one the exporter already added, else a new
   * `public: false` dimension named after the field. Added on the cube the path ends on: the
   * entity's own, or the alias cube of the last hop, which declares nothing and so always adds.
   */
  private reachedMember(target: CubeDraft, field: MetaField, reader: string): string {
    const existing = target.declaredByField.get(field.name) ?? target.addedByField.get(field.name);
    if (existing !== undefined) return existing;
    const label = `the dimension '${field.name}' the exporter adds for ${reader} to read`;
    target.namespace.add(field.name, label);
    const where = `cube '${target.name}': ${label}`;
    const { sql, type } = this.columnOf(field, where);
    target.addedDims.push({ name: field.name, sql, type, public: false });
    target.addedByField.set(field.name, field.name);
    return field.name;
  }

  /**
   * The cube of a served report's @from entity, when it is emitted as the entity's own (a TPH
   * subtype's cube included: its `sql` applies the discriminator). Undefined when the generator's
   * filter leaves @from out: the report's members belong to a cube this run does not build. A
   * selected @from that cannot be a cube (abstract, or no table) is ERR_CUBE_UNMAPPABLE_REPORT:
   * there is no cube to hold `holds` (the rollup, or a @spine report's facts), and the view
   * lowering refuses the same report.
   */
  private reportCube(report: MetaObject, shape: ReportShape, holds: string): CubeDraft | undefined {
    const from = shape.from;
    const draft = this.drafts.get(from.resolutionKey());
    if (draft?.kind === "entity") return draft;
    if (!(this.options.matches?.(from) ?? true)) return undefined;
    // Selected, and @from declares the measures the report lists, so the only reason it has no
    // cube of its own is Table A's: it is abstract or has no table.
    const fromKey = from.resolutionKey();
    const why = from.isAbstract ? `'${fromKey}' is abstract` : `'${fromKey}' declares no writable source.rdb`;
    throw new CubeModelError(
      ERR_CUBE_UNMAPPABLE_REPORT,
      `report '${report.resolutionKey()}' is served, and its @from '${fromKey}' has no cube to hold its ` +
        `${holds}: ${why}, so it has no table of its own, and no view can be derived from it either. Report ` +
        `@from a concrete entity with a table, or remove the report's view source.`,
    );
  }

  /** Table F: a served report's scope segment and rollup, on the cube of its @from entity. */
  private addReport(report: MetaObject): void {
    const shape = reportShape(report, this.root);
    const draft = this.reportCube(report, shape, "rollup");
    if (draft === undefined) return;
    const key = report.resolutionKey();
    const { scope, rollup } = reportContribution(shape, draft.name, this.mc);
    if (scope !== undefined) {
      draft.namespace.add(scope.name, `the segment '${scope.name}' the exporter adds for the @filter of report '${key}'`);
      draft.segments.push(scope);
    }
    if (rollup !== undefined) {
      // Cube reports a pre-aggregation named like a member as "defined more than once".
      draft.namespace.add(rollup.name, `the rollup '${rollup.name}' of report '${key}'`);
      draft.preAggregations.push(rollup);
    }
  }

  /**
   * A served report with `@spine` (the zero-rows / measure-defaults plan, Table D): the view
   * selects FROM the spine entity S and walks the spine's hops back to @from, one LEFT OUTER JOIN
   * each, with the report's scope on the join that introduces @from. Cube gets the same rows:
   *
   *   - the spine cube is the cube each listed dimension's joins reach after the spine's hops (rule
   *     R9 puts every listed dimension through the spine): S's own cube, or the alias cube of the
   *     last hop;
   *   - `<Report>Facts`, a standalone `public: false` cube over @from's table whose own `sql` holds
   *     the report's @segment and @filter, so they scope the facts inside the join and a spine row
   *     whose facts are all filtered out keeps its row (a Cube segment would be a WHERE);
   *   - for a spine of more than one hop, a standalone `public: false` chain cube `<Report>_<hop>`
   *     for each entity between @from and S, named after the hop that reaches it from @from;
   *   - one `one_to_many` join from the spine cube, then from each chain cube, towards the facts,
   *     on the ON predicate the hop's forward join has.
   *
   * No join is added to @from's own cube or to any cube of an entity between, so the ordinary
   * cubes' ad-hoc answers are unchanged (executed on Cube 1.7.43: `{ Week.weeks, Program.id }`
   * stays rooted at Week). Undefined for a report with no `@spine`, or whose @from the filter
   * leaves out.
   */
  private spinePlan(report: MetaObject): SpinePlan | undefined {
    const shape = reportShape(report, this.root);
    const hops = reportSpineHops(report, shape.from, this.root);
    if (hops === undefined) return undefined;
    const from = this.reportCube(report, shape, "facts");
    if (from === undefined) return undefined;
    const where = `report '${report.resolutionKey()}'`;
    const spine = reportSpine(report) ?? "";

    // The spine cube, and the spine's own steps, from the listed dimensions' resolved paths.
    let spineCube: CubeDraft | undefined;
    let steps: PathStep[] = [];
    for (const f of shape.fields) {
      if (f.role !== "dimension") continue;
      const dim = f.dimension;
      const path = dim === undefined ? undefined : from.viaPaths.get(dim);
      const cubes = dim === undefined ? undefined : from.viaCubes.get(dim);
      // Rule R9, which the loader enforces: a tree built past the loader is refused here, by name.
      if (path === undefined || cubes === undefined || !hops.every((h, i) => path[i]?.relationship === h)) {
        throw new Error(`${where}: dimension '${f.name}' is not reached through @spine '${spine}' (rule R9).`);
      }
      const at = cubes[hops.length]!;
      if (spineCube !== undefined && at !== spineCube) {
        throw new Error(`${where}: the listed dimensions reach @spine '${spine}' through different cubes.`);
      }
      spineCube = at;
      steps = path.slice(0, hops.length);
    }
    // Rule R9: a @spine report lists at least one dimension.
    if (spineCube === undefined) throw new Error(`${where}: declares @spine '${spine}' and lists no dimension (rule R9).`);

    const facts = this.draft(from.entity, "facts", new Map(), `${report.name}Facts`, report);
    facts.sql = this.factsSql(report, from.entity, where);
    this.addKeyDimensions(facts);
    facts.measures.push(...this.factsMeasures(shape, from, where));
    this.reportCubes.push(facts);

    // Walked from the facts back up to the spine: steps[i] leads from entity i to entity i + 1.
    let below = facts;
    const chain: string[] = [];
    for (let i = 0; i < steps.length - 1; i++) {
      const step = steps[i]!;
      const entity = this.byKey.get(step.targetEntity);
      if (entity === undefined) throw new Error(`${where}: @spine '${spine}' reaches '${step.targetEntity}', which is not in the model.`);
      const link = this.draft(entity, "chain", new Map(), `${report.name}_${step.relationship}`, report);
      this.addKeyDimensions(link);
      link.hops.push(this.reverseHop(step, below, where));
      this.reportCubes.push(link);
      chain.unshift(link.name);
      below = link;
    }
    spineCube.hops.push(this.reverseHop(steps[steps.length - 1]!, below, where));
    return { report, shape, from, depth: hops.length, factsPath: [spineCube.name, ...chain, facts.name] };
  }

  /**
   * One spine hop walked back, from the entity it reaches towards the entity that holds it:
   * `one_to_many`, on the ON predicate of the hop's forward join (the join() pairing, with the
   * foreign key on whichever side the hop's reference puts it).
   */
  private reverseHop(step: PathStep, joined: CubeDraft, where: string): Hop {
    const holder = step.entity;
    if (!isMetaObject(holder)) throw new Error(`${where}: spine hop '${step.relationship}' is not held by an entity.`);
    const reference = hopReferenceIdentity(holder, step.relationship, this.root);
    // ADR-0039: resolving children(), so an inherited relationship or reference is found.
    const node = holder.children().find(
      (c) =>
        c.name === step.relationship &&
        (c.type === TYPE_RELATIONSHIP || (c.type === TYPE_IDENTITY && c.subType === IDENTITY_SUBTYPE_REFERENCE)),
    );
    if (reference === undefined || node === undefined) {
      throw new Error(`${where}: spine hop '${step.relationship}' of '${holder.resolutionKey()}' has no identity.reference.`);
    }
    // referenceHolder "source": the holder (the facts side) holds the foreign key; "target": the
    // entity the hop reaches (this side) does.
    return { hop: step.relationship, node, step, reference, relationship: "one_to_many", fkOnSelf: step.referenceHolder === "target", joined };
  }

  /**
   * The facts cube's `sql`: @from's table under the alias the view gives it, scoped by the report's
   * @segment's filter, then its @filter, ANDed as the view's join condition is (for a TPH subtype,
   * the base table, its discriminator first). No WHERE when the report has no scope.
   */
  private factsSql(report: MetaObject, from: MetaObject, where: string): string {
    const renderer = cubeSqlRenderer(where);
    const ctx = this.mc.extract;
    // The view's base alias: the first one its join tree assigns.
    const alias = shortAliasFor(from.name, new Set());
    const tph = isTphSubtype(from);
    const table = tph ? tphDiscriminatorBase(from)! : from;
    const segment = report.attr(OBJECT_REPORT_ATTR_SEGMENT);
    const scope = andOf([
      tph ? this.discriminatorClause(from, `${alias}.`, where) : undefined,
      segmentClause(typeof segment === "string" ? segment : undefined, from, alias, ctx, where),
      resolveReportFilter(report.attr(OBJECT_REPORT_ATTR_FILTER), from, alias, ctx, `${where} @filter`),
    ]);
    const select = `SELECT * FROM ${tableRef(resolveTableName(table), resolveTableSchema(table), this.d, renderer)} ${alias}`;
    return scope === undefined ? select : `${select} WHERE ${cond(scope, this.d, renderer)}`;
  }

  /**
   * The facts cube's measures: @from's own cube's, in its order, narrowed to those the report lists,
   * the operands of a listed ratio and the `<m>Raw` of each defaulted one, so every definition is
   * the ordinary cube's. A measure the report does not list is `public: false`.
   */
  private factsMeasures(shape: ReportShape, from: CubeDraft, where: string): CubeMeasureSpec[] {
    const listed = new Set<string>();
    const needed = new Set<string>();
    const need = (m: MetaMeasure): void => {
      needed.add(m.name);
      // ADR-0039: defaultValue() resolves, as measureMembers reads it.
      if (!m.isRatio() && m.defaultValue() !== undefined) needed.add(rawMeasureName(m.name));
    };
    for (const f of shape.fields) {
      const m = f.measure;
      if (f.role !== "measure" || m === undefined) continue;
      listed.add(m.name);
      need(m);
      if (m.isRatio()) {
        need(ratioOperand(from.entity, m, m.numerator(), where));
        need(ratioOperand(from.entity, m, m.denominator(), where));
      }
    }
    return from.measures
      .filter((m) => needed.has(m.name))
      .map((m) => (listed.has(m.name) || m.public === false ? m : { ...m, public: false }));
  }

  /**
   * A served `@spine` report's Cube view: the spine cube's members each listed dimension reads,
   * under the dimension's name and with its docs and grains (a dimension past the spine from the
   * cube its own joins end on), then the facts cube's listed measures.
   */
  private viewSpec(plan: SpinePlan): CubeViewSpec {
    const groups = new Map<string, CubeViewIncludeSpec[]>();
    const seen = new Set<MetaDimension>();
    const measures: CubeViewIncludeSpec[] = [];
    for (const f of plan.shape.fields) {
      if (f.role === "measure") {
        if (f.measure !== undefined) measures.push({ name: f.measure.name });
        continue;
      }
      const dim = f.dimension;
      // A time dimension at two grains is one member: the query picks each grain.
      if (dim === undefined || seen.has(dim)) continue;
      seen.add(dim);
      const cubes = plan.from.viaCubes.get(dim)!;
      const member = plan.from.viaMembers.get(dim)!;
      const joinPath = cubes.slice(plan.depth).map((c) => c.name).join(JOIN_PATH_SEPARATOR);
      const include: CubeViewIncludeSpec = {
        name: member,
        ...(member === dim.name ? {} : { alias: dim.name }),
        ...docOf(dim),
        ...grainsOf(dim),
      };
      groups.set(joinPath, [...(groups.get(joinPath) ?? []), include]);
    }
    const cubes: CubeViewCubeSpec[] = [...groups].map(([joinPath, includes]) => ({ joinPath, includes }));
    cubes.push({ joinPath: plan.factsPath.join(JOIN_PATH_SEPARATOR), includes: measures });
    return { name: plan.report.name, ...docOf(plan.report), cubes };
  }

  /**
   * A join's ON predicate: the view's (renderJoin), with `{CUBE}` for this cube and `{<join>}`
   * for the other, over EVERY column pair of the reference, ANDed in position order. The key
   * side is the reference's explicit `@references` fields, else the referenced entity's
   * identity.primary.
   */
  private join(draft: CubeDraft, h: Hop): CubeJoinSpec {
    const where = `cube '${draft.name}': join '${h.joined.name}' (${hopLabel(h.node)})`;
    const renderer = cubeSqlRenderer(where);
    const target = h.joined.entity;
    // The side that holds the reference's foreign key: this cube (many_to_one, or a spine hop walked
    // back from the entity that holds it), or the joined cube (one_to_one, or a hop walked back
    // from the entity it references).
    const [fkEntity, keyEntity] = h.fkOnSelf ? [draft.entity, target] : [target, draft.entity];
    const fkFields = h.reference.fields;
    const explicit = h.reference.targetFields;
    // ADR-0039: resolving primaryIdentity(), so a key inherited through extends is found.
    const keyFields = explicit.length > 0 ? explicit : (keyEntity.primaryIdentity()?.fields ?? []);
    if (fkFields.length !== keyFields.length) {
      throw new CubeModelError(
        ERR_CUBE_UNMAPPABLE_JOIN,
        `${where}: identity.reference '${memberKey(h.reference)}' pairs @fields [${fkFields.join(", ")}] of ` +
          `'${fkEntity.resolutionKey()}' with the key [${keyFields.join(", ")}] of '${keyEntity.resolutionKey()}', ` +
          `and the counts differ, so the join cannot be written column for column. Make the reference's @fields ` +
          `match the referenced key one for one.`,
      );
    }
    const pairs = fkFields.map((fk, i) => {
      const fkCol = joinColumnFor(fkEntity, fk, this.mc.extract);
      const keyCol = joinColumnFor(keyEntity, keyFields[i]!, this.mc.extract);
      return h.fkOnSelf
        ? `${cubeColumn(fkCol, this.d, renderer)} = ${joinedColumn(h.joined.name, keyCol, this.d, renderer)}`
        : `${cubeColumn(keyCol, this.d, renderer)} = ${joinedColumn(h.joined.name, fkCol, this.d, renderer)}`;
    });
    return { name: h.joined.name, relationship: h.relationship, sql: pairs.join(" AND ") };
  }

  /**
   * A TPH subtype's discriminator predicate: its pinned value on the discriminator column, written
   * after `prefix` (empty, or a table alias and its dot).
   */
  private discriminatorClause(entity: MetaObject, prefix: string, where: string): ViewFilterClause {
    const pin = tphDiscriminatorPin(entity)!;
    const field = entity.fields().find((f) => f.name === pin.fieldName);
    if (field === undefined) throw new Error(`${where}: discriminator field '${pin.fieldName}' is not a field of '${entity.name}'.`);
    const value =
      field.subType === FIELD_SUBTYPE_ENUM
        ? encodeIntEnumFilterValue(pin.value, FILTER_OP_EQ, intValueMapOf(field), pin.fieldName, where)
        : pin.value;
    return { kind: "cmp", ref: `${prefix}${sourceColumnNameFor(field, this.mc.extract)}`, op: FILTER_OP_EQ, value };
  }

  /**
   * `sql_table`, or for a TPH subtype a `sql` over the base table with its discriminator predicate,
   * or a facts cube's own `sql`.
   */
  private source(draft: CubeDraft): CubeSource {
    if (draft.sql !== undefined) return { sql: draft.sql };
    const entity = draft.entity;
    const where = `cube '${draft.name}'`;
    const renderer = cubeSqlRenderer(where);
    if (!isTphSubtype(entity)) {
      return { sqlTable: tableRef(resolveTableName(entity), resolveTableSchema(entity), this.d, renderer) };
    }
    // A TPH subtype shares its base's table with every other subtype: scope it by the pin.
    const base = tphDiscriminatorBase(entity)!;
    const predicate = cond(this.discriminatorClause(entity, "", where), this.d, renderer);
    return { sql: `SELECT * FROM ${tableRef(resolveTableName(base), resolveTableSchema(base), this.d, renderer)} WHERE ${predicate}` };
  }

  private cubeSpec(draft: CubeDraft): CubeSpec {
    return {
      name: draft.name,
      ...this.source(draft),
      ...(draft.kind === "entity" ? {} : { public: false }),
      ...docOf(draft.entity),
      joins: draft.hops.map((h) => this.join(draft, h)),
      dimensions: [...draft.keyDims, ...draft.declaredOrder.map((dim) => draft.declaredDims.get(dim)!), ...draft.addedDims],
      measures: draft.measures,
      segments: draft.segments,
      preAggregations: coarsestFirst(draft.preAggregations),
    };
  }
}
