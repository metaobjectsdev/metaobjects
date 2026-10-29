// Report export emit (api-contract.md, "Report export"): the shared writer module (one per
// project) and the per-report `<Report>.export.ts` module. Plain string emission, no ts-poet:
// the shared module imports nothing, and the per-report module imports only the shared one.
//
// The writers consume the list route's wire-form rows (what `JSON.stringify` of the list answer
// holds), so a value's wire form (currency minor units, `YYYY-MM-DD`, decimals per the project
// `wire` setting, booleans) is already decided by the route; the writers only spell it.

import type { MetaObject } from "@metaobjectsdev/metadata";
import { isCredentialField } from "../api-surface.js";
import { GENERATED_HEADER, GENERATED_EDIT_NOTE } from "../constants.js";
import { relativeModuleSpecifier, type ResolvedTarget } from "../import-path.js";
import type { ExtStyle } from "../render-context.js";

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
