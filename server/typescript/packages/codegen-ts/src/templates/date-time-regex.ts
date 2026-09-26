// Canonical Zod emission for the calendar/clock subtypes on the WRITE side
// (insert / update / preserving schemas, and a value object's jsonb members).
//
// 1.0.8 emitted a bare `z.string()` for `field.date`, `field.time` and a string-mode
// `field.timestamp`, so a request body of `{"dueDate": "next tuesday"}` validated and
// the text reached the column (SQLite stores it verbatim; Postgres rejects it with a
// 500). These are anchored regexes rather than Zod's own `z.string().date()` /
// `.datetime()` / `z.iso.*`, because those differ between Zod 3 and Zod 4 (`z.iso` is
// Zod-4-only, and `.datetime()` rejects the space-separated spelling the databases
// emit), and the codegen peer range is `zod >=3.23.0 <5`. `.regex()` behaves
// identically on both — the same reasoning as `net-regex.ts`.
//
// SHAPE ONLY, not calendar arithmetic: `2026-02-30` passes (the database is the final
// judge of the day-of-month), but free text, a wrong field order and an out-of-range
// month/day/hour/minute do not.
//
// Every spelling the runtime ITSELF produces must pass, or the check breaks round-trips:
//   - `new Date().toISOString()`       — the @autoSet stamp, and JSON.stringify(Date);
//   - `YYYY-MM-DD HH:MM:SS`            — SQLite CURRENT_TIMESTAMP / CURRENT_TIME text;
//   - `YYYY-MM-DD HH:MM:SS.ffffff+00`  — Postgres string-mode timestamptz output;
//   - `YYYY-MM-DDTHH:MM`               — an `<input type="datetime-local">` value, which
//                                        the generated React form submits;
//   - `HH:MM[:SS[.f]]` (+ an offset)   — Postgres time / timetz, `<input type="time">`.

const TIME_OF_DAY = "(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?";
const UTC_OFFSET = "(?:[Zz]|[+-](?:[01]\\d|2[0-3])(?::?[0-5]\\d)?)?";
const CALENDAR_DATE = "\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])";

/** `field.date` — an ISO calendar date, `YYYY-MM-DD`, and nothing else. */
export const ZOD_DATE_EXPR = `z.string().regex(/^${CALENDAR_DATE}$/)`;

/** `field.time` — a time of day, `HH:MM[:SS[.fraction]]`, optionally zoned. */
export const ZOD_TIME_EXPR = `z.string().regex(/^${TIME_OF_DAY}${UTC_OFFSET}$/)`;

/** `field.timestamp` (string mode) — an ISO 8601 / SQL timestamp: a calendar date,
 *  optionally followed by `T` or a space, a time of day, and a UTC offset. */
export const ZOD_TIMESTAMP_EXPR =
  `z.string().regex(/^${CALENDAR_DATE}(?:[Tt ]${TIME_OF_DAY}${UTC_OFFSET})?$/)`;
