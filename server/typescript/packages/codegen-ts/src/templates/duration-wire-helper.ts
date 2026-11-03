// The wire rule for a field.duration, as text a generated model module carries as local code.
// Generated model code imports nothing from MetaObjects, so the rule is emitted, not imported;
// metadata/src/core/field/duration-wire.ts holds the same rule and both are held to
// fixtures/duration-wire/vectors.json (test/duration-wire-helper.test.ts evaluates the text
// emitted here against them).
//
// Canonical: `[-]PT[<h>H][<m>M][<s>[.<f>]S]` — hours never folded into days, zero components left
// out, zero is `PT0S`, at most six fractional digits (truncated toward zero), one leading `-`.
// The emitted code holds a span as whole seconds plus microseconds (two JS numbers of one sign),
// so it needs no bigint and is exact for any span below 2^53 seconds.

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
 *  so equal spans are stored as equal strings on every dialect. */
export const ZOD_DURATION_WRITE_EXPR = `${ZOD_DURATION_EXPR}.transform(${DURATION_WRITE_HELPER})`;

/** The largest span a field.duration holds, in whole seconds: 256204778 hours, the largest whole
 *  hour a .NET TimeSpan holds (fixtures/duration-wire). Every port refuses one microsecond more, so
 *  a value one port accepts every port can read. It also bounds the emitted arithmetic: 9.2e11
 *  seconds is far below 2^53, so seconds and microseconds stay exact JS integers and never format
 *  in exponent notation. */
export const DURATION_MAX_SECONDS = 256204778 * 3600;

/** The accepted form with its components captured: sign, days, hours, minutes, seconds, fraction.
 *  Equivalent to DURATION_PATTERN (the same lookaheads refuse `P`, `PT` and `P1DT`). */
const ISO_PARTS_SOURCE = "/^([-+])?P(?!$)(?:(\\d+)D)?(?:T(?=\\d)(?:(\\d+)H)?(?:(\\d+)M)?(?:(\\d+)(?:\\.(\\d{1,9}))?S)?)?$/";

/** Lines formatting a span of `s` whole seconds plus `us` microseconds (one sign) canonically. */
const ISO_FORMAT_LINES = [
  "  const neg = s < 0 || us < 0;",
  "  const a = Math.abs(s);",
  "  const f = Math.abs(us);",
  "  const h = Math.floor(a / 3600);",
  "  const m = Math.floor((a % 3600) / 60);",
  "  const sec = a % 60;",
  '  let out = "PT";',
  '  if (h > 0) out += h + "H";',
  '  if (m > 0) out += m + "M";',
  '  if (sec > 0 || f > 0) out += sec + (f > 0 ? "." + String(f).padStart(6, "0").replace(/0+$/, "") : "") + "S";',
  '  if (out === "PT") return "PT0S";',
  '  return neg ? "-" + out : out;',
];

/** Lines matching `text` against the accepted form: `p` (null when it is not one), then `mag` whole
 *  seconds and `frac` microseconds of the span's magnitude. Read only after a null check on `p`. */
const ISO_MATCH_LINES = [
  `  const p = ${ISO_PARTS_SOURCE}.exec(text);`,
  "  const mag = p === null ? 0 : Number(p[2] ?? 0) * 86400 + Number(p[3] ?? 0) * 3600 + Number(p[4] ?? 0) * 60 + Number(p[5] ?? 0);",
  '  const frac = p === null ? 0 : Number((p[6] ?? "").padEnd(6, "0").slice(0, 6));',
];

export const DURATION_WRITE_HELPER_DECL = [
  "/** A field.duration on the wire: an ISO-8601 duration (days, hours, minutes, seconds) rewritten to its",
  " *  canonical form — hours never folded into days, zero components left out, zero as PT0S, at most six",
  " *  fractional digits (truncated), one leading \"-\" for a negative span. A span past 256204778 hours",
  " *  (the bound every port holds) is a validation issue. Generated. */",
  `function ${DURATION_WRITE_HELPER}(text: string, ctx: z.RefinementCtx): string {`,
  ...ISO_MATCH_LINES,
  "  if (p === null) return text;",
  `  if (mag > ${DURATION_MAX_SECONDS} || (mag === ${DURATION_MAX_SECONDS} && frac > 0)) {`,
  '    ctx.addIssue({ code: "custom", message: "Duration out of range: at most 256204778 hours" });',
  "    return z.NEVER;",
  "  }",
  '  const s = p[1] === "-" ? -mag : mag;',
  '  const us = p[1] === "-" ? -frac : frac;',
  ...ISO_FORMAT_LINES,
  "}",
].join("\n");

/** The physical column type a duration column's `customType` declares, per dialect: the
 *  Postgres-native interval; TEXT on SQLite; VARCHAR(64) on MySQL (the persistence corpus's
 *  canonical schemas, and what `meta migrate` writes). */
export function durationColumnDataType(dialect: Dialect): string {
  return dialect === "postgres" ? "interval" : dialect === "mysql" ? "varchar(64)" : "text";
}

