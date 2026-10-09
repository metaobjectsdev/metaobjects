// FR-044 Plan 4 — buildCubeModel, the pure stage of the cube-model reference generator: a
// loaded model's reporting vocabulary (dimension.*, measure.*, segment.filter on entities) as
// Cube data-model data (contract Tables A to E and G). It writes no file; the YAML renderer
// does.
//
// One definition of the SQL. `@of`, `@via`, segments and filters resolve exactly as the report
// view lowering resolves them (extract-report-spec.ts): `reportingMemberOwner`,
// `resolveReportingFieldRef`, `reportingViaHops` and `walkViaPath`, so a reference the view
// joins is the reference Cube joins, and a join's ON predicate is the one the view renders,
// rewritten with `{CUBE}` / `{Target}`. Conditions render through the report SQL module's own
// `cond`, with a renderer that escapes for Cube (cube-sql.ts).
//
// Lossless or an error: what Cube cannot hold is a CubeModelError naming the node.

import {
  CARDINALITY_ONE,
  CHILD_REF_SEPARATOR,
  FIELD_SUBTYPE_ENUM,
  FILTER_OP_EQ,
  IDENTITY_SUBTYPE_REFERENCE,
  RELATIONSHIP_ATTR_CARDINALITY,
  RELATIONSHIP_ATTR_OBJECT_REF,
  TYPE_DIMENSION,
  TYPE_IDENTITY,
  TYPE_MEASURE,
  TYPE_RELATIONSHIP,
  TYPE_SEGMENT,
  isMetaObject,
  reportingMemberOwner,
  reportingViaHops,
  resolveObjectRef,
  resolveReportingFieldRef,
  resolveTableName,
  resolveTableSchema,
  type MetaData,
  type MetaDimension,
  type MetaField,
  type MetaMeasure,
  type MetaObject,
  type MetaRoot,
  type MetaSegment,
} from "@metaobjectsdev/metadata";
import { intValueMapOf } from "../enum-meta.js";
import type { ColumnNamingStrategy } from "../metaobjects-config.js";
import { hasWritableRdbSource } from "../source-detect.js";
import { isTphSubtype, tphDiscriminatorBase, tphDiscriminatorPin } from "../templates/zod-validators.js";
import { viaHopError } from "../projection/extract-report-spec.js";
import {
  encodeIntEnumFilterValue,
  packageOf,
  sourceColumnNameFor,
  walkViaPath,
  type Path,
  type PathStep,
} from "../projection/extract-view-spec.js";
import { cond } from "../projection/report-sql.js";
import {
  CubeModelError,
  ERR_CUBE_AMBIGUOUS_PATH,
  ERR_CUBE_NO_PRIMARY_KEY,
  ERR_CUBE_UNMAPPABLE_DIMENSION,
} from "./cube-errors.js";
import {
  dimensionColumn,
  docOf,
  grainsOf,
  measureSpec,
  memberKey,
  segmentSpec,
  type MemberContext,
} from "./cube-members.js";
import type {
  CubeDialect,
  CubeDimensionSpec,
  CubeJoinSpec,
  CubeMeasureSpec,
  CubeModel,
  CubeSegmentSpec,
  CubeSpec,
} from "./cube-model-spec.js";
import { assertCubeNames, MemberNamespace } from "./cube-names.js";
import { cubeColumn, cubeSqlRenderer, joinedColumn, memberRef, tableRef } from "./cube-sql.js";

export interface CubeModelOptions {
  readonly dialect: CubeDialect;
  readonly columnNamingStrategy: ColumnNamingStrategy;
  /** The generator's selection: an entity's cube is emitted only when it matches. */
  readonly matches?: (obj: MetaObject) => boolean;
}

const REPORTING_TYPES: ReadonlySet<string> = new Set([TYPE_DIMENSION, TYPE_MEASURE, TYPE_SEGMENT]);

/** `entity` declares (or inherits) reporting vocabulary; `joinTarget` is only reached (Table A). */
type CubeKind = "entity" | "joinTarget";

