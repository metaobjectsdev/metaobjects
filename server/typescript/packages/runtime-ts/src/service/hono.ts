// What a generated thin Hono transport over the service layer imports (ADR-0067 layer 5,
// `meta gen` generator `service-routes-hono`): read the request, call one service operation, send
// what it answered. The Hono twin of `./fastify.ts`, and its own entry, so a Hono app does not
// import Fastify and the flat routes' adapter (`../hono`) stays as it was.

import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { OpResult, ReadOnlyPage } from "./index.js";
import { EXPORT_CONTENT_TYPES, exportContentDisposition, renderExport, type ReportExportSpec } from "../drizzle-fastify/report-export.js";
import { HTTP_STATUS_BAD_REQUEST, INVALID_JSON_BODY } from "../route-errors.js";

export { guardRoute } from "../hono/route-guard.js";
export { parseListQueryString, rawQueryOf } from "../drizzle-fastify/list-query.js";

/** The outcome of reading a request body: the value (undefined when there is none), or the 400 to answer. */
export type BodyRead = { ok: true; body: unknown } | { ok: false; response: Response };

/**
 * Read the request body as the Fastify transport receives it. No body, with no JSON content type,
 * reads as `undefined`, which the service answers as it answers a missing input. A body that does
 * not parse, or an empty one sent as JSON, answers `400 { "error": "invalid_json" }`.
 */
export async function readBody(c: Context): Promise<BodyRead> {
  const text = await c.req.text();
  const json = (c.req.header("content-type") ?? "").toLowerCase().includes("json");
  if (text === "" && !json) return { ok: true, body: undefined };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, response: c.json(INVALID_JSON_BODY, HTTP_STATUS_BAD_REQUEST) };
  }
}

/**
 * Answer `result`: a failure with the status the service gave it and its body as is, a success
 * with `okStatus` and the value mapped to the wire by `toWire` (absent, sent as is). `okStatus`
 * 204 sends no body.
 */
export function sendOpResult<T>(c: Context, result: OpResult<T>, okStatus = 200, toWire?: (value: T) => unknown): Response {
  if (!result.ok) return c.json(result.error, result.status as ContentfulStatusCode);
  if (okStatus === 204) return c.body(null, 204);
  return c.json(toWire === undefined ? result.value : toWire(result.value), okStatus as ContentfulStatusCode);
}

/** Answer a write to a read-only object: `405 { "error": "method_not_allowed" }`. */
export function methodNotAllowed(c: Context, resource: "projection" | "report"): Response {
  return c.json({ error: "method_not_allowed", message: `${c.req.method} is not supported on a ${resource} (read-only).` }, 405);
}

/**
 * Answer a read-only list page: the rows mapped to the wire, as a `{ rows, total }` envelope when
 * the count was asked for; with an export spec and an export format asked (`?format=`), the rows
 * rendered in that format as a download named after `path`'s last segment.
 */
export function sendListPage<T>(
  c: Context,
  result: OpResult<ReadOnlyPage<T>>,
  toWire: (row: T) => unknown,
  exportOf?: { readonly spec: ReportExportSpec; readonly path: string },
): Response {
  if (!result.ok) return c.json(result.error, result.status as ContentfulStatusCode);
  const page = result.value;
  const rows = page.rows.map(toWire);
  if (exportOf !== undefined && page.format !== undefined) {
    const body = renderExport(exportOf.spec, page.format, rows as Record<string, unknown>[], page.total);
    return c.body(body, 200, {
      "content-disposition": exportContentDisposition(exportOf.path, page.format),
      "content-type": EXPORT_CONTENT_TYPES[page.format],
    });
  }
  return c.json(page.total === undefined ? rows : { rows, total: page.total });
}
