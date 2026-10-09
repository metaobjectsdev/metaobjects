// FR-044 — cross-node rules for the reporting vocabulary. The rule ids (D1…F2)
// match the rule table in docs/superpowers/plans/2026-10-03-fr-044-plan-1-reporting-vocabulary.md
// (R8, R9, M7 and M8: Table B of docs/superpowers/plans/2026-10-09-fr-044-zero-rows-and-measure-defaults.md)
// and the error fixtures in fixtures/conformance/error-*. Every port implements
// the same table WITH THE SAME MESSAGE TEXT; the fixtures are the contract.
//
// Two design rules hold throughout, so one broken rule yields exactly one error:
//   - No cascades. A member that fails a structural rule is not checked further
//     (a dimension whose @via fails D2 skips D1/D3/D4; a report whose @from fails
//     R1 skips R2/R3/R6/R7 and its @filter; an invalid @dimensions/@measures item
//     derives no report field for R6).
//   - Each error's `source` is the offending node (the dimension / measure /
//     segment / report, or for R4/R5 the declared child), so a conformance
//     fixture's jsonPath points at it.
//
// Inheritance (ADR-0039): an entity's members are read through children(), so a
// member declared on an abstract base is validated against every entity that
// inherits it. Members declared on an entity are validated first (pass 1), then
// inherited ones (pass 2); an error already reported for the same node with the
// same message is not repeated, so a broken base member is reported ONCE, and
// a failure that only an inheritor exposes carries " (inherited by '<entity>')".

import type { MetaData } from "../shared/meta-data.js";
import { ParseError, type ErrorCode } from "../errors.js";
import { resolveObjectRef } from "../naming-refs.js";
import { PACKAGE_SEPARATOR, CHILD_REF_SEPARATOR } from "../shared/structural.js";
import {
  TYPE_OBJECT,
  TYPE_FIELD,
  TYPE_IDENTITY,
  TYPE_RELATIONSHIP,
  TYPE_SOURCE,
  TYPE_DIMENSION,
  TYPE_MEASURE,
  TYPE_SEGMENT,
} from "../shared/base-types.js";
import {
  OBJECT_SUBTYPE_ENTITY,
  OBJECT_SUBTYPE_REPORT,
  OBJECT_REPORT_ATTR_FILTER,
  OBJECT_REPORT_ATTR_SEGMENT,
  OBJECT_REPORT_ATTR_SPINE,
} from "../core/object/object-constants.js";
import {
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_LONG,
  FIELD_SUBTYPE_DOUBLE,
  FIELD_SUBTYPE_FLOAT,
  FIELD_SUBTYPE_DECIMAL,
  FIELD_SUBTYPE_CURRENCY,
  FIELD_SUBTYPE_BOOLEAN,
  FIELD_SUBTYPE_OBJECT,
  FIELD_SUBTYPE_MAP,
  FIELD_SUBTYPE_DATE,
  FIELD_SUBTYPE_TIMESTAMP,
} from "../core/field/field-constants.js";
import {
  IDENTITY_SUBTYPE_REFERENCE,
  IDENTITY_REFERENCE_ATTR_REFERENCES,
} from "../core/identity/identity-constants.js";
import {
  RELATIONSHIP_ATTR_OBJECT_REF,
  RELATIONSHIP_ATTR_CARDINALITY,
  CARDINALITY_ONE,
} from "../core/relationship/relationship-constants.js";
import {
  FILTER_COMPOSE_OR,
  FILTER_COMPOSE_AND,
  FILTER_OP_GT,
  FILTER_OP_GTE,
  FILTER_OP_LT,
  FILTER_OP_LTE,
  opsForField,
} from "../core/query/query-constants.js";
import { ATTR_SUBTYPE_FILTER } from "../core/attr/attr-constants.js";
import { isWritableSource } from "../shared/node-guards.js";
import {
  FILTER_RELATIVE_NOW,
  ISO_DURATION_RE,
  AGG_COUNT,
  AGG_SUM,
  AGG_AVG,
  AGG_MIN,
  AGG_MAX,
  GRAIN_HOUR,
  REPORTING_ATTR_NUMERATOR,
  REPORTING_ATTR_DENOMINATOR,
  REPORTING_ATTR_DEFAULT,
  REPORTING_ATTR_VIA,
  MEASURE_SUBTYPE_AGGREGATE,
} from "../core/reporting/reporting-constants.js";
import { MetaDimension } from "../core/reporting/meta-dimension.js";
import { MetaMeasure } from "../core/reporting/meta-measure.js";
import { MetaSegment } from "../core/reporting/meta-segment.js";
import {
  reportDerivedFieldName,
  reportDimensionItems,
  reportFrom,
  reportMeasureNames,
  reportSpine,
} from "../core/reporting/report-accessors.js";

// ---------------------------------------------------------------------------
// Closed sets the rules consult
// ---------------------------------------------------------------------------

/** M4 — the field subtypes `sum`/`avg` accept. */
const NUMERIC_FIELD_SUBTYPES: readonly string[] = [
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_LONG,
  FIELD_SUBTYPE_DOUBLE,
  FIELD_SUBTYPE_FLOAT,
  FIELD_SUBTYPE_DECIMAL,
  FIELD_SUBTYPE_CURRENCY,
];

