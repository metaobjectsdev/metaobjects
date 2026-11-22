// What a generated thin Fastify transport over the service layer imports (ADR-0067 layer 5,
// `meta gen` generator `service-routes`): parse the request, call one service operation, send what
// it answered. Its own entry, beside the store mechanics in `./index.ts`, so the flat routes'
// adapter (`../drizzle-fastify`) and what `meta eject routes` copies of it stay as they were.

import type { FastifyReply } from "fastify";
import type { OpResult, ReadOnlyPage } from "./index.js";
import { EXPORT_CONTENT_TYPES, exportContentDisposition, renderExport, type ReportExportSpec } from "../drizzle-fastify/report-export.js";

export { withContractErrorHandler } from "../drizzle-fastify/route-error-handler.js";
export { parseListQueryString, rawQueryOf } from "../drizzle-fastify/list-query.js";

/**
 * Send `result` on `reply`: a failure with the status the service gave it and its body as is, a
 * success with `okStatus` and the value mapped to the wire by `toWire` (absent, sent as is).
 * `okStatus` 204 sends no body.
 */
export function sendOpResult<T>(
  reply: FastifyReply,
  result: OpResult<T>,
  okStatus = 200,
  toWire?: (value: T) => unknown,
): FastifyReply {
  if (!result.ok) return reply.code(result.status).send(result.error);
  if (okStatus === 204) return reply.code(204).send();
  return reply.code(okStatus).send(toWire === undefined ? result.value : toWire(result.value));
}

/** The body a read-only object answers a write with: `405 { "error": "method_not_allowed" }`. */
export function methodNotAllowed(method: string, resource: "projection" | "report"): { error: string; message: string } {
  return { error: "method_not_allowed", message: `${method} is not supported on a ${resource} (read-only).` };
}

/**
 * Send a read-only list page: the rows mapped to the wire, as a `{ rows, total }` envelope when
 * the count was asked for; with an export spec and an export format asked (`?format=`), the rows
 * rendered in that format as a download named after `path`'s last segment.
 */
export function sendListPage<T>(
  reply: FastifyReply,
  result: OpResult<ReadOnlyPage<T>>,
  toWire: (row: T) => unknown,
  exportOf?: { readonly spec: ReportExportSpec; readonly path: string },
): FastifyReply {
  if (!result.ok) return reply.code(result.status).send(result.error);
  const page = result.value;
  const rows = page.rows.map(toWire);
  if (exportOf !== undefined && page.format !== undefined) {
    // Rendered before any header is set, so a writer that throws leaves no download headers on
    // the 500. A Buffer, so Fastify sends the contract's content type exactly.
    const body = Buffer.from(renderExport(exportOf.spec, page.format, rows as Record<string, unknown>[], page.total), "utf8");
    return reply
      .header("content-disposition", exportContentDisposition(exportOf.path, page.format))
      .header("content-type", EXPORT_CONTENT_TYPES[page.format])
      .send(body);
  }
  return reply.send(page.total === undefined ? rows : { rows, total: page.total });
}
