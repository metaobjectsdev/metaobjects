// FR-044 Plan 4 — the guard for vocabulary the Cube mapping does not cover yet. A report's
// `@spine` and a measure's `@default` are planned (the zero-rows / measure-defaults plan) and not
// registered. A model that carries either would otherwise be written WRONG without a word: a
// rollup lacking the rows the spine adds, a measure lacking the COALESCE the view applies. So the
// build refuses them, naming the node (spec §3 obligation 3: lossless or an error).
//
// What produces no output stays inert, as it is in the view lowering: a sourceless or unserved
// report, a measure on an entity that gets no cube. The caller decides what is written, so these
// functions are called only for a node that would be.
//
// This module is deleted when that build maps the two attributes (plan Tasks 9 and 10).

import type { MetaMeasure, MetaObject } from "@metaobjectsdev/metadata";
import { CubeModelError, ERR_CUBE_UNMAPPED_VOCABULARY } from "./cube-errors.js";
import { memberKey } from "./cube-members.js";

// Not yet registered: replace both with the metadata constants when the build registers the
// attributes (`@default` on a measure is not the field attribute FIELD_ATTR_DEFAULT names).
/** `@spine` on an `object.report`. */
export const PENDING_REPORT_ATTR_SPINE = "spine";
/** `@default` on a `measure.aggregate` or `measure.ratio`. */
export const PENDING_MEASURE_ATTR_DEFAULT = "default";

/**
 * Refuse a served report that declares `@spine`. `from` is the entity whose cube would hold the
 * report's rollup: leaving it out of the generator's `filter` is the way to proceed.
 */
export function assertReportMapped(report: MetaObject, from: MetaObject): void {
  // ADR-0039: hasAttr() resolves, so an attribute inherited through `extends` counts.
  if (!report.hasAttr(PENDING_REPORT_ATTR_SPINE)) return;
  throw new CubeModelError(
    ERR_CUBE_UNMAPPED_VOCABULARY,
    `report '${report.resolutionKey()}' declares @${PENDING_REPORT_ATTR_SPINE}, which cube-model does not map yet ` +
      `(it arrives with the zero-rows/measure-defaults build). Written without it, the rollup would lack the rows ` +
      `the spine adds, so the export is refused rather than written wrong. Narrow the generator's filter to leave ` +
      `'${from.resolutionKey()}' out, or remove @${PENDING_REPORT_ATTR_SPINE} from the report.`,
  );
}

/**
 * Refuse a measure, about to be written on `cube`, that declares `@default`. A measure.aggregate
 * and a measure.ratio are the two it is planned for.
 */
export function assertMeasureMapped(measure: MetaMeasure, cube: string, entity: MetaObject): void {
  // ADR-0039: hasAttr() resolves, so an attribute inherited through `extends` counts.
  if (!measure.hasAttr(PENDING_MEASURE_ATTR_DEFAULT)) return;
  throw new CubeModelError(
    ERR_CUBE_UNMAPPED_VOCABULARY,
    `cube '${cube}': ${measure.type}.${measure.subType} '${memberKey(measure)}' declares @${PENDING_MEASURE_ATTR_DEFAULT}, ` +
      `which cube-model does not map yet (it arrives with the zero-rows/measure-defaults build). Written without it, ` +
      `the Cube measure would read null where the report view reads the default, so the export is refused rather ` +
      `than written wrong. Narrow the generator's filter to leave '${entity.resolutionKey()}' out, or remove ` +
      `@${PENDING_MEASURE_ATTR_DEFAULT} from the measure.`,
  );
}
