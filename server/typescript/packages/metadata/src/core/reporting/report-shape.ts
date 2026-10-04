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
import { reportDerivedFieldName, reportDimensionItems, reportFrom, reportMeasureNames } from "./report-accessors.js";
import { AGG_AVG, AGG_COUNT, AGG_SUM, GRAIN_HOUR, TYPE_DIMENSION, TYPE_MEASURE, type TimeGrain } from "./reporting-constants.js";

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

/** Resolve a dimension's or measure's `Entity.field` reference to the field node. */
export function resolveReportingFieldRef(ref: string, owner: MetaObject, root: MetaRoot): MetaField | undefined {
  // `Entity.field`; a package qualifier uses `::`, so the member separator is the LAST dot.
  const dot = ref.lastIndexOf(CHILD_REF_SEPARATOR);
  if (dot <= 0) return undefined;
  const entity = resolveObjectRef(root, ref.slice(0, dot), packageOfKey(owner.resolutionKey())).node;
  if (!isMetaObject(entity)) return undefined;
  // ADR-0039: resolving, so a field inherited through extends is found.
  return entity.fields().find((f) => f.name === ref.slice(dot + 1));
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

function dimensionField(
  item: { name: string; grain?: string },
  from: MetaObject,
  root: MetaRoot,
  reportName: string,
): ReportField {
  const dim = declaredMember(from, TYPE_DIMENSION, item.name, MetaDimension);
  if (dim === undefined) throw unresolved(reportName, `dimension '${item.name}' on '${from.name}'`);
  const of = resolveReportingFieldRef(dim.of() ?? "", from, root);
  if (of === undefined) throw unresolved(reportName, `dimension '${item.name}' @of`);
  const name = reportDerivedFieldName(item);
  const required = dim.via() === undefined && of.attr(FIELD_ATTR_REQUIRED) === true;
  if (dim.isTime()) {
    const grain = item.grain as TimeGrain;
    if (grain === GRAIN_HOUR) {
      return { name, role: "dimension", subType: FIELD_SUBTYPE_TIMESTAMP, required, typeSource: of, dimension: dim, grain };
    }
    return { name, role: "dimension", subType: FIELD_SUBTYPE_DATE, required, dimension: dim, grain };
  }
  return { name, role: "dimension", subType: of.subType, required, typeSource: of, dimension: dim };
}

function measureField(name: string, from: MetaObject, root: MetaRoot, reportName: string): ReportField {
  const m = declaredMember(from, TYPE_MEASURE, name, MetaMeasure);
  if (m === undefined) throw unresolved(reportName, `measure '${name}' on '${from.name}'`);
  if (m.isRatio()) {
    return { name, role: "measure", subType: FIELD_SUBTYPE_DECIMAL, required: false, measure: m };
  }
  const agg = m.agg();
  if (agg === AGG_COUNT) {
    return { name, role: "measure", subType: FIELD_SUBTYPE_LONG, required: true, measure: m };
  }
  const of = resolveReportingFieldRef(m.ofColumns()[0] ?? "", from, root);
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
    ...reportMeasureNames(report).map((name) => measureField(name, from, root, report.name)),
  ];
  return { report, from, fields };
}