/** M4 — the field subtypes `min`/`max` refuse (no total order). */
const UNORDERED_FIELD_SUBTYPES: readonly string[] = [
  FIELD_SUBTYPE_BOOLEAN,
  FIELD_SUBTYPE_OBJECT,
  FIELD_SUBTYPE_MAP,
];

/** D3 / F2 — the temporal field subtypes. */
const TEMPORAL_FIELD_SUBTYPES: readonly string[] = [FIELD_SUBTYPE_DATE, FIELD_SUBTYPE_TIMESTAMP];

/** F2 — the only ops a relative-date value may sit under. */
const RELATIVE_DATE_OPS: readonly string[] = [FILTER_OP_GT, FILTER_OP_GTE, FILTER_OP_LT, FILTER_OP_LTE];

const ERR_INVALID_DIMENSION: ErrorCode = "ERR_INVALID_DIMENSION";
const ERR_INVALID_MEASURE: ErrorCode = "ERR_INVALID_MEASURE";
const ERR_INVALID_REPORT: ErrorCode = "ERR_INVALID_REPORT";
const ERR_REPORT_FOREIGN_MEASURE: ErrorCode = "ERR_REPORT_FOREIGN_MEASURE";
const ERR_BAD_ATTR_FILTER: ErrorCode = "ERR_BAD_ATTR_FILTER";

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function validateReporting(root: MetaData): ParseError[] {
  const sink = new ErrorSink();
  // ADR-0039: root has no super; children()==ownChildren() but resolving is the default.
  const objects = root.children().filter((c) => c.type === TYPE_OBJECT);
  const entities = objects.filter((o) => o.subType === OBJECT_SUBTYPE_ENTITY);

  // Pass 1: every member against the entity that declares it (an abstract base
  // included — its members must be self-consistent). Pass 2: inherited members
  // against each inheriting entity, so an override that breaks one is caught.
  for (const entity of entities) checkEntityMembers(root, entity, true, sink);
  for (const entity of entities) checkEntityMembers(root, entity, false, sink);

  for (const report of objects.filter((o) => o.subType === OBJECT_SUBTYPE_REPORT)) {
    checkReport(root, report, sink);
  }

  // F1 on every host that is not a reporting host.
  checkNoRelativeDates(root, sink);
  return sink.errors;
}

/** Collects errors, dropping a repeat — the shape an unmodified inherited
 *  member's failure takes when it is re-validated under an inheriting entity.
 *  A message is `head + suffix + body`. A pass-2 error (suffix
 *  " (inherited by '<entity>')") is dropped when pass 1 already reported the
 *  same failure without a suffix, or the same inheritor already reported it;
 *  a second inheritor's identical failure is still reported, under its own name. */
class ErrorSink {
  readonly errors: ParseError[] = [];
  private readonly seen = new Map<MetaData, Set<string>>();