/** One to-one hop a cube holds onto another cube: a Cube join (Table E). */
interface Hop {
  /** The reference or relationship name. */
  readonly hop: string;
  readonly node: MetaData;
  readonly step: PathStep;
  readonly relationship: "many_to_one" | "one_to_one";
  /** The joined cube: the target's own, or the alias cube `<Cube>_<hop>`. */
  readonly joinName: string;
}

interface CubeDraft {
  readonly name: string;
  readonly entity: MetaObject;
  readonly kind: CubeKind;
  readonly namespace: MemberNamespace;
  readonly hops: Hop[];
  readonly keyDims: CubeDimensionSpec[];
  /** Declared dimensions in declaration order; a `@via` one is filled once every cube's joins exist. */
  readonly declaredOrder: MetaDimension[];
  readonly declaredDims: Map<MetaDimension, CubeDimensionSpec>;
  readonly viaPaths: Map<MetaDimension, Path>;
  readonly addedDims: CubeDimensionSpec[];
  readonly measures: CubeMeasureSpec[];
  readonly segments: CubeSegmentSpec[];
  /** Field name → the first declared attribute dimension without `@via` over it (Table E reuse). */
  readonly declaredByField: Map<string, string>;
  /** Field name → the member the exporter added over it (a key or reached-column dimension). */
  readonly addedByField: Map<string, string>;
}

interface AliasDraft {
  readonly name: string;
  readonly target: CubeDraft;
}

export function buildCubeModel(root: MetaRoot, options: CubeModelOptions): CubeModel {
  // CubeDialect admits only these; a caller outside the type system gets a refusal, not SQLite SQL.
  if (options.dialect !== "postgres" && options.dialect !== "mysql") {
    throw new Error(`buildCubeModel: dialect '${String(options.dialect)}' is not a Cube data source this exporter writes (postgres, mysql).`);
  }
  return new CubeModelBuilder(root, options).build();
}

/** Table A: a concrete entity with a table that declares or inherits reporting vocabulary. */
function hasReportingVocabulary(obj: MetaObject): boolean {
  // ADR-0039: resolving children(), so a member declared on an abstract base counts.
  return !obj.isAbstract && hasWritableRdbSource(obj) && obj.children().some((c) => REPORTING_TYPES.has(c.type));
}

function hopLabel(node: MetaData): string {
  const kind = node.type === TYPE_IDENTITY ? "identity.reference" : `relationship.${node.subType}`;
  return `${kind} '${memberKey(node)}'`;
}

/** True when `hop` is the join a `@via` step crosses. */
function crosses(hop: Hop, step: PathStep): boolean {
  if (hop.step.targetEntity !== step.targetEntity) return false;
  // A belongs-to step (through a reference, or a relationship backed by one) crosses the
  // reference's join; a step whose reference the far entity holds crosses its relationship's.
  return step.referenceHolder === "source"
    ? hop.relationship === "many_to_one" && hop.step.fkColumn === step.fkColumn
    : hop.relationship === "one_to_one" && hop.hop === step.relationship;
}

