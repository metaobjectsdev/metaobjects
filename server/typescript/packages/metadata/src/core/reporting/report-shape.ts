// Table B of docs/superpowers/plans/2026-10-03-fr-044-plan-2-report-view-lowering.md:
// a report's derived fields. The single definition; every port has a rule-for-rule copy,
// gated by fixtures/persistence-conformance/report-shapes.json.

import type { MetaData } from "../../shared/meta-data.js";
import type { MetaRoot } from "../../shared/meta-root.js";
import { isMetaObject } from "../../shared/node-guards.js";
import { resolveObjectRef } from "../../naming-refs.js";
import { CHILD_REF_SEPARATOR, PACKAGE_SEPARATOR } from "../../shared/structural.js";
import type { MetaObject } from "../object/meta-object.js";
import type { MetaField } from "../field/meta-field.js";
import {
  FIELD_ATTR_REQUIRED,
  FIELD_SUBTYPE_CURRENCY,
  FIELD_SUBTYPE_DATE,
  FIELD_SUBTYPE_DECIMAL,
  FIELD_SUBTYPE_DOUBLE,
  FIELD_SUBTYPE_FLOAT,
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_LONG,
  FIELD_SUBTYPE_TIMESTAMP,
} from "../field/field-constants.js";
import { MetaDimension } from "./meta-dimension.js";
import { MetaMeasure } from "./meta-measure.js";
import {
  reportDerivedFieldName,
  reportDimensionItems,
  reportFrom,
  reportMeasureItemName,
  reportMeasureItemOwner,
  reportMeasureNames,
} from "./report-accessors.js";
import {
  AGG_AVG,
  AGG_COUNT,
  AGG_SUM,
  GRAIN_HOUR,
  TIME_GRAINS,
  TYPE_DIMENSION,
  TYPE_MEASURE,
  type TimeGrain,
} from "./reporting-constants.js";

export type ReportFieldRole = "dimension" | "measure";

export interface ReportField {
  readonly name: string;
  readonly role: ReportFieldRole;
  /** A field subtype name (FIELD_SUBTYPE_*). */
  readonly subType: string;
  readonly required: boolean;
  /** The `@of` field whose type-shaping attrs this field carries (Table B). */
  readonly typeSource?: MetaField;
  readonly dimension?: MetaDimension;
  readonly grain?: TimeGrain;
  readonly measure?: MetaMeasure;
}

export interface ReportShape {
  readonly report: MetaObject;
  readonly from: MetaObject;
  readonly fields: readonly ReportField[];
}

const SUM_LONG: ReadonlySet<string> = new Set([FIELD_SUBTYPE_INT, FIELD_SUBTYPE_LONG]);
const FLOATING: ReadonlySet<string> = new Set([FIELD_SUBTYPE_DOUBLE, FIELD_SUBTYPE_FLOAT]);

/** Effective package of a node, taken from its resolution key ("<pkg>::<Name>"). */
function packageOfKey(key: string): string {
  const i = key.lastIndexOf(PACKAGE_SEPARATOR);
  return i >= 0 ? key.slice(0, i) : "";
}

/** True when `candidate` is `entity` or an entity it extends (the super chain). */
function isSelfOrAncestor(candidate: MetaData, entity: MetaData): boolean {
  const visited = new Set<MetaData>();
  for (let n: MetaData | undefined = entity; n !== undefined && !visited.has(n); n = n.superData) {
    if (n === candidate) return true;
    visited.add(n);
  }
  return false;
}

/**
 * The entity that DECLARES a dimension, measure or segment reached through `from`: the
 * member's parent, which is `from` itself or an entity `from` extends. A bare entity name
 * inside the member (`@of`, `@via`) resolves in THIS entity's package, exactly as the
 * loader's `validateReporting` resolves it (`pkgOf(ctx.declaring)`), never in `from`'s
 * package or the report's.
 */
export function reportingMemberOwner(member: MetaData, from: MetaObject): MetaData {
  return member.parent ?? from;
}