/**
 * The body of the duration column's declaration, around the `customType` reference (which the
 * caller supplies as an import). `[before, after]`: `before + customType + after` is the whole
 * declaration. Exported so a test can evaluate the exact text a generated module carries.
 *
 * - `toDriver` binds what the column holds: on Postgres the interval spelling `[-]HH:MM:SS[.f]`
 *   (Postgres refuses a signed ISO-8601 duration as interval input, and returns a value written
 *   this way in exactly this spelling); on SQLite and MySQL the canonical ISO-8601 string, so equal
 *   spans are equal strings. It takes the value in either spelling — an ISO-8601 duration (what the
 *   generated write schema hands it), or the Postgres interval text runtime-ts already binds a
 *   filter operand or a write in — and throws for anything else.
 * - `fromDriver` reads what the driver returns — ISO-8601 text, Postgres interval text in the
 *   default `IntervalStyle`, or a node-postgres interval object — as the canonical ISO-8601 form.
 *   An interval with a year or month part is not a fixed-length span: reading one throws.
 */
export function durationColumnDeclParts(dialect: Dialect): [string, string] {
  const bindPostgres = dialect === "postgres";
  const before = [
    "/** A field.duration column. Binds " + (bindPostgres
      ? "the Postgres interval spelling [-]HH:MM:SS[.f] (Postgres refuses a signed ISO-8601 duration),"
      : "the canonical ISO-8601 duration,"),
    " *  reads any interval back as the canonical ISO-8601 duration, and refuses an interval with a",
    " *  year or month part. Generated. */",
    `const ${DURATION_COLUMN_FN} = (() => {`,
    "  const MICROS = 1000000;",
    `  const MAX_SECONDS = ${DURATION_MAX_SECONDS};`,
    "  // A span normalised to one sign, refused past 256204778 hours (the bound every port holds).",
    "  const span = (s: number, us: number): [number, number] => {",
    "    s += Math.trunc(us / MICROS);",
    "    us %= MICROS;",
    "    if (s > 0 && us < 0) {",
    "      s -= 1;",
    "      us += MICROS;",
    "    } else if (s < 0 && us > 0) {",
    "      s += 1;",
    "      us -= MICROS;",
    "    }",
    "    const a = Math.abs(s);",
    "    if (!(a < MAX_SECONDS || (a === MAX_SECONDS && us === 0))) {",
    '      throw new Error("a field.duration holds at most 256204778 hours (one microsecond more is refused)");',
    "    }",
    "    return [s, us];",
    "  };",
    "  const iso = (text: string): [number, number] | undefined => {",
    ...ISO_MATCH_LINES.map((l) => "  " + l),
    "    if (p === null) return undefined;",
    '    return p[1] === "-" ? [-mag, -frac] : [mag, frac];',
    "  };",
    "  const isoText = ([s, us]: [number, number]): string => {",
    ...ISO_FORMAT_LINES.map((l) => "  " + l),
    "  };",
    "  const pgText = ([s, us]: [number, number]): string => {",
    "    const neg = s < 0 || us < 0;",
    "    const a = Math.abs(s);",
    "    const f = Math.abs(us);",
    '    const two = (n: number): string => String(n).padStart(2, "0");',
    '    let out = two(Math.floor(a / 3600)) + ":" + two(Math.floor((a % 3600) / 60)) + ":" + two(a % 60);',
    '    if (f > 0) out += "." + String(f).padStart(6, "0").replace(/0+$/, "");',
    '    return neg ? "-" + out : out;',
    "  };",
    "  const notFixed = (v: unknown): Error =>",
    '    new Error("the interval " + JSON.stringify(v) + " has a year or month part, so it is not a fixed-length field.duration");',
    "  const read = (v: unknown): [number, number] => {",
    '    if (typeof v === "string") {',
    "      const fromIso = iso(v);",
    "      if (fromIso !== undefined) return span(fromIso[0], fromIso[1]);",
    "      const p = v.length === 0 ? null",
    "        : /^(?:([-+]?\\d+) years? ?)?(?:([-+]?\\d+) mons? ?)?(?:([-+]?\\d+) days? ?)?(?:([-+])?(\\d+):(\\d{2}):(\\d{2})(?:\\.(\\d{1,6}))?)?$/.exec(v);",
    '      if (p === null) throw new Error("not a field.duration value: " + JSON.stringify(v));',
    "      if (Number(p[1] ?? 0) !== 0 || Number(p[2] ?? 0) !== 0) throw notFixed(v);",
    '      const t = p[5] === undefined ? 0 : Number(p[5]) * 3600 + Number(p[6]) * 60 + Number(p[7]);',
    '      const tu = Number((p[8] ?? "").padEnd(6, "0"));',
    '      const sign = p[4] === "-" ? -1 : 1;',
    "      return span(Number(p[3] ?? 0) * 86400 + sign * t, sign * tu);",
    "    }",
    '    if (v !== null && typeof v === "object") {',
    "      const o = v as Record<string, number | undefined>;",
    "      if ((o.years ?? 0) !== 0 || (o.months ?? 0) !== 0) throw notFixed(v);",
    "      const whole = (n: number | undefined): number => Math.trunc(n ?? 0);",
    "      return span(",
    "        whole(o.days) * 86400 + whole(o.hours) * 3600 + whole(o.minutes) * 60 + whole(o.seconds),",
    "        Math.round((o.milliseconds ?? 0) * 1000),",
    "      );",
    "    }",
    '    throw new Error("not a field.duration value: " + JSON.stringify(v));',
    "  };",
    "  return ",
  ].join("\n");
  const after = [
    "<{ data: string; driverData: string }>({",
    `    dataType: () => ${JSON.stringify(durationColumnDataType(dialect))},`,
    `    toDriver: (value) => ${bindPostgres ? "pgText" : "isoText"}(read(value)),`,
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
