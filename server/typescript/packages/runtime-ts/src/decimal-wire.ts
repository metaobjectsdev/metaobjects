// The wire form of a field.decimal — ADR-0019 Amendment 1 (W1-W4). The ONE decimal boundary of
// the TypeScript runtime: every decimal column of an entity, a projection or a report, on every
// dialect, crosses to a client through here, and every decimal a client sends comes in through
// here (filter operands) or through the same grammar (the generated Zod write schemas, which
// carry a local copy of `canonicalDecimal` because generated model code imports nothing from
// MetaObjects; test/decimal-wire.test.ts holds both to fixtures/decimal-wire/vectors.json).
//
//   W1  A decimal is a JSON string in canonical form, `^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$`:
//       plain notation, no exponent, no trailing fractional zeros, zero as "0". The server never
//       formats a scale; a client that wants `12.50` formats with the field's `@scale`.
//   W2  Input is a string in the JSON-number grammar (an exponent is allowed on input only) or a
//       JSON number. Anything else is refused: `parseDecimalInput` answers `undefined`.
//   W3  A value the declared column cannot hold is an error, never a silent rounding
//       (`decimalFits`, applied by the generated write schemas).
//   W4  SQLite and D1 have no decimal type: a decimal on them is a double, exact to 15 significant
//       digits. The read path renders the double with 15 significant digits, then canonicalizes
//       it, so `0.1 + 0.2` reads `"0.3"` (`decimalFromDouble15`).
//
// A string is never turned into a number on the way (no `Number()` on a decimal anywhere): an
// operand or a body value stays text, and is bound to SQL as text.

/** W2: the JSON-number grammar, exponent allowed. No whitespace, no leading `+`, no bare point. */
export const DECIMAL_INPUT_RE = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/;

/** W1: the canonical spelling a decimal takes on the wire. */
export const DECIMAL_CANONICAL_RE = /^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/;

/** An expanded value longer than this many digits is out of range (W3): `1e999999999` must not allocate. */
const MAX_EXPANDED_DIGITS = 1000;

/**
 * W1 + W2: parse `text` (the JSON-number grammar) and answer its canonical string, or `undefined`
 * when it is not a number in that grammar or is too large to expand. Exact: it works on the digits
 * and the exponent, never on a double.
 */
export function canonicalDecimal(text: string): string | undefined {
  const m = DECIMAL_INPUT_RE.exec(text);
  if (m === null) return undefined;
  const negative = m[1] === "-";
  const intPart = m[2] ?? "";
  const fracPart = m[3] ?? "";
  const exponent = m[4] === undefined ? 0 : Number(m[4]);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > MAX_EXPANDED_DIGITS) return undefined;
  let digits = intPart + fracPart;
  let point = intPart.length + exponent; // the decimal point sits after `point` digits
  const lead = digits.length - digits.replace(/^0+/, "").length;
  digits = digits.slice(lead);
  point -= lead;
  digits = digits.replace(/0+$/, "");
  if (digits.length === 0) return "0";
  let plain: string;
  if (point <= 0) plain = `0.${"0".repeat(-point)}${digits}`;
  else if (point >= digits.length) plain = digits + "0".repeat(point - digits.length);
  else plain = `${digits.slice(0, point)}.${digits.slice(point)}`;
  if (plain.length > MAX_EXPANDED_DIGITS) return undefined;
  return negative ? `-${plain}` : plain;
}

/**
 * W4: the canonical string of an IEEE double at 15 significant digits (SQLite's own text
 * precision). `undefined` for NaN and the infinities.
 */
export function decimalFromDouble15(value: number): string | undefined {
  if (!Number.isFinite(value)) return undefined;
  return canonicalDecimal(value.toPrecision(15));
}

/**
 * W2 for a value read off a parsed JSON request body: a string in the JSON-number grammar, or a
 * JSON number (exact to 15 significant digits, W4). `undefined` for anything else.
 */
export function parseDecimalInput(value: unknown): string | undefined {
  if (typeof value === "string") return canonicalDecimal(value);
  if (typeof value === "number") return decimalFromJsonNumber(value);
  return undefined;
}

/**
 * W2 for a JSON number on input. `JSON.parse` has already rounded the client's digits to a double,
 * so only a number that IS its own 15-digit form (or a safe integer, taken as `String(n)`) can be
 * read exactly: anything else would be silently rounded, so it is refused (`undefined`) and the
 * client is told to send a string. The test is `Number(n.toPrecision(15)) === n`: a number whose
 * shortest round-trip form carries more than 15 significant digits fails it.
 */
export function decimalFromJsonNumber(value: number): string | undefined {
  if (!Number.isFinite(value)) return undefined;
  if (Number.isSafeInteger(value)) return canonicalDecimal(String(value));
  if (Number(value.toPrecision(15)) !== value) return undefined;
  return canonicalDecimal(String(value));
}

/** W2 for a query-string filter operand: the same grammar as a body string, compared exactly. */
export function parseDecimalOperand(text: string): string | undefined {
  return canonicalDecimal(text);
}

/**
 * W3: whether the canonical decimal `canonical` fits a column declared `@precision` / `@scale`
 * (at most `precision - scale` integer digits and `scale` fraction digits). A column rounds an
 * excess fraction silently and refuses an excess integer part, so neither may reach it.
 */
export function decimalFits(canonical: string, precision: number | undefined, scale: number | undefined): boolean {
  if (precision === undefined) return true;
  const s = scale ?? 0;
  const unsigned = canonical.startsWith("-") ? canonical.slice(1) : canonical;
  const dot = unsigned.indexOf(".");
  const intDigits = dot === -1 ? unsigned : unsigned.slice(0, dot);
  const fracDigits = dot === -1 ? 0 : unsigned.length - dot - 1;
  const intLen = intDigits === "0" ? 0 : intDigits.length;
  return fracDigits <= s && intLen <= precision - s;
}

/**
 * W1/W4 on a value a driver hands back for a decimal column: a string (Postgres `numeric`, MySQL
 * `DECIMAL`, a SQLite text value) is canonicalized, a number (a SQLite or D1 REAL or INTEGER) is
 * rendered at 15 significant digits and canonicalized, a bigint is its digits, and an array (a
 * `field.decimal` declared `isArray`) is rewritten element by element. Null passes through. A
 * value in none of those shapes is left for the caller to see.
 */
export function decimalToWire(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decimalToWire);
  if (typeof value === "string") return canonicalDecimal(value) ?? value;
  if (typeof value === "number") return decimalFromDouble15(value) ?? value;
  if (typeof value === "bigint") return value.toString();
  return value;
}

/**
 * Rewrite the values under `columns` to their canonical string. Returns `undefined` when there is
 * nothing to do. Which keys are decimals comes from the caller (the generated route passes the
 * names of the entity's `field.decimal` fields), never from the shape of a value: an integer
 * column is not a decimal because it is a number.
 */
export function decimalWire(
  columns: readonly string[] | undefined,
): ((row: unknown) => unknown) | undefined {
  if (columns === undefined || columns.length === 0) return undefined;
  return (row) => {
    if (row === null || typeof row !== "object") return row;
    const out = { ...(row as Record<string, unknown>) };
    for (const c of columns) {
      if (c in out) out[c] = decimalToWire(out[c]);
    }
    return out;
  };
}

/** A wire mapper with the decimal rewrite of `columns` applied after `base` (which may be a timestamp mapper). */
export function withDecimals(
  base: (row: unknown) => unknown,
  columns: readonly string[] | undefined,
): (row: unknown) => unknown {
  const decimals = decimalWire(columns);
  return decimals === undefined ? base : (row) => decimals(base(row));
}
