// FR-044 — how a reporting member's references resolve: a dimension's `@of` field and `@via`
// path, a measure's aggregate, `@of` fields and condition, a ratio's operands. The report view
// lowering (extract-report-spec.ts) and the Cube exporter (cube/) both call these, so a
// reference the view joins is the reference Cube joins, and both refuse the same models with
// the same messages. Rendering the result as SQL is report-sql.ts's concern.

import {
  IDENTITY_REFERENCE_ATTR_REFERENCES,
  IDENTITY_SUBTYPE_REFERENCE,
  RELATIONSHIP_ATTR_OBJECT_REF,
  TYPE_IDENTITY,
  TYPE_MEASURE,
  TYPE_RELATIONSHIP,
  reportingMemberOwner,
  reportingViaHops,
  resolveObjectRef,
  resolveReportingFieldRef,
  type MeasureAgg,
  type MetaData,
  type MetaDimension,
  type MetaField,
  type MetaMeasure,
  type MetaObject,
  type MetaRoot,
} from "@metaobjectsdev/metadata";
import { packageOf, walkViaPath, type ExtractContext, type Path } from "./extract-view-spec.js";
import { andOf, declared, resolveReportFilter, segmentClause } from "./report-sql.js";
import type { ViewFilterClause } from "./view-spec.js";

/**
 * A dimension's `@of` field. Without `@via` the dimension is about `from`'s own rows, so the
 * field is read from `from` (a field `from` redeclares wins); with `@via` it is read from the
 * entity `@of` names. The entity half resolves in the DECLARING entity's package.
 */
export function dimensionOfField(dim: MetaDimension, from: MetaObject, root: MetaRoot): MetaField | undefined {
  return resolveReportingFieldRef(
    dim.of() ?? "",
    reportingMemberOwner(dim, from),
    root,
    dim.via() === undefined ? from : undefined,
  );
}

/**
 * Why a dimension's `@via` (or a report's `@spine`, `attr`) walk stopped at `hop`: the error
 * names the hop, the entity it was looked up on, and what the model is missing. The loader
 * (rules D2 and R8) accepts a to-one `relationship.*` with no `identity.reference` behind it,
 * so the missing-foreign-key case is reachable from a model that loads clean.
 */
export function viaHopError(where: string, attr: string, via: string, hop: string, at: MetaData, root: MetaRoot): Error {
  const head = `${where} ${attr} '${via}' cannot be joined at hop '${hop}' on '${at.resolutionKey()}'`;
  // ADR-0039: resolving children(), so an inherited relationship or reference is found.
  const node = at
    .children()
    .find(
      (c) =>
        c.name === hop &&
        (c.type === TYPE_RELATIONSHIP || (c.type === TYPE_IDENTITY && c.subType === IDENTITY_SUBTYPE_REFERENCE)),
    );
  if (node === undefined) {
    return new Error(`${head}: it names no relationship or identity.reference of that entity.`);
  }
  const targetRef = node.attr(
    node.type === TYPE_IDENTITY ? IDENTITY_REFERENCE_ATTR_REFERENCES : RELATIONSHIP_ATTR_OBJECT_REF,
  );
  const target = typeof targetRef === "string" ? resolveObjectRef(root, targetRef, packageOf(at)).node : undefined;
  if (target === undefined) {
    return new Error(`${head}: its target '${String(targetRef ?? "")}' does not resolve to an object.`);
  }
  return new Error(
    `${head}: the model declares no foreign key for it. A view joins a hop through an identity.reference; ` +
      `declare one on '${at.name}' whose @references is '${target.name}' (with the foreign-key field in @fields).`,
  );
}

/**
 * The join path of a dimension's `@via`, walked from `from`. The loader's rule D2: the owner
 * half resolves in the DECLARING entity's package and must be `from` or an entity it extends;
 * the walk then starts AT `from`. Throws, naming `where`, when the chain does not resolve to
 * the end: a partial path would pin the dimension to the wrong join.
 *
 * `checkHops`, when given, sees the `@via`'s hops after they resolve and before they are
 * walked, and may throw. The report view lowering refuses there a dimension its `@spine` does
 * not lead to (rule R9), so that refusal comes before any error of the walk.
 */
export function resolveDimensionViaPath(
  dim: MetaDimension,
  from: MetaObject,
  root: MetaRoot,
  ctx: ExtractContext,
  where: string,
  checkHops?: (hops: readonly string[]) => void,
): Path {
  const via = dim.via() ?? "";
  const hops = reportingViaHops(via, reportingMemberOwner(dim, from), from, root);
  if (hops === undefined) {
    throw new Error(
      `${where} @via '${via}' must be Owner.hop[.hop...], starting at @from '${from.name}' or an entity it extends.`,
    );
  }
  checkHops?.(hops);
  // The head is `from`'s SHORT name, resolved in `from`'s own package: a bare name binds the
  // referrer's package first, so it is `from` itself even when another package has an entity
  // of that name. Never its resolution key: walkViaPath splits on every `.`, and a package
  // name may contain one (`com.acme::F`).
  const path = walkViaPath([from.name, ...hops].join("."), root, packageOf(from), ctx);
  // walkViaPath stops at the first hop it cannot resolve; a partial path would pin the
  // dimension to the wrong alias, so the whole chain must be walked.
  if (path.length !== hops.length) {
    const last = path[path.length - 1];
    const at = last === undefined ? from : root.objects().find((o) => o.resolutionKey() === last.targetEntity);
    throw viaHopError(where, "@via", via, hops[path.length]!, at ?? from, root);
  }
  return path;
}

/** A `measure.aggregate`'s parts, resolved over `from`'s own rows. */
export interface ResolvedAggregate {
  readonly agg: MeasureAgg;
  readonly distinct: boolean;
  /** The `@of` fields, read from `from`: one, or a tuple. */
  readonly fields: readonly MetaField[];
  /** Its `@segment` filter, then its `@filter`, ANDed, over `alias`. Absent when neither. */
  readonly condition?: ViewFilterClause;
}

export function resolveAggregate(
  measure: MetaMeasure,
  from: MetaObject,
  root: MetaRoot,
  alias: string,
  ctx: ExtractContext,
  where: string,
): ResolvedAggregate {
  const agg = measure.agg();
  if (agg === undefined) throw new Error(`${where}: has no @agg.`);
  // The same rule as reportShape: the entity half resolves in the DECLARING entity's package,
  // and the column is read from `from` (a measure aggregates `from`'s own rows).
  const declaring = reportingMemberOwner(measure, from);
  const fields = measure.ofColumns().map((ref) => {
    const f = resolveReportingFieldRef(ref, declaring, root, from);
    if (f === undefined) throw new Error(`${where}: @of '${ref}' does not resolve.`);
    return f;
  });
  const condition = andOf([
    segmentClause(measure.segmentName(), from, alias, ctx, where),
    resolveReportFilter(measure.filter(), from, alias, ctx, `${where} @filter`),
  ]);
  return { agg, distinct: measure.distinct(), fields, ...(condition !== undefined ? { condition } : {}) };
}

/** A ratio operand: a `measure.aggregate` declared on (or inherited by) `from`. */
export function ratioOperand(from: MetaObject, ratio: MetaMeasure, name: string | undefined, where: string): MetaMeasure {
  const m = name === undefined ? undefined : (declared(from, TYPE_MEASURE, name) as MetaMeasure | undefined);
  if (m === undefined || m.isRatio()) {
    throw new Error(
      `${where}: ratio '${ratio.name}' operand '${name ?? ""}' is not a measure.aggregate on '${from.name}'.`,
    );
  }
  return m;
}
