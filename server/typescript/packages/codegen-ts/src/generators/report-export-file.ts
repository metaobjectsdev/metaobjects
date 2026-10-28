import type { MetaObject } from "@metaobjectsdev/metadata";
import type { Generator, GenContext, EmittedFile } from "../generator.js";
import { entityOutputPath } from "../import-path.js";
import { effectivePackage } from "../docs-paths.js";
import { formatTs } from "../format.js";
import { isReport } from "../source-detect.js";
import {
  DEFAULT_EXPORT_MAX_ROWS, DEFAULT_XML_NULLS, EXPORT_WRITERS_BASENAME,
  renderExportWriters, renderReportExportModule, type XmlNulls,
} from "../templates/report-export-file.js";

/**
 * `report-export`: the `?format=csv|json|xml` export of a served `object.report`
 * (api-contract.md, "Report export"). Standalone: it is never implied by a library, and it
 * emits nothing a project did not wire it for.
 *
 * Wiring it does two things. It emits one `<Report>.export.ts` per served report plus ONE shared
 * `report-export-writers.ts` per target, and it marks the run (`emitsReportExport`) so the routes
 * generators emit the `format` branch on a report list route and import that module. A project that
 * wires no `report-export` gets routes byte-identical to before export existed.
 *
 * One cap, two names: `maxRows` here is the export cap. With `?format` set it governs and the list
 * route's `reportMaxRows` (`report_too_large`) never answers; without `?format` the list route's own
 * cap is untouched.
 */
export interface ReportExportOpts {
  /** The most rows an export answers; more is `400 export_too_large`, never a truncation. Default 100000. */
  maxRows?: number;
  /**
   * How XML writes a null: `"empty"` an empty element (the default: TypeScript has no XML standard of
   * its own, and an empty element is what a null is in CSV), `"nil"` an empty element carrying
   * `xsi:nil="true"` with `xmlns:xsi` declared on the root. Becomes a generated constant.
   */
  xmlNulls?: XmlNulls;
  /** Write a UTF-8 byte order mark before the first CSV record (Excel on Windows). Default false. Becomes `EXPORT_CSV_BOM`. */
  csvBom?: boolean;
  filter?: (entity: MetaObject) => boolean;
  target?: string;
}

export function reportExport(opts?: ReportExportOpts): Generator {
  const emit = {
    maxRows: opts?.maxRows ?? DEFAULT_EXPORT_MAX_ROWS,
    xmlNulls: opts?.xmlNulls ?? DEFAULT_XML_NULLS,
    csvBom: opts?.csvBom ?? false,
  };
  if (!Number.isInteger(emit.maxRows) || emit.maxRows < 1) {
    throw new Error(`report-export: maxRows must be an integer of at least 1, got ${String(opts?.maxRows)}.`);
  }
  const generator: Generator = {
    name: "report-export",
    emitsReportExport: true,
    generate: async (ctx: GenContext): Promise<EmittedFile[]> => {
      const layout = ctx.config.outputLayout ?? "flat";
      const extStyle = ctx.config.extStyle ?? "js";
      const selfTarget = ctx.renderContext?.selfTarget;
      if (selfTarget === undefined) throw new Error("report-export: no render context (run it through runGen).");
      const reports = ctx.entities.filter(ctx.matches).filter(isReport);
      if (reports.length === 0) return [];
      const out: EmittedFile[] = [
        { path: `${EXPORT_WRITERS_BASENAME}.ts`, content: await formatTs(renderExportWriters(emit)) },
      ];
      for (const report of reports) {
        const pkg = effectivePackage(report);
        out.push({
          path: entityOutputPath(layout, pkg, `${report.name}.export.ts`),
          content: await formatTs(renderReportExportModule(report, { selfTarget, pkg, extStyle }, emit)),
        });
      }
      return out;
    },
  };
  if (opts?.filter) generator.filter = opts.filter;
  if (opts?.target) generator.target = opts.target;
  return generator;
}
