/**
 * The route-level Fastify error handler every mount helper installs on the routes IT
 * mounts (drizzle-fastify and the ObjectManager fastify adapter share it).
 *
 * Why route-level: Fastify's `errorHandler` route option is scoped to exactly that route
 * (it overrides the scope's `setErrorHandler` for requests to it, and nothing else). A
 * `setErrorHandler` call from inside a mount would instead change how every OTHER route
 * in the adopter's scope answers — and the generated route files hand the mounts a plain
 * plugin instance, so the helpers cannot know how wide that scope is. A scoped content-type
 * parser was the other option; it would fix only the malformed-body half and would replace
 * the adopter's own JSON parser for the whole scope.
 *
 * What it answers:
 *  - a body Fastify's JSON parser refused → `400 { "error": "invalid_json" }`;
 *  - any other deliberate 4xx (an auth hook's 401, schema validation, 413, 415) → rethrown,
 *    so the enclosing scope's handler — the adopter's, or Fastify's default — answers it
 *    exactly as it did before the mount existed;
 *  - anything else → logged server-side, then `500 { "error": "internal" }`, with no SQL,
 *    table, column or parameter in the body.
 *
 * An adopter who passes `routeOptions.errorHandler` keeps it: theirs wins, untouched.
 */

import type { FastifyReply, FastifyRequest, RouteShorthandOptions } from "fastify";
import {
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_INTERNAL,
  INTERNAL_ERROR_BODY,
  INVALID_JSON_BODY,
  isDeliberateClientError,
  isMalformedJsonBodyError,
  logUnexpectedError,
} from "../route-errors.js";

export function contractRouteErrorHandler(
  error: unknown,
  _request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (isMalformedJsonBodyError(error)) {
    return reply.code(HTTP_STATUS_BAD_REQUEST).send(INVALID_JSON_BODY);
  }
  // Throwing from a route-level handler hands the error to the enclosing scope's handler.
  if (isDeliberateClientError(error)) throw error;
  logUnexpectedError(error);
  return reply.code(HTTP_STATUS_INTERNAL).send(INTERNAL_ERROR_BODY);
}

/** Methods that carry no request body in the contract. Fastify already skips parsing for
 *  GET and HEAD, but it parses a DELETE body like a POST one. */
const BODYLESS_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "DELETE"]);

/**
 * `onRequest` hook: on a bodyless method whose body is EMPTY, drop a declared
 * `content-type` so Fastify has nothing to parse.
 *
 * Many HTTP clients send `content-type: application/json` on every request. Fastify's JSON
 * parser refuses an empty body declared as JSON (`FST_ERR_CTP_EMPTY_JSON_BODY`), which the
 * handler above answers as `invalid_json` — so `DELETE /rentals/3` with that header and no
 * body was a 400. With no content-type and no body, Fastify skips parsing and the route
 * runs. A DELETE that DOES carry bytes is parsed as before, and POST/PUT/PATCH are never
 * touched: an empty body there is still `invalid_json`.
 */
export function acceptEmptyBodyOnBodylessMethod(
  request: FastifyRequest,
  _reply: FastifyReply,
  done: () => void,
): void {
  const headers = request.raw.headers;
  if (
    BODYLESS_METHODS.has(request.method) &&
    headers["content-type"] !== undefined &&
    headers["transfer-encoding"] === undefined &&
    (headers["content-length"] === undefined || headers["content-length"] === "0")
  ) {
    delete headers["content-type"];
  }
  done();
}

/**
 * The adopter's route options plus the contract error handler — unless they set their own —
 * and the empty-body hook above, ahead of any `onRequest` hooks the adopter passed.
 */
export function withContractErrorHandler(ro: RouteShorthandOptions | undefined): RouteShorthandOptions {
  const base = ro ?? {};
  const adopterHooks = base.onRequest === undefined ? [] : Array.isArray(base.onRequest) ? base.onRequest : [base.onRequest];
  const withHook: RouteShorthandOptions = { ...base, onRequest: [acceptEmptyBodyOnBodylessMethod, ...adopterHooks] };
  if (base.errorHandler !== undefined) return withHook;
  return { ...withHook, errorHandler: contractRouteErrorHandler };
}
