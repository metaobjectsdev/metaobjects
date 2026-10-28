// Report export: the framework-neutral half (api-contract.md, "Report export").
//
// `GET <report-path>?format=csv|json|xml` answers the report list's rows in another shape. This
// module reads the selector, applies the export row cap and builds the three 400 envelopes and the
// Content-Disposition header. It has no framework or database import, so the Fastify and the Hono
// mounts share it, and a future entity export can reuse it. The CSV and XML WRITERS are not here:
// they are generated per project (`report-export` generator) and handed in as a
// {@link ReportExportSpec}, which is how an adopter changes them.
//
// Only a report mount takes the spec, and only when the project wires the `report-export`
// generator; without one a mount has no `format` branch and `?format=` is ignored like any other
// unknown query parameter. Accept headers are never consulted.

import { FilterParseError, ReportTooLargeError, parseReportPage, type ReportPage } from "./list-params.js";

/** Every format the contract names, in the order `invalid_format.expected` lists them. */
export const EXPORT_FORMATS = ["csv", "json", "xml"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** The rows an export writer receives: the list route's JSON-ready (wire-form) rows. */
export type ExportRows = readonly Record<string, unknown>[];

/**
 * What a mount needs to export one report. Generated per report (`<Report>.export.ts`).
 * `json` is always wired (it is the list route's own array); `csv` and `xml` are wired when the
 * spec carries a writer.
 */
export interface ReportExportSpec {
  /** The export row cap (generator option `maxRows`, default 100000). */
  readonly maxRows: number;
  readonly csv?: (rows: ExportRows) => string;
  readonly xml?: (rows: ExportRows) => string;
}

/** The `Content-Type` of each format. */
export const EXPORT_CONTENT_TYPES: Readonly<Record<ExportFormat, string>> = {
  csv: "text/csv; charset=utf-8",
  json: "application/json",
  xml: "application/xml",
};

/** A refused export: `status` is always 400, `body` is the contract envelope. */
export class ReportExportError extends Error {
  readonly status = 400;
  constructor(readonly body: { error: string; [key: string]: unknown }, message: string) {
    super(message);
    this.name = "ReportExportError";
  }
}

/** The formats a spec wires, in contract order. */
export function wiredExportFormats(spec: ReportExportSpec): ExportFormat[] {
  return EXPORT_FORMATS.filter((f) => f === "json" || spec[f] !== undefined);
}

/**
 * The export format a request asks for, or undefined when it names none. Matching is
 * case-sensitive and an empty value, a repeated parameter and a bracketed one are all unknown.
 * Throws `invalid_format` listing the wired formats.
 */
export function readExportFormat(query: Record<string, unknown>, spec: ReportExportSpec): ExportFormat | undefined {
  if (!("format" in query)) return undefined;
  const value = query["format"];
  const wired = wiredExportFormats(spec);
  if (typeof value === "string" && (wired as string[]).includes(value)) return value as ExportFormat;
  throw new ReportExportError(
    { error: "invalid_format", expected: wired },
    `?format= must be one of ${wired.join(", ")}.`,
  );
}

/**
 * Whether `withCount` is set, for the `export_with_count` refusal of a CSV or XML export. Wider
 * than the list route's own flag (`1`): the contract says "truthy", and a client that sends
 * `withCount=true` to a CSV export must be told it cannot have a count rather than silently get
 * the file. The list route's flag is unchanged, and a JSON export reads that one.
 */
export function isExportCountFlag(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "boolean") return v;
  const s = String(v).toLowerCase();
  return s === "1" || s === "true";
}

/** `export_with_count`: a CSV or XML export has no `{ rows, total }` envelope. */
export function exportWithCountError(): ReportExportError {
  return new ReportExportError(
    { error: "export_with_count", message: "withCount cannot be combined with format=csv or format=xml; only JSON carries the { rows, total } envelope." },
    "withCount cannot be combined with format=csv or format=xml.",
  );
}

/** `export_too_large`: refused rather than truncated, before any body is written. */
export function exportTooLargeError(maxRows: number): ReportExportError {
  return new ReportExportError(
    { error: "export_too_large", maxRows },
    `An export is at most ${maxRows} rows; narrow it with a filter or page it with ?limit=.`,
  );
}

/**
 * The page an export reads. An absent `limit` means every row up to `maxRows` (the page fetches
 * one more so exactly `maxRows` can be told from more); an explicit `limit` or `offset` is honoured;
 * a `limit` above `maxRows` is `export_too_large`. A bad bound is the list route's own
 * `pagination.invalid_value`. The export cap replaces the list route's `report_too_large`.
 */
export function parseExportPage(query: Record<string, unknown>, maxRows: number): ReportPage {
  try {
    return parseReportPage(query, maxRows);
  } catch (e) {
    if (e instanceof ReportTooLargeError) throw exportTooLargeError(maxRows);
    throw e;
  }
}

/** Refuse an unbounded export that fetched more than the cap. Call before writing a byte. */
export function assertExportWithinCap(fetchedRows: number, page: ReportPage, maxRows: number): void {
  if (page.unbounded && fetchedRows > maxRows) throw exportTooLargeError(maxRows);
}

/** `attachment; filename="<segment>.<ext>"`, the segment being the route's last path segment. */
export function exportContentDisposition(path: string, format: ExportFormat): string {
  const segment = path.split("/").filter((s) => s !== "").pop() ?? "export";
  return `attachment; filename="${segment}.${format}"`;
}

/**
 * The response body of an export. JSON is the list route's own body, serialized as
 * `JSON.stringify` does: the array, or `{ rows, total }` when the request asked for a count.
 */
export function renderExport(spec: ReportExportSpec, format: ExportFormat, rows: ExportRows, total?: number): string {
  if (format === "json") return JSON.stringify(total === undefined ? rows : { rows, total });
  const write = spec[format];
  if (write === undefined) throw new Error(`report export: no ${format} writer is wired.`);
  return write(rows);
}

export { FilterParseError };