/**
 * Resolve a dimension's or measure's `Entity.field` reference to the field node. The ONE
 * rule, the same as the loader's (`validateReporting` D1 / M1):
 *
 *  1. The entity half resolves relative to the package of `declaring`, the entity that
 *     declares the member ({@link reportingMemberOwner}).
 *  2. With `host` (a measure, or a dimension without `@via`: the reference is about the
 *     `@from` entity's own rows) the named entity must be `host` or an entity it extends,
 *     and the field is read from `host`, so a field `host` redeclares wins.
 *  3. Without `host` (a dimension with `@via`) the field is read from the named entity.
 *
 * Undefined when any step fails.
 */
export function resolveReportingFieldRef(
  ref: string,
  declaring: MetaData,
  root: MetaRoot,
  host?: MetaObject,
): MetaField | undefined {
  // `Entity.field`; a package qualifier uses `::`, so the member separator is the LAST dot.
  const dot = ref.lastIndexOf(CHILD_REF_SEPARATOR);
  if (dot <= 0) return undefined;
  const named = resolveObjectRef(root, ref.slice(0, dot), packageOfKey(declaring.resolutionKey())).node;
  if (!isMetaObject(named)) return undefined;
  if (host !== undefined && !isSelfOrAncestor(named, host)) return undefined;
  // ADR-0039: resolving, so a field inherited through extends is found.
  return (host ?? named).fields().find((f) => f.name === ref.slice(dot + 1));
}

/**
 * The hop names of a dimension's `@via` (`Owner.hop[.hop...]`), read as the loader reads it
 * (`validateReporting` rule D2): `Owner` resolves in the package of `declaring`
 * ({@link reportingMemberOwner}) and must be `from` or an entity `from` extends. The walk
 * itself then starts AT `from`, whichever of the two `Owner` named. Undefined when the
 * reference has no owner, no hop, or an owner that is not `from` or an ancestor of it.
 */
export function reportingViaHops(
  via: string,
  declaring: MetaData,
  from: MetaObject,
  root: MetaRoot,
): string[] | undefined {
  // The owner ends at the first `.` after the last `::` (a package qualifier has no `.`).
  const lastSep = via.lastIndexOf(PACKAGE_SEPARATOR);
  const segStart = lastSep === -1 ? 0 : lastSep + PACKAGE_SEPARATOR.length;
  const dot = via.indexOf(CHILD_REF_SEPARATOR, segStart);
  if (dot <= segStart) return undefined;
  const hops = via.slice(dot + CHILD_REF_SEPARATOR.length).split(CHILD_REF_SEPARATOR);
  if (hops.some((h) => h === "")) return undefined;
  const owner = resolveObjectRef(root, via.slice(0, dot), packageOfKey(declaring.resolutionKey())).node;
  if (owner === undefined || !isSelfOrAncestor(owner, from)) return undefined;
  return hops;
}

function unresolved(reportName: string, what: string): Error {
  return new Error(`report '${reportName}': ${what} does not resolve.`);
}

function declaredMember<T extends MetaData>(
  from: MetaObject,
  type: string,
  name: string,
  cls: new (...args: never[]) => T,
): T | undefined {
  // ADR-0039: resolving children(), so a member declared on an abstract base is found.
  return from.children().find((c): c is T => c.type === type && c.name === name && c instanceof cls);
}

function isTimeGrain(grain: string | undefined): grain is TimeGrain {
  return grain !== undefined && (TIME_GRAINS as readonly string[]).includes(grain);
}

