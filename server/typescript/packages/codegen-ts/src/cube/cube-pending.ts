// FR-044 Plan 4 — the guard for the one piece of reporting vocabulary the Cube mapping does not
// cover yet: a served report's `@spine` (the zero-rows / measure-defaults build). Written without
// it, the report's rollup would lack the rows the spine adds, so the build refuses it, naming the
// report (spec §3 obligation 3: lossless or an error). A sourceless or unserved report stays
// inert, as it is in the view lowering: the caller calls this only for a report it would write.
//
// This module is deleted when `@spine` is mapped (plan Task 10).

import { OBJECT_REPORT_ATTR_SPINE, type MetaObject } from "@metaobjectsdev/metadata";
import { CubeModelError, ERR_CUBE_UNMAPPED_VOCABULARY } from "./cube-errors.js";

/**
 * Refuse a served report that declares `@spine`. `from` is the entity whose cube would hold the
 * report's rollup: leaving it out of the generator's `filter` is the way to proceed.
 */
export function assertReportMapped(report: MetaObject, from: MetaObject): void {
  // ADR-0039: hasAttr() resolves, so an attribute inherited through `extends` counts.
  if (!report.hasAttr(OBJECT_REPORT_ATTR_SPINE)) return;
  throw new CubeModelError(
    ERR_CUBE_UNMAPPED_VOCABULARY,
    `report '${report.resolutionKey()}' declares @${OBJECT_REPORT_ATTR_SPINE}, which cube-model does not map yet. ` +
      `Written without it, the rollup would lack the rows the spine adds, so the export is refused rather than ` +
      `written wrong. Narrow the generator's filter to leave '${from.resolutionKey()}' out, or remove ` +
      `@${OBJECT_REPORT_ATTR_SPINE} from the report.`,
  );
}
