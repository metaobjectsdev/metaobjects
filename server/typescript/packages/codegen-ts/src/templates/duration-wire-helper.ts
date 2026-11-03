// The wire rule for a field.duration, as text a generated model module carries as local code.
// Generated model code imports nothing from MetaObjects, so the rule is emitted, not imported;
// metadata/src/core/field/duration-wire.ts holds the same rule and both are held to
// fixtures/duration-wire/vectors.json (test/duration-wire-helper.test.ts evaluates the text
// emitted here against them).
//
// Canonical: `[-]PT[<h>H][<m>M][<s>[.<f>]S]` — hours never folded into days, zero components left
// out, zero is `PT0S`, at most six fractional digits (truncated toward zero), one leading `-`.
//
// The emitted code counts a span in microseconds as a `bigint`, so it has no limit of its own: a
// span is as long as the stack it is stored in allows. The only limit here is a column's — the
// 64-bit integer a SQLite, D1 or MySQL column holds (refused past it, never wrapped). Postgres's
// interval has its own range, which Postgres enforces. The emitted code calls `BigInt(...)` and
// writes no bigint literal, so it needs the ES2020 `BigInt` global and nothing newer.

import { code, imp, type Code } from "ts-poet";
import { DURATION_PATTERN } from "@metaobjectsdev/metadata";
import type { Dialect } from "../metaobjects-config.js";
import { DURATION_COLUMN_FN } from "../column-mapper.js";

/** The accepted ISO-8601 duration form as a JS regex literal — the metadata's own pattern. */
export const DURATION_REGEX_LITERAL = `/${DURATION_PATTERN}/`;

/** The Zod expression that accepts a field.duration as sent (and as read back): the accepted form. */
export const ZOD_DURATION_EXPR = `z.string().regex(${DURATION_REGEX_LITERAL})`;

export const DURATION_WRITE_HELPER = "durationWrite";

/** The Zod expression of a duration WRITE field: the accepted form, rewritten to the canonical one,
 *  so equal spans are equal strings on the wire and in a jsonb value object. */
export const ZOD_DURATION_WRITE_EXPR = `${ZOD_DURATION_EXPR}.transform(${DURATION_WRITE_HELPER})`;

/** The accepted form with its components captured: sign, days, hours, minutes, seconds, fraction.
 *  Equivalent to DURATION_PATTERN (the same lookaheads refuse `P`, `PT` and `P1DT`). */
const ISO_PARTS_SOURCE = String.raw`/^([-+])?P(?!$)(?:(\d+)D)?(?:T(?=\d)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)(?:\.(\d{1,9}))?S)?)?$/`;

/** The default (`IntervalStyle = postgres`) text of a Postgres interval: signed year / mon / day
 *  parts, then an optionally signed `H:MM:SS[.ffffff]`. */
const PG_INTERVAL_SOURCE = String.raw`/^(?:([-+]?\d+) years? ?)?(?:([-+]?\d+) mons? ?)?(?:([-+]?\d+) days? ?)?(?:([-+])?(\d+):(\d{2}):(\d{2})(?:\.(\d{1,6}))?)?$/`;

/** Indent every line of `block` by `n` spaces (blank lines stay blank). */
function indent(block: string, n: number): string {
  const pad = " ".repeat(n);
  return block.split("\n").map((l) => (l === "" ? l : pad + l)).join("\n");
}

/** Microsecond unit constants, as `BigInt(...)` calls (no bigint literal). */
const UNIT_LINES = [
  "const ZERO = BigInt(0);",
  "const SECOND = BigInt(1000000);",
  "const MINUTE = BigInt(60000000);",
  "const HOUR = BigInt(3600000000);",
  "const DAY = BigInt(86400000000);",
].join("\n");

/** `parseIso(text)`: the microseconds of an accepted ISO-8601 duration, or undefined. */
const PARSE_ISO_FN = [
  "const parseIso = (text: string): bigint | undefined => {",
  `  const p = ${ISO_PARTS_SOURCE}.exec(text);`,
  "  if (p === null) return undefined;",
  "  const mag = BigInt(p[2] ?? 0) * DAY + BigInt(p[3] ?? 0) * HOUR + BigInt(p[4] ?? 0) * MINUTE",
  '    + BigInt(p[5] ?? 0) * SECOND + BigInt((p[6] ?? "").padEnd(6, "0").slice(0, 6));',
  '  return p[1] === "-" ? -mag : mag;',
  "};",
].join("\n");

