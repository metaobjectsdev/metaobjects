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
// customize:     which reports get a module (`filter`); the column list and the exported shape
//                (`exportColumns`, `renderReportExportModule`); the writers' text (`renderExportWriters`);
//                the options `maxRows`, `xmlNulls`, `csvBom`. Whatever you change, keep the module's
//                `{ maxRows, csv, xml }` shape: it is what the mount takes.
// composes-with: routes.ts / routes-hono.ts, which import the per-report module when this generator is
//                in the same target (the `emitsReportExport` marker below is how they know).
import {
  GENERATED_EDIT_NOTE,
  GENERATED_HEADER,
  effectivePackage,
  entityOutputPath,
  formatTs,
  isCredentialField,
  isReport,
  relativeModuleSpecifier,
  type EmittedFile,
  type ExtStyle,
  type GenContext,
  type Generator,
  type ResolvedTarget,
} from "@metaobjectsdev/codegen-ts/engine";
import type { MetaObject } from "@metaobjectsdev/metadata";

/** Default export cap (rows), the same in every port. */
export const DEFAULT_EXPORT_MAX_ROWS = 100_000;
/** How a null is written in XML: `"empty"` an empty element, `"nil"` an `xsi:nil="true"` one. */
export type XmlNulls = "empty" | "nil";
/** TypeScript's default: no XML standard exists to follow, and an empty element is what the CSV cell is. */
export const DEFAULT_XML_NULLS: XmlNulls = "empty";

/** The shared writer module's basename (flat in the target root, the way `enums.ts` is). */
export const EXPORT_WRITERS_BASENAME = "report-export-writers";

/** Field subtypes whose cells are text a spreadsheet could read as a formula. */
const GUARDED_SUBTYPES: ReadonlySet<string> = new Set(["string", "enum", "uri"]);

export interface ReportExportEmitOpts {
  readonly maxRows: number;
  readonly xmlNulls: XmlNulls;
  readonly csvBom: boolean;
}

/** The shared module: CSV quoting and BOM, the formula-injection guard, XML escaping and the root/row writer. */
export function renderExportWriters(opts: ReportExportEmitOpts): string {
  return `// ${GENERATED_HEADER} — ${GENERATED_EDIT_NOTE}
// Shared writers for the report-export generator: one module per project, used by every
// <Report>.export module. It imports nothing.

/** Write a UTF-8 byte order mark before the first CSV record. Flip to \`true\` for Excel on Windows. */
export const EXPORT_CSV_BOM = ${opts.csvBom};

/** How XML writes a null: "empty" is an empty element, "nil" an empty element with xsi:nil="true". */
export const EXPORT_XML_NULLS: "empty" | "nil" = ${JSON.stringify(opts.xmlNulls)};

export const XSI_NAMESPACE = "http://www.w3.org/2001/XMLSchema-instance";

/** One exported field of a report, in derived-field order. \`guard\` is true for string-valued cells. */
export interface ExportColumn {
  readonly name: string;
  readonly guard: boolean;
}

export type ExportRow = Readonly<Record<string, unknown>>;

/** A cell's text: null is empty, a boolean is true/false, a number its digits, anything structured its JSON. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

const FORMULA_START = /^[=+\\-@\\t\\r]/;

/**
 * One CSV cell. A string-valued cell starting with = + - @ TAB or CR is prefixed with an
 * apostrophe (the render escapers' rule), then any cell holding a quote, comma, CR or LF is
 * quoted with embedded quotes doubled.
 */
export function csvCell(text: string, guard: boolean): string {
  const guarded = guard && FORMULA_START.test(text) ? "'" + text : text;
  return /[",\\r\\n]/.test(guarded) ? '"' + guarded.replaceAll('"', '""') + '"' : guarded;
}

/** RFC 4180: CRLF after every record including the last, a header row of the field names. */
export function writeCsv(columns: readonly ExportColumn[], rows: readonly ExportRow[]): string {
  let out = EXPORT_CSV_BOM ? "\\uFEFF" : "";
  out += columns.map((c) => csvCell(c.name, false)).join(",") + "\\r\\n";
  for (const row of rows) {
    out +=
      columns
        .map((c) => {
          const value = row[c.name];
          return csvCell(cellText(value), c.guard && typeof value === "string");
        })
        .join(",") + "\\r\\n";
  }
  return out;
}

// Characters XML 1.0 cannot carry at all are replaced; CR is written as a reference so it survives parsing.
const XML_FORBIDDEN = /[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\uFFFE\\uFFFF]/g;

/** Text and attribute content: & < > escaped, CR as a reference. There is no injection guard in XML. */
export function xmlText(text: string): string {
  return text
    .replace(XML_FORBIDDEN, "\\uFFFD")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\\r", "&#13;");
}

/** <Root><row><field>value</field>...</row>...</Root>, no declaration, no indentation. */
export function writeXml(root: string, columns: readonly ExportColumn[], rows: readonly ExportRow[]): string {
  const nil = EXPORT_XML_NULLS === "nil";
  const open = nil ? root + ' xmlns:xsi="' + XSI_NAMESPACE + '"' : root;
  if (rows.length === 0) return "<" + open + "/>";
  let out = "<" + open + ">";
  for (const row of rows) {
    out += "<row>";
    for (const c of columns) {
      const text = cellText(row[c.name]);
      const isNull = row[c.name] === null || row[c.name] === undefined;
      if (isNull && nil) out += "<" + c.name + ' xsi:nil="true"/>';
      else if (text === "") out += "<" + c.name + "/>";
      else out += "<" + c.name + ">" + xmlText(text) + "</" + c.name + ">";
    }
    out += "</row>";
  }
  return out + "</" + root + ">";
}
`;
}

