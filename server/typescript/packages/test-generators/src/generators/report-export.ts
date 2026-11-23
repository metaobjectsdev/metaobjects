// REFERENCE TEMPLATE — copy this into your repo (e.g. codegen/generators/report-export.ts) and own it.
// Then import it LOCALLY in metaobjects.config.ts:
//   import { reportExport } from "./codegen/generators/report-export.js";
//
// RUNTIME: this file executes under whatever runs `meta gen`, and the published CLI's
// shebang is `#!/usr/bin/env node` — so it runs under NODE even in a Bun project. Do not
// reach for `Bun.*` globals here; they are undefined and take the whole run down with
// `Bun is not defined`. Use `node:` builtins instead.
// targets:       The HTTP routes `routes` / `routes-hono` emit for a served `object.report`. The emitted
//                modules import nothing but each other; the route file hands the per-report module to
//                the `mountReadOnlyCrudRoutes` helper (`export:` option), which owns the `?format=`
//                parsing, the 400 envelopes, the row cap and the Content-Disposition header.
// use-when:      a served report should be downloadable: `GET /<report>?format=csv|json|xml`. Wiring
//                this generator is what switches the `format` branch on; a project that wires none
//                gets report routes byte-identical to before export existed.
// emits:         <target>/<Report>.export.ts per served report (under outputLayout: "package",
//                <target>/<pkg>/<Report>.export.ts), and ONE <target>/report-export-writers.ts (the CSV
//                quoting and formula-injection guard, the XML escaping and root/row writer, and the
//                EXPORT_CSV_BOM and EXPORT_XML_NULLS constants).
// customize:     which reports get a module (`filter`) here; the column list and the exported shape
//                (`exportColumns`, `writeReportExportModule`) and the writers' text (`writeExportWriters`)
//                in the copied ../templates/report-export-file.ts;
//                the options `maxRows`, `xmlNulls`, `csvBom`. Whatever you change, keep the module's
//                `{ maxRows, csv, xml }` shape: it is what the mount takes.
// composes-with: routes.ts / routes-hono.ts, which import the per-report module when this generator is
//                in the same target (the `emitsReportExport` marker below is how they know).
import {
  effectivePackage,
  DEFAULT_OUTPUT_LAYOUT,
  entityOutputPath,
  isReport,
  type EmittedFile,
  type GenContext,
  type Generator,
} from "@metaobjectsdev/codegen-ts/engine";
import type { MetaObject } from "@metaobjectsdev/metadata";
// The emitted text: `meta eject report-export` copies this module beside the generator.
import {
  DEFAULT_EXPORT_MAX_ROWS,
  DEFAULT_XML_NULLS,
  EXPORT_WRITERS_BASENAME,
  renderExportWriters,
  renderReportExportModule,
  type XmlNulls,
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
      const layout = ctx.config.outputLayout ?? DEFAULT_OUTPUT_LAYOUT;
      const extStyle = ctx.config.extStyle ?? "js";
      const selfTarget = ctx.renderContext?.selfTarget;
      if (selfTarget === undefined) throw new Error("report-export: no render context (run it through runGen).");
      const reports = ctx.entities.filter(ctx.matches).filter(isReport);
      if (reports.length === 0) return [];
      const out: EmittedFile[] = [
        { path: `${EXPORT_WRITERS_BASENAME}.ts`, content: renderExportWriters(emit) },
      ];
      // One module per report `meta gen <Entity>` named; the writers above serve them all.
      for (const report of reports.filter((r) => ctx.selected?.(r) ?? true)) {
        const pkg = effectivePackage(report);
        out.push({
          path: entityOutputPath(layout, pkg, `${report.name}.export.ts`),
          content: renderReportExportModule(report, { selfTarget, pkg, extStyle }, emit),
        });
      }
      return out;
    },
  };
  if (opts?.filter) generator.filter = opts.filter;
  if (opts?.target) generator.target = opts.target;
  return generator;
}