  push(node: MetaData, code: ErrorCode, head: string, body: string, suffix = ""): void {
    // `base` drops a pass-2 copy of a failure pass 1 already reported; a pass-2
    // entry is keyed WITH its suffix, so two inheritors that break the same
    // inherited member the same way are each reported.
    const base = `${code}\u0000${head}${body}`;
    const key = `${base}\u0000${suffix}`;
    let keys = this.seen.get(node);
    if (keys === undefined) {
      keys = new Set();
      this.seen.set(node, keys);
    }
    if (keys.has(base) || keys.has(key)) return;
    keys.add(suffix === "" ? base : key);
    this.errors.push(new ParseError(`${head}${suffix}${body}`, { code, source: node.source }));
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** The node's package for ADR-0042 bare-reference resolution. */
function pkgOf(node: MetaData): string {
  return node.package ?? node.fileDefaultPackage ?? "";
}

/**
 * Split a dotted `Owner.child[.child…]` reference at the first `.` after the
 * last `::` (the same rule `_refNamedOwner` applies to extends refs), so an
 * FQN owner (`acme::shop::Purchase.program`) keeps its package. Undefined when
 * there is no owner, no child, or an empty child segment.
 */
function splitDotted(ref: string): { owner: string; path: string[] } | undefined {
  const lastSep = ref.lastIndexOf(PACKAGE_SEPARATOR);
  const segStart = lastSep === -1 ? 0 : lastSep + PACKAGE_SEPARATOR.length;
  const dot = ref.indexOf(CHILD_REF_SEPARATOR, segStart);
  if (dot <= segStart) return undefined;
  const path = ref.slice(dot + CHILD_REF_SEPARATOR.length).split(CHILD_REF_SEPARATOR);
  if (path.some((s) => s === "")) return undefined;
  return { owner: ref.slice(0, dot), path };
}

/** True when `candidate` is `entity` or an entity it extends (the super chain). */
function isSelfOrAncestor(candidate: MetaData | undefined, entity: MetaData): boolean {
  const visited = new Set<MetaData>();
  for (let n: MetaData | undefined = entity; n !== undefined && !visited.has(n); n = n.superData) {
    if (n === candidate) return true;
    visited.add(n);
  }
  return false;
}

function childOfType(obj: MetaData, type: string, name: string): MetaData | undefined {
  // ADR-0039: resolving — inherited members (via extends) are visible.
  return obj.children().find((c) => c.type === type && c.name === name);
}

function fieldOf(obj: MetaData, name: string): MetaData | undefined {
  return childOfType(obj, TYPE_FIELD, name);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** An object operand carrying a `now` key — a relative-date value, well-formed
 *  (exactly `{ now }`) or not. A malformed one is refused, never read as data. */
function isRelativeValue(v: unknown): v is Record<string, unknown> {
  return isPlainObject(v) && Object.keys(v).includes(FILTER_RELATIVE_NOW);
}

/** True for a well-formed relative value: exactly the one key `now`. */
function isExactRelativeValue(v: Record<string, unknown>): boolean {
  return Object.keys(v).length === 1;
}

/** The relative value an op's operand carries: the operand itself, or one inside an array operand. */
function relativeOperand(v: unknown): Record<string, unknown> | undefined {
  if (isRelativeValue(v)) return v;
  if (Array.isArray(v)) return v.find(isRelativeValue);
  return undefined;
}

/** Deep search of an operand VALUE: is a relative value (well-formed or not) anywhere inside it? */
function operandContainsRelativeValue(v: unknown): boolean {
  if (isRelativeValue(v)) return true;
  if (Array.isArray(v)) return v.some(operandContainsRelativeValue);
  if (isPlainObject(v)) return Object.values(v).some(operandContainsRelativeValue);
  return false;
}

/**
 * Does a filter contain a relative value in any operand? Walks the filter grammar
 * (`and`/`or` arrays, `{ field: { op: operand } }`) so only operand VALUES are
 * searched: a field key that happens to be named `now` is a field, not a relative date.
 */
function filterContainsRelativeValue(filter: unknown): boolean {
  if (!isPlainObject(filter)) return false;
  for (const [key, clause] of Object.entries(filter)) {
    if (key === FILTER_COMPOSE_OR || key === FILTER_COMPOSE_AND) {
      if (Array.isArray(clause) && clause.some(filterContainsRelativeValue)) return true;
      continue;
    }
    if (isRelativeValue(clause)) return true; // un-desugared shorthand
    if (isPlainObject(clause) && Object.values(clause).some(operandContainsRelativeValue)) return true;
  }
  return false;
}

function quoteValue(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

/** `<type>.<subType> '<name>'`, or just `<type>.<subType>` for an unnamed node (e.g. a source or origin). */
function childLabel(node: MetaData): string {
  const head = `${node.type}.${node.subType}`;
  return node.name !== "" ? `${head} '${node.name}'` : head;
}

/** `<type>.<subType> '<FQN>'` for a root-level object, else its childLabel plus ` in <parent label>`. */
function nodeLabel(node: MetaData): string {
  const parent = node.parent;
  if (parent === undefined || parent.parent === undefined) {
    return `${node.type}.${node.subType} '${node.resolutionKey()}'`;
  }
  return `${childLabel(node)} in ${nodeLabel(parent)}`;
}

// ---------------------------------------------------------------------------
// D1–D4, M1–M6, S1/F2 — members of an object.entity
// ---------------------------------------------------------------------------

/** Validation context for one member of one entity. */
interface MemberCtx {
  readonly root: MetaData;
  /** The entity whose children() the member was reached through. */
  readonly host: MetaData;
  /** The entity that declares the member (the host, or an ancestor of it). For a report's @spine
   *  walk (R8) it is the report, so the spine's Owner resolves in the report's package. */
  readonly declaring: MetaData;
  /** `<kind> '<name>' on entity '<declaring FQN>'` — every member message starts with it. */
  readonly label: string;
  /** "" in pass 1; ` (inherited by '<host FQN>')` in pass 2. */
  readonly suffix: string;
  readonly sink: ErrorSink;
}

/**
 * The FQN a member message names for `entity`: the DECLARING entity in place of
 * the host, so a failure is worded identically whichever entity reached the
 * member (the suffix names the inheritor) and the ErrorSink repeat test holds.
 * A report's @spine walk (R8) has no declaring entity (`declaring` is the
 * report), so there every entity names itself.
 */
function shown(ctx: MemberCtx, entity: MetaData): string {
  const declaredByEntity = isSelfOrAncestor(ctx.declaring, ctx.host);
  return (entity === ctx.host && declaredByEntity ? ctx.declaring : entity).resolutionKey();
}

function checkEntityMembers(root: MetaData, entity: MetaData, declaredHere: boolean, sink: ErrorSink): void {
  // ADR-0039: resolving — inherited members are validated against this entity.
  for (const member of entity.children()) {
    if (member.type !== TYPE_DIMENSION && member.type !== TYPE_MEASURE && member.type !== TYPE_SEGMENT) continue;
    const declaring = member.parent ?? entity;
    if ((declaring === entity) !== declaredHere) continue;
    const ctx: MemberCtx = {
      root,
      host: entity,
      declaring,
      label: `${member.type} '${member.name}' on entity '${declaring.resolutionKey()}'`,
      suffix: declaredHere ? "" : ` (inherited by '${entity.resolutionKey()}')`,
      sink,
    };
    if (member instanceof MetaDimension) checkDimension(ctx, member);
    else if (member instanceof MetaMeasure) checkMeasure(ctx, member);
    else if (member instanceof MetaSegment) {
      const filter = member.filter();
      if (filter !== undefined) {
        checkFilter(filter, entity, declaring.resolutionKey(), ctx.label, member, ctx.suffix, sink);
      }
    }
  }
}

function checkDimension(ctx: MemberCtx, dim: MetaDimension): void {
  const err = (message: string): void =>
    ctx.sink.push(dim, ERR_INVALID_DIMENSION, ctx.label, `: ${message}`, ctx.suffix);

  // D2 — the @via walk; its terminal is the entity @of must name.
  let ofEntity = ctx.host;
  const via = dim.via();
  if (via !== undefined) {
    const terminal = walkToOneVia(ctx, via, err);
    if (terminal === undefined) return;
    ofEntity = terminal;
  }

  // D1 — @of is Entity.field on the owning entity (or the @via terminal).
  const of = dim.of();
  if (of === undefined) return; // missing @of is ERR_MISSING_REQUIRED_ATTR (attr schema pass)
  const parts = splitDotted(of);
  if (parts === undefined || parts.path.length !== 1) {
    err(`@of '${of}' must be Entity.field.`);
    return;
  }
  const named = resolveObjectRef(ctx.root, parts.owner, pkgOf(ctx.declaring)).node;
  if (!isSelfOrAncestor(named, ofEntity)) {
    if (via === undefined) {
      err(
        `@of '${of}' must name a field of the owning entity '${ctx.declaring.resolutionKey()}'. ` +
          `Reach another entity's field with @via.`,
      );
    } else {
      err(`@of '${of}' must name a field of '${shown(ctx, ofEntity)}', the entity @via '${via}' reaches.`);
    }
    return;
  }
  const fieldName = parts.path[0]!;
  const field = fieldOf(ofEntity, fieldName);
  if (field === undefined) {
    err(`@of '${of}' names no field '${fieldName}' on '${shown(ctx, ofEntity)}'.`);
    return;
  }

  if (!dim.isTime()) return;
  // D3 — a time dimension groups a date or timestamp.
  if (!TEMPORAL_FIELD_SUBTYPES.includes(field.subType)) {
    err(
      `a time dimension's @of must be a field.date or field.timestamp, but '${of}' is field.${field.subType}.`,
    );
    return;
  }
  // D4 — a date has no hour.
  if (field.subType === FIELD_SUBTYPE_DATE && dim.grains().includes(GRAIN_HOUR)) {
    err(`grain 'hour' is impossible on '${of}', a field.date (a date has no hour). Remove 'hour' from @grains.`);
  }
}

/** How a to-one walk's messages name it: the attribute that holds the path (`via`, `spine`) and
 *  what its Owner must be (`the owning entity '<FQN>'`, `@from '<FQN>'`). */
interface WalkWording {
  readonly attr: string;
  readonly start: string;
}

/**
 * D2 — walk `Owner.hop[.hop...]`: Owner is the owning entity, and every hop is a
 * to-one `relationship.*` or an `identity.reference`. Returns the terminal
 * entity, or undefined after reporting the first failure. R8 runs the same walk
 * over a report's @spine, started at @from; `wording` names it (the default is
 * D2's own wording).
 */
function walkToOneVia(
  ctx: MemberCtx,
  via: string,
  err: (message: string) => void,
  wording: WalkWording = { attr: REPORTING_ATTR_VIA, start: `the owning entity '${ctx.declaring.resolutionKey()}'` },
): MetaData | undefined {
  const named = `@${wording.attr} '${via}'`;
  const parts = splitDotted(via);
  if (parts === undefined) {
    err(`${named} must be Owner.hop[.hop...], starting at the owning entity.`);
    return undefined;
  }
  const owner = resolveObjectRef(ctx.root, parts.owner, pkgOf(ctx.declaring)).node;
  if (!isSelfOrAncestor(owner, ctx.host)) {
    err(`${named} must start at ${wording.start}.`);
    return undefined;
  }
  let current = ctx.host;
  for (const hopName of parts.path) {
    const hop =
      childOfType(current, TYPE_RELATIONSHIP, hopName) ??
      current
        .children()
        .find((c) => c.type === TYPE_IDENTITY && c.subType === IDENTITY_SUBTYPE_REFERENCE && c.name === hopName);
    if (hop === undefined) {
      err(
        `${named} names '${hopName}', which is not a relationship or identity.reference of ` +
          `'${shown(ctx, current)}'.`,
      );
      return undefined;
    }
    const isReference = hop.type === TYPE_IDENTITY;
    if (!isReference && hop.attr(RELATIONSHIP_ATTR_CARDINALITY) !== CARDINALITY_ONE) {
      err(
        `${named} crosses relationship '${hopName}' on '${shown(ctx, current)}', which is not to-one. ` +
          `A dimension follows only @cardinality: one relationships and identity.reference hops, so grouping ` +
          `can never multiply the measured rows.`,
      );
      return undefined;
    }
    const targetRef = hop.attr(isReference ? IDENTITY_REFERENCE_ATTR_REFERENCES : RELATIONSHIP_ATTR_OBJECT_REF);
    // ADR-0042 — a hop target resolves in the package of the entity declaring the hop.
    const target =
      typeof targetRef === "string" ? resolveObjectRef(ctx.root, targetRef, pkgOf(current)).node : undefined;
    if (target === undefined) {
      err(`${named} hop '${hopName}' on '${shown(ctx, current)}' targets no object.`);
      return undefined;
    }
    current = target;
  }
  return current;
}

function checkMeasure(ctx: MemberCtx, measure: MetaMeasure): void {
  const err = (message: string): void =>
    ctx.sink.push(measure, ERR_INVALID_MEASURE, ctx.label, `: ${message}`, ctx.suffix);

  if (measure.isRatio()) {
    checkRatioOperands(ctx, measure, err);
    return;
  }
  if (measure.subType !== MEASURE_SUBTYPE_AGGREGATE) return;

  const checked = checkAggregateColumns(ctx, measure, err);
  const clean = checked !== undefined;
  const ofField = checked?.field;

  // M7 / M8 — where a @default can apply. Only when M1–M4 passed: one mistake, one error.
  // The presence test reads the raw attribute, so a mistyped value on a count still reports M7.
  if (clean && measure.attr(REPORTING_ATTR_DEFAULT) !== undefined) {
    const agg = measure.agg();
    if (agg === AGG_COUNT) {
      err(
        `@default cannot apply to @agg: count. A count is never null (it is 0 when nothing matches); ` +
          `remove @default.`,
      );
    } else if (
      (agg === AGG_MIN || agg === AGG_MAX) &&
      ofField !== undefined &&
      !NUMERIC_FIELD_SUBTYPES.includes(ofField.subType)
    ) {
      err(
        `@default is a number, but @agg '${agg}' of '${measure.ofColumns()[0]}' is a field.${ofField.subType}. ` +
          `A default is supported on numeric measures only.`,
      );
    }
  }

  // M5 — @segment names a segment of the owning entity.
  const segment = measure.segmentName();
  if (segment !== undefined && childOfType(ctx.host, TYPE_SEGMENT, segment) === undefined) {
    err(`@segment '${segment}' names no segment of '${ctx.declaring.resolutionKey()}'.`);
  }

  // S1 / F2 — the measure's own row scope.
  const filter = measure.filter();
  if (filter !== undefined) {
    checkFilter(filter, ctx.host, ctx.declaring.resolutionKey(), ctx.label, measure, ctx.suffix, ctx.sink);
  }
}

/**
 * M1–M4, in order; the first failure stops the chain (no M2+M3 double report).
 * Returns undefined when one of them fired; otherwise `field` is the single
 * resolved @of field (undefined for a tuple), for M7/M8.
 */
function checkAggregateColumns(
  ctx: MemberCtx,
  measure: MetaMeasure,
  err: (message: string) => void,
): { readonly field: MetaData | undefined } | undefined {
  const agg = measure.agg();
  const columns = measure.ofColumns();

  // M1 — every @of item is a field of the owning entity.
  const fields: MetaData[] = [];
  for (const item of columns) {
    const parts = splitDotted(item);
    if (parts === undefined || parts.path.length !== 1) {
      err(`@of '${item}' must be Entity.field.`);
      return undefined;
    }
    const named = resolveObjectRef(ctx.root, parts.owner, pkgOf(ctx.declaring)).node;
    if (!isSelfOrAncestor(named, ctx.host)) {
      err(
        `@of '${item}' must name a field of the owning entity '${ctx.declaring.resolutionKey()}'. ` +
          `A measure aggregates its own entity's rows; declare it on the entity that owns the column.`,
      );
      return undefined;
    }
    const field = fieldOf(ctx.host, parts.path[0]!);
    if (field === undefined) {
      err(`@of '${item}' names no field '${parts.path[0]!}' on '${ctx.declaring.resolutionKey()}'.`);
      return undefined;
    }
    fields.push(field);
  }

  // M2 — a tuple is a distinct count only.
  if (columns.length > 1 && (agg !== AGG_COUNT || !measure.distinct())) {
    err(
      `@of lists ${columns.length} columns; a tuple is legal only with @agg: count and @distinct: true ` +
        `(a distinct count of the tuple).`,
    );
    return undefined;
  }

  // M3 — @distinct is a count modifier.
  if (measure.distinct() && agg !== undefined && agg !== AGG_COUNT) {
    err(`@distinct: true requires @agg: count, not '${agg}'.`);
    return undefined;
  }

  // M4 — the aggregate must be meaningful for the column's type.
  const field = fields.length === 1 ? fields[0] : undefined;
  if (field === undefined || agg === undefined) return { field };
  const item = columns[0]!;
  if ((agg === AGG_SUM || agg === AGG_AVG) && !NUMERIC_FIELD_SUBTYPES.includes(field.subType)) {
    err(
      `@agg '${agg}' needs a numeric field (field.int, long, double, float, decimal or currency), ` +
        `but '${item}' is field.${field.subType}.`,
    );
    return undefined;
  }
  if ((agg === AGG_MIN || agg === AGG_MAX) && UNORDERED_FIELD_SUBTYPES.includes(field.subType)) {
    err(`@agg '${agg}' cannot order '${item}', a field.${field.subType}.`);
    return undefined;
  }
  return { field };
}

/** M6 — each operand names a measure.aggregate of the same entity. */
function checkRatioOperands(ctx: MemberCtx, ratio: MetaMeasure, err: (message: string) => void): void {
  const operands: [string, string | undefined][] = [
    [REPORTING_ATTR_NUMERATOR, ratio.numerator()],
    [REPORTING_ATTR_DENOMINATOR, ratio.denominator()],
  ];
  for (const [attr, ref] of operands) {
    if (ref === undefined) continue; // missing operand is ERR_MISSING_REQUIRED_ATTR
    const target = childOfType(ctx.host, TYPE_MEASURE, ref);
    if (target === undefined) {
      err(`@${attr} '${ref}' names no measure of '${ctx.declaring.resolutionKey()}'.`);
    } else if (target.subType !== MEASURE_SUBTYPE_AGGREGATE) {
      err(
        `@${attr} '${ref}' is a measure.${target.subType}; a ratio's operands must be measure.aggregate ` +
          `(a ratio of ratios is not supported).`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// S1 / F2 — a reporting-host @filter over its entity
// ---------------------------------------------------------------------------

/**
 * Validate a canonical (post-desugar) attr.filter against `entity`'s fields:
 * every key names a field (S1), every op is legal for that field (S1), and a
 * relative-date operand sits on a date/timestamp, under a range op, with a
 * valid ISO-8601 duration (F2). One error per offending clause op.
 */
function checkFilter(
  filter: Record<string, unknown>,
  entity: MetaData,
  entityKey: string,
  hostLabel: string,
  host: MetaData,
  suffix: string,
  sink: ErrorSink,
): void {
  const err = (message: string): void => sink.push(host, ERR_BAD_ATTR_FILTER, hostLabel, `: ${message}`, suffix);
  for (const [key, clause] of Object.entries(filter)) {
    if (key === FILTER_COMPOSE_OR || key === FILTER_COMPOSE_AND) {
      if (!Array.isArray(clause)) {
        err(`@filter '${key}' must be an array of sub-clauses.`);
        continue;
      }
      for (const sub of clause) {
        if (isPlainObject(sub)) checkFilter(sub, entity, entityKey, hostLabel, host, suffix, sink);
        else err(`@filter '${key}' contains a non-object sub-clause.`);
      }
      continue;
    }
    const field = fieldOf(entity, key);
    if (field === undefined) {
      err(`@filter names '${key}', which is not a field of '${entityKey}'.`);
      continue;
    }
    if (!isPlainObject(clause) || Object.keys(clause).length === 0) {
      err(`@filter on '${key}' must be an { op: value } object.`);
      continue;
    }
    const allowed = opsForField(field);
    for (const [op, operand] of Object.entries(clause)) {
      if (!(allowed as readonly string[]).includes(op)) {
        err(
          `@filter on '${key}' uses op '${op}', which is not allowed for field.${field.subType}. ` +
            `Allowed ops: ${allowed.join(", ") || "(none)"}.`,
        );
        continue;
      }
      const relative = relativeOperand(operand);
      if (relative === undefined) continue;
      if (!isExactRelativeValue(relative)) {
        err(
          `@filter on '${key}' has a malformed relative date ${JSON.stringify(relative)}; a relative date is ` +
            `exactly { now: "<ISO-8601 duration>" } with no other keys.`,
        );
        continue;
      }
      if (!TEMPORAL_FIELD_SUBTYPES.includes(field.subType)) {
        err(
          `@filter on '${key}' uses a relative date ({ now: ... }), but '${key}' is field.${field.subType}; ` +
            `relative dates apply only to field.date and field.timestamp.`,
        );
        continue;
      }
      if (!RELATIVE_DATE_OPS.includes(op)) {
        err(
          `@filter on '${key}' puts a relative date under op '${op}'; relative dates are legal only under ` +
            `gt, gte, lt and lte.`,
        );
        continue;
      }
      const duration = relative[FILTER_RELATIVE_NOW];
      if (typeof duration !== "string" || !ISO_DURATION_RE.test(duration)) {
        err(
          `@filter on '${key}' has relative date '${quoteValue(duration)}', which is not an ISO-8601 ` +
            `duration (e.g. '-P7D', '-PT12H').`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// R1–R7 — object.report
// ---------------------------------------------------------------------------

function checkReport(root: MetaData, report: MetaData, sink: ErrorSink): void {
  const label = `report '${report.resolutionKey()}'`;
  const err = (message: string, node: MetaData = report, code: ErrorCode = ERR_INVALID_REPORT): void =>
    sink.push(node, code, label, message);

  // R4 — a report's fields and identity are derived, never declared.
  // ADR-0039: own — the rule is about what the author declared on THIS report.
  for (const child of report.ownChildren()) {
    if (child.type === TYPE_FIELD || child.type === TYPE_IDENTITY) {
      err(
        ` declares ${childLabel(child)}; a report's fields and identity are derived ` +
          `from @dimensions and @measures, never declared.`,
        child,
      );
    }
  }

  // R5 — a report is read-only, so any source it has is read-only.
  // ADR-0039: resolving — an inherited source binds the report just the same.
  for (const source of report.children().filter((c) => c.type === TYPE_SOURCE)) {
    if (isWritableSource(source)) {
      err(
        `: ${childLabel(source)} is writable; a report is read-only, so its source must ` +
          `declare a read-only @kind (view, materializedView, storedProc or tableFunction).`,
        source,
      );
    }
  }

  // R1 — @from resolves to an object.entity. Without it, R2/R3/R6/R7 and the
  // @filter have nothing to resolve against, so they are skipped.
  const fromRef = reportFrom(report);
  if (fromRef === undefined) return; // missing @from is ERR_MISSING_REQUIRED_ATTR
  const from = resolveObjectRef(root, fromRef, pkgOf(report)).node;
  if (from === undefined) {
    err(`: @from '${fromRef}' does not resolve to an object.`);
    return;
  }
  if (from.type !== TYPE_OBJECT || from.subType !== OBJECT_SUBTYPE_ENTITY) {
    err(`: @from '${fromRef}' is an ${from.type}.${from.subType}; a report aggregates the rows of an object.entity.`);
    return;
  }
  const fromKey = from.resolutionKey();

  // R6 — derived field name -> the item that derived it ("dimension item 'x'" / "measure 'y'").
  const derived = new Map<string, string>();
  const claim = (fieldName: string, what: string): void => {
    const prior = derived.get(fieldName);
    if (prior === what) {
      // The same measure listed twice: name the repeat, not a "collision" with itself.
      err(`: @measures lists '${fieldName}' more than once.`);
      return;
    }
    if (prior !== undefined) {
      err(
        `: ${prior} and ${what} both derive report field '${fieldName}'. Report field names must be unique; ` +
          `rename the measure or drop one item.`,
      );
      return;
    }
    derived.set(fieldName, what);
  };

  // R2 — each @dimensions item names a dimension of @from, with a grain exactly when it is a time dimension.
  const seenItems = new Set<string>();
  for (const item of reportDimensionItems(report)) {
    const raw = item.grain === undefined ? item.name : `${item.name}:${item.grain}`;
    if (seenItems.has(raw)) {
      err(`: @dimensions lists '${raw}' more than once.`);
      continue;
    }
    seenItems.add(raw);
    const dim = childOfType(from, TYPE_DIMENSION, item.name);
    if (!(dim instanceof MetaDimension)) {
      err(`: @dimensions item '${raw}' names no dimension of @from '${fromKey}'.`);
      continue;
    }
    if (dim.isTime()) {
      const grains = dim.grains();
      if (item.grain === undefined) {
        err(
          `: @dimensions item '${raw}' names time dimension '${item.name}' without a grain; write ` +
            `'${item.name}:<grain>' with a grain from its @grains (${grains.join(", ")}).`,
        );
        continue;
      }
      if (!(grains as readonly string[]).includes(item.grain)) {
        err(
          `: @dimensions item '${raw}' uses grain '${item.grain}', which time dimension '${item.name}' does not ` +
            `declare. Its @grains: ${grains.join(", ")}.`,
        );
        continue;
      }
    } else if (item.grain !== undefined) {
      err(
        `: @dimensions item '${raw}' gives a grain to attribute dimension '${item.name}'; only a time ` +
          `dimension takes a grain.`,
      );
      continue;
    }
    claim(reportDerivedFieldName(item), `dimension item '${raw}'`);
  }

  // R3 — each @measures item names a measure of @from.
  for (const item of reportMeasureNames(report)) {
    const measureName = checkReportMeasure(root, report, from, item, label, sink);
    if (measureName !== undefined) claim(measureName, `measure '${measureName}'`);
  }

  // R7 — @segment names a segment of @from.
  const segment = report.attr(OBJECT_REPORT_ATTR_SEGMENT);
  if (typeof segment === "string" && childOfType(from, TYPE_SEGMENT, segment) === undefined) {
    err(`: @segment '${segment}' names no segment of @from '${fromKey}'.`);
  }

  // R8 — @spine is a to-one path from @from: rule D2's walk, started at @from.
  const spine = reportSpine(report);
  if (spine !== undefined) {
    const terminal = walkToOneVia(
      { root, host: from, declaring: report, label, suffix: "", sink },
      spine,
      (message) => err(`: ${message}`),
      { attr: OBJECT_REPORT_ATTR_SPINE, start: `@from '${fromKey}'` },
    );
    // R9 — every listed dimension is reached through the spine. Skipped when R8 failed.
    if (terminal !== undefined) {
      const spineHops = splitDotted(spine)?.path ?? [];
      const items = reportDimensionItems(report);
      if (items.length === 0) {
        err(
          `: @spine '${spine}' needs at least one dimension. The report's rows are the dimension tuples of ` +
            `'${terminal.resolutionKey()}'; with no dimension it would be one totals row.`,
        );
      }
      for (const item of items) {
        const dim = childOfType(from, TYPE_DIMENSION, item.name);
        if (!(dim instanceof MetaDimension)) continue; // R2 already reported it
        const via = dim.via();
        const hops = via === undefined ? undefined : splitDotted(via)?.path;
        // Hop names are compared as written; the owner segment is not compared.
        if (hops !== undefined && spineHops.every((h, i) => hops[i] === h)) continue;
        err(
          via === undefined
            ? `: dimension '${item.name}' is read from @from '${fromKey}', so it has no value in a row that has ` +
                `no facts. With @spine '${spine}' every dimension must be reached through it: declare the ` +
                `dimension over a field of '${terminal.resolutionKey()}' (or an entity to-one from it) with an ` +
                `@via that begins '${spine}'.`
            : `: dimension '${item.name}' is reached by @via '${via}', which does not begin with the hops of ` +
                `@spine '${spine}'. Hop names are compared as written; write the same hops.`,
        );
      }
    }
  }

  // S1 / F2 — the report's row scope over @from.
  const filter = report.attr(OBJECT_REPORT_ATTR_FILTER);
  if (isPlainObject(filter)) checkFilter(filter, from, fromKey, label, report, "", sink);
}

/**
 * R3 for one `@measures` item (bare `name` or dotted `Entity.name`). Returns
 * the measure's name when it is a measure of @from (for R6), else reports
 * ERR_REPORT_FOREIGN_MEASURE (it is another entity's measure) or
 * ERR_INVALID_REPORT (it is nobody's) and returns undefined.
 */
function checkReportMeasure(
  root: MetaData,
  report: MetaData,
  from: MetaData,
  item: string,
  label: string,
  sink: ErrorSink,
): string | undefined {
  const fromKey = from.resolutionKey();
  let owner: MetaData | undefined;
  let name: string;
  const parts = splitDotted(item);
  if (parts !== undefined && parts.path.length === 1) {
    owner = resolveObjectRef(root, parts.owner, pkgOf(report)).node;
    name = parts.path[0]!;
    if (owner !== undefined && isSelfOrAncestor(owner, from) && childOfType(from, TYPE_MEASURE, name)) return name;
    if (owner !== undefined && childOfType(owner, TYPE_MEASURE, name) === undefined) owner = undefined;
  } else if (!item.includes(CHILD_REF_SEPARATOR)) {
    name = item;
    if (childOfType(from, TYPE_MEASURE, name) !== undefined) return name;
    // ADR-0039: root has no super; children()==ownChildren() but resolving is the default.
    owner = root
      .children()
      .find(
        (o) =>
          o.type === TYPE_OBJECT &&
          o.subType === OBJECT_SUBTYPE_ENTITY &&
          childOfType(o, TYPE_MEASURE, name) !== undefined,
      );
  } else {
    owner = undefined;
  }

  if (owner !== undefined) {
    const ownerKey = owner.resolutionKey();
    sink.push(
      report,
      ERR_REPORT_FOREIGN_MEASURE,
      label,
      ` lists measure '${item.slice(item.lastIndexOf(CHILD_REF_SEPARATOR) + 1)}', which belongs to ` +
        `'${ownerKey}', not @from '${fromKey}'. All measures of a report come from @from; make a second ` +
        `report over '${ownerKey}'.`,
    );
  } else {
    sink.push(
      report,
      ERR_INVALID_REPORT,
      label,
      `: @measures item '${item}' names no measure of @from '${fromKey}' or of any other entity.`,
    );
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// F1 — relative-date values only on reporting hosts
// ---------------------------------------------------------------------------

/** True for the hosts whose `@filter` may carry a relative-date value. */
function isReportingFilterHost(node: MetaData): boolean {
  return (
    node.type === TYPE_SEGMENT ||
    (node.type === TYPE_MEASURE && node.subType === MEASURE_SUBTYPE_AGGREGATE) ||
    (node.type === TYPE_OBJECT && node.subType === OBJECT_SUBTYPE_REPORT)
  );
}

/**
 * F1 — walk the whole tree and refuse a `{ now: ... }` value in any attr.filter
 * outside a reporting host (a projection @filter, a dataGrid preset, an
 * origin.aggregate/first @filter): those hosts have no lowering for it.
 */
function checkNoRelativeDates(node: MetaData, sink: ErrorSink): void {
  if (!isReportingFilterHost(node)) {
    // ADR-0039: own — only locally declared filters are lowered, and the walk
    // visits every declared node exactly once (an inherited filter is checked
    // where it is declared; origin.* never inherits, ADR-0029).
    for (const attr of node.ownMetaAttrs()) {
      if (attr.subType === ATTR_SUBTYPE_FILTER && filterContainsRelativeValue(attr.value)) {
        sink.push(
          node,
          ERR_BAD_ATTR_FILTER,
          nodeLabel(node),
          `: @${attr.name} uses a relative date ({ now: ... }), which is legal only in the ` +
            `@filter of a segment, measure.aggregate or object.report.`,
        );
      }
    }
  }
  // ADR-0039: own — a tree walk; each declared node is visited once, at its declaration.
  for (const child of node.ownChildren()) checkNoRelativeDates(child, sink);
}
