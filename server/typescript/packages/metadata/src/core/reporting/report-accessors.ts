// Free accessors over an `object.report` node (FR-044). Used by the Plan 2
// lowering and by the loader's report validation, so the `name:grain` parse and
// the derived-field-name rule have exactly one definition.

import type { MetaData } from "../../shared/meta-data.js";
import {
  OBJECT_REPORT_ATTR_DIMENSIONS,
  OBJECT_REPORT_ATTR_FROM,
  OBJECT_REPORT_ATTR_MEASURES,
  OBJECT_REPORT_ATTR_SPINE,
} from "../object/object-constants.js";
import { CHILD_REF_SEPARATOR } from "../../shared/structural.js";
import { REPORT_DIMENSION_GRAIN_SEPARATOR } from "./reporting-constants.js";

export interface ReportDimensionItem {
  readonly name: string;
  readonly grain?: string;
}

function stringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return typeof v === "string" ? [v] : [];
}

/** The `@from` entity name of a report. */
export function reportFrom(obj: MetaData): string | undefined {
  const v = obj.attr(OBJECT_REPORT_ATTR_FROM);
  return typeof v === "string" ? v : undefined;
}

/** `@spine`: the to-one path to the entity whose rows supply the report's rows. */
export function reportSpine(obj: MetaData): string | undefined {
  const v = obj.attr(OBJECT_REPORT_ATTR_SPINE);
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** The `@dimensions` items, each `name` or `name:grain`. */
export function reportDimensionItems(obj: MetaData): ReportDimensionItem[] {
  return stringList(obj.attr(OBJECT_REPORT_ATTR_DIMENSIONS)).map((raw) => {
    const i = raw.indexOf(REPORT_DIMENSION_GRAIN_SEPARATOR);
    return i === -1 ? { name: raw } : { name: raw.slice(0, i), grain: raw.slice(i + 1) };
  });
}

/** The `@measures` items AS WRITTEN: each a bare measure `name`, or a dotted
 *  `Entity.name` (loader rule R3). Use {@link reportMeasureItemName} for the measure name. */
export function reportMeasureNames(obj: MetaData): string[] {
  return stringList(obj.attr(OBJECT_REPORT_ATTR_MEASURES));
}

/**
 * The measure a `@measures` item names: the segment after its LAST `.`
 * (`total`, `Sale.total` and `acme::shop::Sale.total` all name `total`). It is also
 * the derived report field's name. The part before that `.`, when present, is an
 * entity qualifier, which {@link reportMeasureItemOwner} returns.
 */
export function reportMeasureItemName(item: string): string {
  const dot = item.lastIndexOf(CHILD_REF_SEPARATOR);
  return dot === -1 ? item : item.slice(dot + CHILD_REF_SEPARATOR.length);
}

/** The entity qualifier of a dotted `@measures` item (`Sale` in `Sale.total`), or
 *  undefined for a bare item. Loader rule R3: it names `@from` or an entity `@from` extends. */
export function reportMeasureItemOwner(item: string): string | undefined {
  const dot = item.lastIndexOf(CHILD_REF_SEPARATOR);
  return dot === -1 ? undefined : item.slice(0, dot);
}

/** The derived report field for a dimension item: `name` (attribute) or `name` + Capitalized(grain) (time). */
export function reportDerivedFieldName(item: ReportDimensionItem): string {
  if (item.grain === undefined || item.grain === "") return item.name;
  return item.name + item.grain.charAt(0).toUpperCase() + item.grain.slice(1);
}