/** Every simple path from `from` to `to` in the cube join graph, up to `limit`. */
function simplePaths(graph: ReadonlyMap<string, readonly string[]>, from: string, to: string, limit = 8): string[][] {
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

class CubeModelBuilder {
  private readonly d: CubeDialect;
  private readonly mc: MemberContext;
  private readonly byKey = new Map<string, MetaObject>();
  /** Keyed by entity resolution key, in model order. */
  private readonly drafts = new Map<string, CubeDraft>();
  private readonly aliases: AliasDraft[] = [];

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
    assertCubeNames([
      ...[...this.drafts.values()].map((c) => ({ name: c.name, what: `entity '${c.entity.resolutionKey()}'` })),
      ...this.aliases.map((a) => ({ name: a.name, what: `the alias cube '${a.name}' of '${a.target.entity.resolutionKey()}'` })),
    ]);
    this.assertJoinKeys();

    const graph = this.cubeGraph();
    for (const draft of this.drafts.values()) {
      for (const [dim, path] of draft.viaPaths) draft.declaredDims.set(dim, this.viaDimension(draft, dim, path, graph));
    }

    return {
      cubes: [
        ...[...this.drafts.values()].map((c) => this.cubeSpec(c)),
        ...this.aliases.map((a): CubeSpec => ({
          name: a.name,
          extends: a.target.name,
          public: false,
          joins: [],
          dimensions: [],
          measures: [],
          segments: [],
          preAggregations: [],
        })),
      ],
      views: [],
    };
  }

  private draft(entity: MetaObject, kind: CubeKind, viaPaths: Map<MetaDimension, Path>): CubeDraft {
    return {
      name: entity.name,
      entity,
      kind,
      namespace: new MemberNamespace(entity.name),
      hops: [],
      keyDims: [],
      declaredOrder: [],
      declaredDims: new Map(),
      viaPaths,
      addedDims: [],
      measures: [],
      segments: [],
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
   * A `@via` dimension's join path, resolved exactly as the report view resolves it
   * (extract-report-spec.ts), then held to what a Cube member reference can read: to-one hops,
   * onto entities with a table, never back onto a cube already on the path.
   */
  private viaPath(dim: MetaDimension, from: MetaObject): Path {
    const where = `cube '${from.name}': dimension '${memberKey(dim)}'`;
    const via = dim.via() ?? "";
    // The loader's rule D2: the owner half resolves in the DECLARING entity's package and must
    // be `from` or an entity it extends; the walk then starts AT `from`, by its short name.
    const hops = reportingViaHops(via, reportingMemberOwner(dim, from), from, this.root);
    if (hops === undefined) {
      throw new Error(
        `${where} @via '${via}' must be Owner.hop[.hop...], starting at '${from.name}' or an entity it extends.`,
      );
    }
    const path = walkViaPath([from.name, ...hops].join("."), this.root, packageOf(from), this.mc.extract);
    if (path.length !== hops.length) {
      const last = path[path.length - 1];
      const at = last === undefined ? from : this.byKey.get(last.targetEntity);
      throw viaHopError(where, "@via", via, hops[path.length]!, at ?? from, this.root);
    }
    const onPath = new Set([from.resolutionKey()]);
    for (const step of path) {
      if (step.cardinality !== CARDINALITY_ONE) {
        throw new CubeModelError(
          ERR_CUBE_UNMAPPABLE_DIMENSION,
          `${where} @via '${via}' crosses the to-many hop '${step.relationship}'. A dimension reads one value ` +
            `per row, which Cube reads through to-one joins only. Make every hop of the @via to-one.`,
        );
      }
      if (onPath.has(step.targetEntity)) {
        throw new CubeModelError(
          ERR_CUBE_UNMAPPABLE_DIMENSION,
          `${where} @via '${via}' comes back to '${step.targetEntity}' at hop '${step.relationship}', and Cube ` +
            `cannot join a cube to itself: a member reference names a cube, and that cube is already on the path. ` +
            `Remove the dimension, or read the value through an entity that is not on the path.`,
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
      const label = `${child.type} '${memberKey(child)}'`;
      draft.namespace.add(child.name, label);
      const where = `cube '${draft.name}': ${label}`;
      // The type string identifies the node (no `instanceof` across packages); casts are type-only.
      if (child.type === TYPE_DIMENSION) {
        const dim = child as MetaDimension;
        draft.declaredOrder.push(dim);
        if (dim.via() === undefined) draft.declaredDims.set(dim, this.ownDimension(draft, dim, where));
      } else if (child.type === TYPE_MEASURE) {
        draft.measures.push(measureSpec(draft.entity, child as MetaMeasure, where, this.mc));
      } else {
        draft.segments.push(segmentSpec(draft.entity, child as MetaSegment, where, this.mc));
      }
    }
  }

  /** A dimension over the owning cube's own column (no `@via`). */
  private ownDimension(draft: CubeDraft, dim: MetaDimension, where: string): CubeDimensionSpec {
    // A dimension without @via is about `from`'s own rows: the field is read from `from`.
    const of = resolveReportingFieldRef(dim.of() ?? "", reportingMemberOwner(dim, draft.entity), this.root, draft.entity);
    if (of === undefined) throw new Error(`${where} @of '${dim.of() ?? ""}' does not resolve.`);
    const { sql, type } = this.columnOf(of, where);
    if (!dim.isTime() && !draft.declaredByField.has(of.name)) draft.declaredByField.set(of.name, dim.name);
    return { name: dim.name, sql, type, ...grainsOf(dim), ...docOf(dim) };
  }

  /**
   * Table E: each to-one hop this cube holds onto another cube, in declaration order. Two or
   * more hops onto one entity each get an alias cube, never the plain target for one of them.
   */
  private addJoins(draft: CubeDraft): void {
    const entity = draft.entity;
    const self = entity.resolutionKey();
    const candidates: Omit<Hop, "joinName">[] = [];
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
      // The view's own hop walk, so the ON columns are the ones the view joins on.
      const step = walkViaPath(`${entity.name}${CHILD_REF_SEPARATOR}${child.name}`, this.root, packageOf(entity), this.mc.extract)[0];
      // Joins are emitted between two distinct cubes only (Cube cannot join a cube to itself).
      if (step === undefined || step.targetEntity === self || !this.drafts.has(step.targetEntity)) continue;
      // A to-one relationship whose reference this entity holds is that reference's join.
      if ((relationship === "many_to_one") !== (step.referenceHolder === "source")) continue;
      candidates.push({ hop: child.name, node: child, step, relationship });
    }
    const perTarget = new Map<string, number>();
    for (const h of candidates) perTarget.set(h.step.targetEntity, (perTarget.get(h.step.targetEntity) ?? 0) + 1);
    for (const h of candidates) {
      const target = this.drafts.get(h.step.targetEntity)!;
      // Cube allows one join per target cube.
      const aliased = (perTarget.get(h.step.targetEntity) ?? 0) > 1;
      const joinName = aliased ? `${draft.name}_${h.hop}` : target.name;
      if (aliased) this.aliases.push({ name: joinName, target });
      draft.hops.push({ ...h, joinName });
    }
  }

  /** Cube needs a primary key on both sides of a join. */
  private assertJoinKeys(): void {
    for (const draft of this.drafts.values()) {
      for (const h of draft.hops) {
        for (const side of [draft.entity, this.drafts.get(h.step.targetEntity)!.entity]) {
          if (side.primaryIdentity() !== undefined) continue;
          throw new CubeModelError(
            ERR_CUBE_NO_PRIMARY_KEY,
            `cube '${draft.name}': the join '${h.joinName}' (${hopLabel(h.node)}) joins '${side.resolutionKey()}', ` +
              `which declares no identity.primary, and Cube needs a primary key on both sides of a join. ` +
              `Declare an identity.primary on '${side.resolutionKey()}'.`,
          );
        }
      }
    }
  }

  /** Cube name → the cubes its joins reach. An alias cube inherits the joins of the cube it extends. */
  private cubeGraph(): Map<string, string[]> {
    const graph = new Map<string, string[]>();
    for (const draft of this.drafts.values()) graph.set(draft.name, draft.hops.map((h) => h.joinName));
    for (const a of this.aliases) graph.set(a.name, a.target.hops.map((h) => h.joinName));
    return graph;
  }

  /** Table E: a `@via` dimension reads a member of the cube its last hop joins. */
  private viaDimension(
    draft: CubeDraft,
    dim: MetaDimension,
    path: Path,
    graph: ReadonlyMap<string, readonly string[]>,
  ): CubeDimensionSpec {
    const label = `dimension '${memberKey(dim)}'`;
    const where = `cube '${draft.name}': ${label}`;
    let joined = "";
    for (const step of path) {
      const hop = this.drafts.get(step.entity.resolutionKey())?.hops.find((h) => crosses(h, step));
      if (hop === undefined) throw new Error(`${where}: no join crosses its @via hop '${step.relationship}'.`);
      joined = hop.joinName;
    }
    if (path.length > 1) {
      const paths = simplePaths(graph, draft.name, joined);
      if (paths.length > 1) {
        throw new CubeModelError(
          ERR_CUBE_AMBIGUOUS_PATH,
          `${where} reads '${joined}' through @via '${dim.via() ?? ""}', and the cube graph reaches '${joined}' ` +
            `from '${draft.name}' by more than one path (${paths.map((p) => p.join(" -> ")).join("; ")}), so Cube ` +
            `could join it by either. Remove the identity.reference that makes the other path, or read the value ` +
            `through a single hop.`,
        );
      }
    }
    // Without a host: a @via dimension's field is read from the entity its @of names.
    const of = resolveReportingFieldRef(dim.of() ?? "", reportingMemberOwner(dim, draft.entity), this.root, undefined);
    if (of === undefined) throw new Error(`${where} @of '${dim.of() ?? ""}' does not resolve.`);
    const { type } = this.columnOf(of, where);
    const target = this.drafts.get(path[path.length - 1]!.targetEntity)!;
    const member = this.reachedMember(target, of, label);
    return { name: dim.name, sql: memberRef(member, joined), type, ...grainsOf(dim), ...docOf(dim) };
  }

  /**
   * The member of `target` a `@via` onto `field` reads: a declared attribute dimension over the
   * field, else the one the exporter already added, else a new `public: false` dimension named
   * after the field. Added on the target entity's own cube; an alias cube inherits it.
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

  private join(draft: CubeDraft, h: Hop): CubeJoinSpec {
    const renderer = cubeSqlRenderer(`cube '${draft.name}': join '${h.joinName}' (${hopLabel(h.node)})`);
    const { fkColumn, pkColumn } = h.step;
    // The view's ON predicate (renderJoin), with `{CUBE}` for this cube and `{<join>}` for the other.
    const sql =
      h.relationship === "many_to_one"
        ? `${cubeColumn(fkColumn, this.d, renderer)} = ${joinedColumn(h.joinName, pkColumn, this.d, renderer)}`
        : `${cubeColumn(pkColumn, this.d, renderer)} = ${joinedColumn(h.joinName, fkColumn, this.d, renderer)}`;
    return { name: h.joinName, relationship: h.relationship, sql };
  }

  /** `sql_table`, or for a TPH subtype a `sql` over the base table with its discriminator predicate. */
  private source(draft: CubeDraft): Pick<CubeSpec, "sqlTable" | "sql"> {
    const entity = draft.entity;
    const where = `cube '${draft.name}'`;
    const renderer = cubeSqlRenderer(where);
    if (!isTphSubtype(entity)) {
      return { sqlTable: tableRef(resolveTableName(entity), resolveTableSchema(entity), this.d, renderer) };
    }
    // A TPH subtype shares its base's table with every other subtype: scope it by the pin.
    const base = tphDiscriminatorBase(entity)!;
    const pin = tphDiscriminatorPin(entity)!;
    const field = entity.fields().find((f) => f.name === pin.fieldName);
    if (field === undefined) throw new Error(`${where}: discriminator field '${pin.fieldName}' is not a field of '${entity.name}'.`);
    const value =
      field.subType === FIELD_SUBTYPE_ENUM
        ? encodeIntEnumFilterValue(pin.value, FILTER_OP_EQ, intValueMapOf(field), pin.fieldName, where)
        : pin.value;
    const predicate = cond({ kind: "cmp", ref: sourceColumnNameFor(field, this.mc.extract), op: FILTER_OP_EQ, value }, this.d, renderer);
    return { sql: `SELECT * FROM ${tableRef(resolveTableName(base), resolveTableSchema(base), this.d, renderer)} WHERE ${predicate}` };
  }

  private cubeSpec(draft: CubeDraft): CubeSpec {
    return {
      name: draft.name,
      ...this.source(draft),
      ...(draft.kind === "joinTarget" ? { public: false } : {}),
      ...docOf(draft.entity),
      joins: draft.hops.map((h) => this.join(draft, h)),
      dimensions: [...draft.keyDims, ...draft.declaredOrder.map((dim) => draft.declaredDims.get(dim)!), ...draft.addedDims],
      measures: draft.measures,
      segments: draft.segments,
      preAggregations: [],
    };
  }
}
