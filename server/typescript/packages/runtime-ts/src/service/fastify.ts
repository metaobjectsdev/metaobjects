// What a generated thin Fastify transport over the service layer imports (ADR-0067 layer 5,
// `meta gen` generator `service-routes`): parse the request, call one service operation, send what
// it answered. Its own entry, beside the store mechanics in `./index.ts`, so the flat routes'
// adapter (`../drizzle-fastify`) and what `meta eject routes` copies of it stay as they were.

import type { FastifyReply } from "fastify";
import type { OpResult } from "./index.js";

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