/** `isoText(micros)`: the canonical wire form. */
const ISO_TEXT_FN = [
  "const isoText = (micros: bigint): string => {",
  "  const neg = micros < ZERO;",
  "  let rest = neg ? -micros : micros;",
  "  const h = rest / HOUR;",
  "  rest %= HOUR;",
  "  const m = rest / MINUTE;",
  "  rest %= MINUTE;",
  "  const s = rest / SECOND;",
  "  const f = rest % SECOND;",
  '  let out = "PT";',
  '  if (h > ZERO) out += String(h) + "H";',
  '  if (m > ZERO) out += String(m) + "M";',
  '  if (s > ZERO || f > ZERO) out += String(s) + (f > ZERO ? "." + String(f).padStart(6, "0").replace(/0+$/, "") : "") + "S";',
  '  if (out === "PT") return "PT0S";',
  '  return neg ? "-" + out : out;',
  "};",
].join("\n");

export const DURATION_WRITE_HELPER_DECL = [
  "/** A field.duration on the wire: an ISO-8601 duration (days, hours, minutes, seconds) rewritten to its",
  " *  canonical form — hours never folded into days, zero components left out, zero as PT0S, at most six",
  " *  fractional digits (truncated), one leading \"-\" for a negative span. Counted in bigint",
  " *  microseconds, so any length is exact. Generated. */",
  `function ${DURATION_WRITE_HELPER}(text: string): string {`,
  indent(UNIT_LINES, 2),
  indent(PARSE_ISO_FN, 2),
  indent(ISO_TEXT_FN, 2),
  "  const micros = parseIso(text);",
  "  return micros === undefined ? text : isoText(micros);",
  "}",
].join("\n");

/** The physical column type a duration column's `customType` declares, per dialect: the
 *  Postgres-native interval; a 64-bit integer count of microseconds on SQLite / D1 (INTEGER) and
 *  MySQL (BIGINT) — the persistence corpus's canonical schemas, and what `meta migrate` writes. */
export function durationColumnDataType(dialect: Dialect): string {
  return dialect === "postgres" ? "interval" : dialect === "mysql" ? "bigint" : "integer";
}

/**
 * The body of the duration column's declaration, around the `customType` reference (which the
 * caller supplies as an import). `[before, after]`: `before + customType + after` is the whole
 * declaration. Exported so a test can evaluate the exact text a generated module carries.
 *
 * - `toDriver` binds what the column holds: on Postgres the interval spelling `[-]HH:MM:SS[.f]`
 *   (Postgres refuses a signed ISO-8601 duration, and returns a value written this way in exactly
 *   this spelling); on SQLite, D1 and MySQL the microsecond count — a number when it is a safe
 *   integer, else a bigint — refused past the 64-bit range, which is that column's limit. It takes
 *   the value as an ISO-8601 duration (what the generated write schema hands it), or as what
 *   runtime-ts already binds a filter operand in (the Postgres text; the microsecond integer), and
 *   throws for anything else.
 * - `fromDriver` reads what the driver returns — the microsecond integer (a number, a bigint or a
 *   digit string), ISO-8601 text, Postgres interval text in the default `IntervalStyle`, or a
 *   node-postgres interval object — as the canonical ISO-8601 form. An interval with a year or
 *   month part is not a fixed-length span: reading one throws.
 */
