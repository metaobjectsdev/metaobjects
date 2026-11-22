// What a generated thin Hono transport over the service layer imports (ADR-0067 layer 5,
// `meta gen` generator `service-routes-hono`): read the request, call one service operation, send
// what it answered. The Hono twin of `./fastify.ts`, and its own entry, so a Hono app does not
// import Fastify and the flat routes' adapter (`../hono`) stays as it was.

import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { OpResult } from "./index.js";
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