function dimensionField(
  item: { name: string; grain?: string },
  from: MetaObject,
  root: MetaRoot,
  reportName: string,
): ReportField {
  const dim = declaredMember(from, TYPE_DIMENSION, item.name, MetaDimension);
  if (dim === undefined) throw unresolved(reportName, `dimension '${item.name}' on '${from.name}'`);
  const vialess = dim.via() === undefined;
  const of = resolveReportingFieldRef(dim.of() ?? "", reportingMemberOwner(dim, from), root, vialess ? from : undefined);
  if (of === undefined) throw unresolved(reportName, `dimension '${item.name}' @of`);
  const name = reportDerivedFieldName(item);
  const required = vialess && of.attr(FIELD_ATTR_REQUIRED) === true;
  if (dim.isTime()) {
    // Loader rule R2 guarantees a grain from the closed set; a tree built in code does not.
    const grain = item.grain;
    if (!isTimeGrain(grain)) throw unresolved(reportName, `time dimension '${item.name}' grain '${grain ?? ""}'`);
    if (grain === GRAIN_HOUR) {
      return { name, role: "dimension", subType: FIELD_SUBTYPE_TIMESTAMP, required, typeSource: of, dimension: dim, grain };
    }
    return { name, role: "dimension", subType: FIELD_SUBTYPE_DATE, required, dimension: dim, grain };
  }
  return { name, role: "dimension", subType: of.subType, required, typeSource: of, dimension: dim };
}

/**
 * One `@measures` item, bare (`total`) or dotted (`Sale.total`, loader rule R3). The measure
 * is named by the item's last segment and looked up on `from`; a qualifier resolves in the
 * REPORT's package and must be `from` or an entity `from` extends.
 */
function measureField(item: string, report: MetaObject, from: MetaObject, root: MetaRoot): ReportField {
  const reportName = report.name;
  const name = reportMeasureItemName(item);
  const qualifier = reportMeasureItemOwner(item);
  if (qualifier !== undefined) {
    const owner = resolveObjectRef(root, qualifier, packageOfKey(report.resolutionKey())).node;
    if (owner === undefined || !isSelfOrAncestor(owner, from)) {
      throw unresolved(reportName, `measure '${item}' on '${from.name}'`);
    }
  }
  const m = declaredMember(from, TYPE_MEASURE, name, MetaMeasure);
  if (m === undefined) throw unresolved(reportName, `measure '${item}' on '${from.name}'`);
  if (m.isRatio()) {
    return { name, role: "measure", subType: FIELD_SUBTYPE_DECIMAL, required: false, measure: m };
  }
  const agg = m.agg();
  if (agg === AGG_COUNT) {
    return { name, role: "measure", subType: FIELD_SUBTYPE_LONG, required: true, measure: m };
  }
  const of = resolveReportingFieldRef(m.ofColumns()[0] ?? "", reportingMemberOwner(m, from), root, from);
  if (of === undefined) throw unresolved(reportName, `measure '${name}' @of`);
  const src = of.subType;
  if (agg === AGG_SUM) {
    if (src === FIELD_SUBTYPE_CURRENCY) {
      return { name, role: "measure", subType: FIELD_SUBTYPE_CURRENCY, required: false, typeSource: of, measure: m };
    }
    const subType = SUM_LONG.has(src) ? FIELD_SUBTYPE_LONG : FLOATING.has(src) ? FIELD_SUBTYPE_DOUBLE : FIELD_SUBTYPE_DECIMAL;
    return { name, role: "measure", subType, required: false, measure: m };
  }
  if (agg === AGG_AVG) {
    const subType = FLOATING.has(src) ? FIELD_SUBTYPE_DOUBLE : FIELD_SUBTYPE_DECIMAL;
    return { name, role: "measure", subType, required: false, measure: m };
  }
  // min / max keep the source field's type.
  return { name, role: "measure", subType: src, required: false, typeSource: of, measure: m };
}

/** Table B. Throws a plain Error naming the report when a reference does not resolve
 *  (a report that passed `validateReporting` always resolves). */
export function reportShape(report: MetaObject, root: MetaRoot): ReportShape {
  const fromName = reportFrom(report);
  if (fromName === undefined) throw unresolved(report.name, "@from");
  const from = resolveObjectRef(root, fromName, packageOfKey(report.resolutionKey())).node;
  if (!isMetaObject(from)) throw unresolved(report.name, `@from '${fromName}'`);
  const fields = [
    ...reportDimensionItems(report).map((item) => dimensionField(item, from, root, report.name)),
    ...reportMeasureNames(report).map((item) => measureField(item, report, from, root)),
  ];
  return { report, from, fields };
}