/**
 * The report's exported fields, in derived-field order (the read model's declared order). A
 * credential (#484) is not a column: the list route never returns it, and an export names none.
 */
export function exportColumns(report: MetaObject): { name: string; guard: boolean }[] {
  return report.fields().filter((f) => !isCredentialField(f)).map((f) => ({ name: f.name, guard: GUARDED_SUBTYPES.has(f.subType) }));
}

/** The per-report module: its column list and the CSV and XML writers, in the shape a mount takes. */
export function renderReportExportModule(
  report: MetaObject,
  site: { selfTarget: ResolvedTarget; pkg: string | undefined; extStyle: ExtStyle },
  opts: ReportExportEmitOpts,
): string {
  const shared = relativeModuleSpecifier(
    site.selfTarget.outputLayout, site.pkg, `./${EXPORT_WRITERS_BASENAME}`, site.extStyle,
  );
  const columns = exportColumns(report)
    .map((c) => `  { name: ${JSON.stringify(c.name)}, guard: ${c.guard} },`)
    .join("\n");
  const id = exportConstName(report.name);
  return `// ${GENERATED_HEADER} — ${GENERATED_EDIT_NOTE}
// Source metadata: ${report.name} (${report.fqn()})
import { writeCsv, writeXml, type ExportColumn, type ExportRow } from ${JSON.stringify(shared)};

/** ${report.name}'s fields in derived-field order (dimensions, then measures). */
export const ${id}Columns: readonly ExportColumn[] = [
${columns}
];

/** What the report's list route mounts to answer \`?format=csv|json|xml\`. */
export const ${id} = {
  maxRows: ${opts.maxRows},
  csv: (rows: readonly ExportRow[]): string => writeCsv(${id}Columns, rows),
  xml: (rows: readonly ExportRow[]): string => writeXml(${JSON.stringify(report.name)}, ${id}Columns, rows),
};
`;
}

/** The exported spec's identifier for a report, `<Report>Export`. */
export function exportConstName(reportName: string): string {
  return `${reportName}Export`;
}

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
