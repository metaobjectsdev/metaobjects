/**
 * Map a database constraint violation to a wire response — WITHOUT echoing the query.
 *
 * A generated CRUD route had no try/catch around its write, so a driver error reached
 * Fastify's default handler and came back to the caller as:
 *
 *     HTTP/1.1 500 Internal Server Error
 *     {"statusCode":500,"error":"Internal Server Error","message":"Failed query: insert into
 *      \"tickets\" (\"id\",\"customer_id\",…) values (null, ?, ?, ?, ?, null, ?) returning …
 *      \nparams: 999,x,y,OPEN,2026-08-29T02:40:44.804Z"}
 *
 * Two problems, and the second is the serious one:
 *
 *  1. **Wrong status.** A client-supplied foreign key that does not exist is a client
 *     error. The `identity.reference` that declares the constraint is the same metadata
 *     the route already uses to reject bad enum members and missing required fields — it
 *     just never translated the one constraint the database enforces.
 *  2. **The response body carried the SQL and the BOUND PARAMETER VALUES.** Here that is
 *     harmless; on a POST whose columns hold PII, a token, or an address, it is that data
 *     reflected back to an unauthenticated caller, out of generated code the adopter never
 *     wrote and is not prompted to review.
 *
 * Scope kept deliberately narrow: `docs/features/api-contract.md` states the `error` code
 * vocabulary is not a hard cross-port invariant beyond `not_found` and the filter-parser
 * codes, so this introduces ONE code (`constraint_violation`) with the offending
 * constraint KIND, rather than inventing a taxonomy the other four ports would then have
 * to match. An unrecognised error is still a 500 — but a 500 whose body says nothing about
 * the query, with the real error left to the server log where it belongs.
 */

/** The constraint kinds worth telling a client apart. */
export type ConstraintKind = "foreign_key" | "unique" | "check" | "not_null";

export interface ConstraintFailure {
  /** HTTP status for this failure. */
  status: number;
  /** Response body — never contains SQL, parameters, or driver text. */
  body: { error: string; constraint?: ConstraintKind };
}

/**
 * Recognise a constraint violation across the drivers this package supports.
 *
 * Matching is on driver error CODES first (SQLite's extended result codes, Postgres's
 * SQLSTATE class 23), falling back to message text only where a driver gives no code.
 * Message text is checked case-insensitively against the constraint NAME vocabulary the
 * engines use, never against user data.
 */
export function classifyConstraintError(err: unknown): ConstraintFailure | undefined {
  // Walk the `cause` chain. Drizzle wraps every driver failure in a `DrizzleQueryError`
  // whose own message is "Failed query: <sql>\nparams: <values>" — the constraint detail
  // is one level down:
  //
  //   DrizzleQueryError: Failed query: insert into "tickets" …
  //     cause: LibsqlError: SQLITE_CONSTRAINT: FOREIGN KEY constraint failed
  //
  // Reading only the top level therefore classified NOTHING and every violation fell to
  // the redacted 500 — which is how the first cut of this function behaved against a real
  // libsql server. Note the code there is the generic `SQLITE_CONSTRAINT`, not the extended
  // `SQLITE_CONSTRAINT_FOREIGNKEY`, so the message text carries the discriminating word.
  const haystack = errorChainText(err);

  // Postgres SQLSTATE 23xxx — integrity constraint violation.
  const kind: ConstraintKind | undefined =
    haystack.includes("23503") ||
    haystack.includes("FOREIGN KEY") ||
    haystack.includes("SQLITE_CONSTRAINT_FOREIGNKEY")   // extended code: no space
      ? "foreign_key"
      : haystack.includes("23505") ||
          haystack.includes("SQLITE_CONSTRAINT_UNIQUE") ||
          haystack.includes("UNIQUE CONSTRAINT")
        ? "unique"
        : haystack.includes("23514") ||
            haystack.includes("SQLITE_CONSTRAINT_CHECK") ||
            haystack.includes("CHECK CONSTRAINT")
          ? "check"
          : haystack.includes("23502") ||
              haystack.includes("SQLITE_CONSTRAINT_NOTNULL") ||
              haystack.includes("NOT NULL")
            ? "not_null"
            : undefined;

  if (kind === undefined) return undefined;

  // 409 for referential/uniqueness conflicts with existing state; 400 for a value the
  // request itself got wrong. Both are client errors — neither is a 500.
  const status = kind === "foreign_key" || kind === "unique" ? 409 : 400;
  return { status, body: { error: "constraint_violation", constraint: kind } };
}

/**
 * Run a write and convert any database failure into a safe response.
 *
 * `onFailure` receives the status + body to send. An UNRECOGNISED error is rethrown as a
 * redacted `Error` after being handed to `logError`, so the operator keeps the full
 * diagnostic and the client gets none of it.
 */
export async function withConstraintMapping<T>(
  write: () => Promise<T>,
  onFailure: (f: ConstraintFailure) => T,
  logError: (err: unknown) => void = (e) => console.error(e),
): Promise<T> {
  try {
    return await write();
  } catch (err) {
    const failure = classifyConstraintError(err);
    if (failure !== undefined) return onFailure(failure);
    // Not a constraint problem — the operator needs the detail, the caller must not have it.
    logError(err);
    throw new RedactedDatabaseError();
  }
}

/**
 * `code` + `message` for an error and everything in its `cause` chain, upper-cased.
 *
 * Depth-bounded (a malformed `cause` can be self-referential) and read defensively: a
 * driver error is whatever the driver decided to throw, not necessarily an `Error`.
 * Only the code and message are read — never a `query` or `params` property, so the
 * matched text can never contain user data.
 */
function errorChainText(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; depth < 8 && typeof cur === "object" && cur !== null; depth++) {
    const o = cur as { code?: unknown; message?: unknown; cause?: unknown };
    if (o.code !== undefined) parts.push(String(o.code));
    if (o.message !== undefined) parts.push(String(o.message));
    if (o.cause === cur) break;
    cur = o.cause;
  }
  return parts.join(" ").toUpperCase();
}

/** Log the operator-facing detail before the caller raises the redacted error. */
export function logAndRedact(err: unknown): void {
  console.error(err);
}

/**
 * Thrown in place of a driver error so the framework's default 500 handler has nothing
 * to leak. The original is logged before this is raised.
 */
export class RedactedDatabaseError extends Error {
  constructor() {
    super("database error");
    this.name = "RedactedDatabaseError";
  }
}