export function durationColumnDeclParts(dialect: Dialect): [string, string] {
  const postgres = dialect === "postgres";
  const before = [
    "/** A field.duration column. Binds " + (postgres
      ? "the Postgres interval spelling [-]HH:MM:SS[.f] (Postgres refuses a signed ISO-8601 duration);"
      : "the span as a 64-bit integer count of microseconds (refused past that range);"),
    " *  reads it back as the canonical ISO-8601 duration, and refuses an interval with a year or month",
    " *  part. Counted in bigint microseconds, so the column is the only limit. Generated. */",
    `const ${DURATION_COLUMN_FN} = (() => {`,
    indent(UNIT_LINES, 2),
    `  const INT64_MAX = BigInt("9223372036854775807");`,
    indent(PARSE_ISO_FN, 2),
    indent(ISO_TEXT_FN, 2),
    indent([
      "const pgText = (micros: bigint): string => {",
      "  const neg = micros < ZERO;",
      "  let rest = neg ? -micros : micros;",
      '  const two = (n: bigint): string => String(n).padStart(2, "0");',
      "  const h = rest / HOUR;",
      "  rest %= HOUR;",
      "  const m = rest / MINUTE;",
      "  rest %= MINUTE;",
      '  let out = two(h) + ":" + two(m) + ":" + two(rest / SECOND);',
      "  const f = rest % SECOND;",
      '  if (f > ZERO) out += "." + String(f).padStart(6, "0").replace(/0+$/, "");',
      '  return neg ? "-" + out : out;',
      "};",
      "const stored = (micros: bigint): number | bigint => {",
      "  if (micros > INT64_MAX || micros < -INT64_MAX - BigInt(1)) {",
      '    throw new Error("the span " + isoText(micros) + " does not fit the 64-bit microsecond column a field.duration is stored in");',
      "  }",
      "  const n = Number(micros);",
      "  return Number.isSafeInteger(n) ? n : micros;",
      "};",
      "const notFixed = (v: unknown): Error =>",
      '  new Error("the interval " + JSON.stringify(v) + " has a year or month part, so it is not a fixed-length field.duration");',
      "const read = (v: unknown): bigint => {",
      '  if (typeof v === "bigint") return v;',
      '  if (typeof v === "number" && Number.isInteger(v)) return BigInt(v);',
      '  if (typeof v === "string") {',
      "    if (/^-?\\d+$/.test(v)) return BigInt(v);",
      "    const iso = parseIso(v);",
      "    if (iso !== undefined) return iso;",
      `    const p = v.length === 0 ? null : ${PG_INTERVAL_SOURCE}.exec(v);`,
      '    if (p === null) throw new Error("not a field.duration value: " + JSON.stringify(v));',
      "    if (Number(p[1] ?? 0) !== 0 || Number(p[2] ?? 0) !== 0) throw notFixed(v);",
      "    let time = ZERO;",
      "    if (p[5] !== undefined) {",
      '      time = BigInt(p[5]) * HOUR + BigInt(p[6] ?? 0) * MINUTE + BigInt(p[7] ?? 0) * SECOND + BigInt((p[8] ?? "").padEnd(6, "0"));',
      '      if (p[4] === "-") time = -time;',
      "    }",
      "    return BigInt(p[3] ?? 0) * DAY + time;",
      "  }",
      '  if (v !== null && typeof v === "object") {',
      "    const o = v as Record<string, number | undefined>;",
      "    if ((o.years ?? 0) !== 0 || (o.months ?? 0) !== 0) throw notFixed(v);",
      "    const whole = (n: number | undefined): bigint => BigInt(Math.trunc(n ?? 0));",
      "    // postgres-interval carries microseconds as a fractional millisecond count.",
      "    return whole(o.days) * DAY + whole(o.hours) * HOUR + whole(o.minutes) * MINUTE + whole(o.seconds) * SECOND",
      "      + BigInt(Math.round((o.milliseconds ?? 0) * 1000));",
      "  }",
      '  throw new Error("not a field.duration value: " + JSON.stringify(v));',
      "};",
    ].join("\n"), 2),
    "  return ",
  ].join("\n");
  const after = [
    `<{ data: string; driverData: ${postgres ? "string" : "number | bigint | string"} }>({`,
    `    dataType: () => ${JSON.stringify(durationColumnDataType(dialect))},`,
    `    toDriver: (value) => ${postgres ? "pgText" : "stored"}(read(value)),`,
    "    fromDriver: (value) => isoText(read(value)),",
    "  });",
    "})();",
  ].join("\n");
  return [before, after];
}

/** A duration column's Drizzle `customType` declaration, emitted ahead of the table or view that
 *  uses it (once per module — see enum-int-codec.ts for why the order and the once matter). */
export function renderDurationCustomType(dialect: Dialect, importModule: string): Code {
  const customTypeSym = imp(`customType@${importModule}`);
  const [before, after] = durationColumnDeclParts(dialect);
  return code`
${before}${customTypeSym}${after}
`;
}
