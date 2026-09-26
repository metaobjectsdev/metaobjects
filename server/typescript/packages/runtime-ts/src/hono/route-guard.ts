/**
 * Per-handler error guard for the Hono mount helpers — the Hono twin of
 * drizzle-fastify's route-scoped error handler (route-error-handler.ts).
 *
 * Hono has no per-route error handler: `app.onError` is app-wide, so installing one from
 * a mount would change how the adopter's OTHER routes answer. Wrapping each handler the
 * mount registers keeps the change to exactly the routes it owns.
 *
 * An unexpected error is logged server-side and answered `500 { "error": "internal" }`.
 * Hono's default would answer a bare-text `Internal Server Error` — no leak, but not the
 * contract's JSON envelope, and different from the Fastify flavor this adapter promises
 * to match on the wire. An `HTTPException` (anything carrying `getResponse`) was thrown
 * on purpose and is rethrown to the adopter's `onError` / Hono's default untouched.
 */

import type { Context } from "hono";
import {
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_INTERNAL,
  INTERNAL_ERROR_BODY,
  INVALID_JSON_BODY,
  logUnexpectedError,
} from "../route-errors.js";

type RouteHandler = (c: Context) => Promise<Response> | Response;

function isHttpException(err: unknown): boolean {
  return typeof (err as { getResponse?: unknown } | null)?.getResponse === "function";
}

export function guardRoute(handler: RouteHandler): RouteHandler {
  return async (c: Context) => {
    try {
      return await handler(c);
    } catch (err) {
      if (isHttpException(err)) throw err;
      logUnexpectedError(err);
      return c.json(INTERNAL_ERROR_BODY, HTTP_STATUS_INTERNAL);
    }
  };
}

/** The outcome of reading a JSON request body: the value, or the 400 to answer. */
export type JsonBodyRead = { ok: true; body: unknown } | { ok: false; response: Response };

/**
 * Read the request body as JSON. A body that does not parse — including an empty one —
 * answers `400 { "error": "invalid_json" }`, matching the Fastify flavor. Before, the
 * parse failure was swallowed into `undefined` and surfaced as a Zod `validation` error
 * complaining that the body was not an object, which named the wrong problem.
 */
export async function readJsonBody(c: Context): Promise<JsonBodyRead> {
  try {
    return { ok: true, body: await c.req.json() };
  } catch {
    return { ok: false, response: c.json(INVALID_JSON_BODY, HTTP_STATUS_BAD_REQUEST) };
  }
}
