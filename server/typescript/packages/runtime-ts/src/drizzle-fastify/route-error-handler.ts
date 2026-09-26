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

/** The adopter's route options plus the contract error handler — unless they set their own. */
export function withContractErrorHandler(ro: RouteShorthandOptions | undefined): RouteShorthandOptions {
  const base = ro ?? {};
  if (base.errorHandler !== undefined) return base;
  return { ...base, errorHandler: contractRouteErrorHandler };
}
