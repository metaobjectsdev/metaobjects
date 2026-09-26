/**
 * The error envelopes the HTTP mount helpers answer with when a request fails for a
 * reason that is NOT a filter, validation or constraint problem — shared by the
 * drizzle-fastify, fastify (ObjectManager) and hono adapters so they cannot drift.
 *
 * Two defects, both found by a cold review of a generated app:
 *
 *  1. **An unexpected error leaked the query.** With the Drizzle schema out of step with
 *     the database (a renamed column), a list answered Fastify's default 500 —
 *     `{"statusCode":500,…,"message":"Failed query: select \"id\", \"display_name\" …
 *     \nparams: …"}`: the SQL, the table and column names and the bound VALUES, to an
 *     unauthenticated caller. The write paths had already been redacted
 *     (`constraint-errors.ts`); the reads never were. Now every mounted route answers
 *     `500 { "error": "internal" }` — the code the cross-port reference servers already
 *     use — and the detail goes to the server log.
 *  2. **A malformed JSON body bypassed the envelope.** Fastify's content-type parser
 *     answered `{"statusCode":400,"code":"FST_ERR_CTP_INVALID_JSON_BODY",…}`, and the Hono
 *     mount folded it into a Zod `validation` error. Both now answer
 *     `400 { "error": "invalid_json" }`.
 *
 * The api-contract corpus pins neither response (5xx is implementation-defined there, and
 * no scenario sends a malformed body), so both are TS-helper extensions — documented in
 * docs/features/api-contract.md, "TS-only error responses".
 */

import { RedactedDatabaseError, logAndRedact } from "./constraint-errors.js";

/** Wire code for an unexpected server-side failure. Carries no detail, by design. */
export const ERROR_CODE_INTERNAL = "internal";
/** Wire code for a request body that is not parseable JSON. */
export const ERROR_CODE_INVALID_JSON = "invalid_json";

export const HTTP_STATUS_BAD_REQUEST = 400;
export const HTTP_STATUS_INTERNAL = 500;

export interface ErrorEnvelope {
  readonly error: string;
}

export const INTERNAL_ERROR_BODY: ErrorEnvelope = Object.freeze({ error: ERROR_CODE_INTERNAL });

/** Wire code for a request body that failed its schema. */
export const ERROR_CODE_VALIDATION = "validation";

/**
 * The 400 body for a body that failed its Zod schema: every issue as Zod reported it,
 * minus `pattern`. Zod 4 attaches the regex SOURCE to a failed `.regex()` check, and for a
 * generated `field.date` / `field.timestamp` check that is a ~300-character calendar regex
 * (an authored `validator.regex` pattern is likewise the server's own business). The
 * issue's `message` already names the expected format. Shared by every mount.
 */
export function validationErrorBody<T extends object>(
  issues: readonly T[],
): { readonly error: string; readonly issues: Omit<T, "pattern">[] } {
  return {
    error: ERROR_CODE_VALIDATION,
    issues: issues.map((issue) => {
      const { pattern: _pattern, ...rest } = issue as T & { pattern?: unknown };
      return rest;
    }),
  };
}
export const INVALID_JSON_BODY: ErrorEnvelope = Object.freeze({ error: ERROR_CODE_INVALID_JSON });

/**
 * Fastify's error codes for a body its JSON parser refused: syntactically invalid, and
 * empty-while-declared-JSON. Both are the caller sending something that is not JSON.
 */
const FASTIFY_MALFORMED_JSON_CODES: ReadonlySet<string> = new Set([
  "FST_ERR_CTP_INVALID_JSON_BODY",
  "FST_ERR_CTP_EMPTY_JSON_BODY",
]);

/** True for Fastify's "the body is not valid JSON" errors. */
export function isMalformedJsonBodyError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && FASTIFY_MALFORMED_JSON_CODES.has(code);
}

/**
 * True when the error deliberately carries a CLIENT status (4xx) — an auth hook's 401, a
 * schema-validation 400, a 413 for an oversized body. Those were raised on purpose by the
 * adopter or the framework and are theirs to answer; the mount helpers only take over the
 * errors nobody meant to send.
 */
export function isDeliberateClientError(err: unknown): boolean {
  const o = err as { statusCode?: unknown; status?: unknown } | null;
  const status = typeof o?.statusCode === "number" ? o.statusCode : o?.status;
  return typeof status === "number" && status >= 400 && status < 500;
}

/**
 * Log an unexpected error server-side, exactly once. A `RedactedDatabaseError` was
 * already logged by the write path that raised it (it carries no detail of its own).
 */
export function logUnexpectedError(err: unknown): void {
  if (err instanceof RedactedDatabaseError) return;
  logAndRedact(err);
}
