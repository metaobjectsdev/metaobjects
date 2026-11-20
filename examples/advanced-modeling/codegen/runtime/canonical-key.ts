/**
 * Canonical numeric key text.
 *
 * A numeric primary key or id arrives as text (an HTTP path parameter, a `ref` string). `Number()`
 * reads far more than a number: `0x1`, `1e0`, `0b1`, ` 1 `, `+1`, `1.` and the empty string all
 * come back as a number, so two different texts name one row, and a text that is no key at all
 * names row 0. A key is read only from its one canonical spelling:
 *
 *   - an integer key: an optional `-`, then digits with no leading zero (`0` alone is fine);
 *   - a decimal or floating-point key: the same, optionally followed by `.` and at least one digit.
 *
 * No exponent, no hex, no sign other than `-`, no whitespace, and no negative zero. The checks walk
 * the characters; there is no pattern to keep in step with anything.
 */

function isAsciiDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

/** True when every character of `digits` is an ASCII digit and there is at least one. */
function allDigits(digits: string): boolean {
  if (digits === "") return false;
  for (const c of digits) if (!isAsciiDigit(c)) return false;
  return true;
}

/** True when `unsigned` is digits with no leading zero (`0` alone is allowed). */
function isCanonicalWhole(unsigned: string): boolean {
  return allDigits(unsigned) && (unsigned.length === 1 || unsigned[0] !== "0");
}

function hasIntegerShape(text: string): boolean {
  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  return isCanonicalWhole(unsigned) && !(negative && unsigned === "0");
}

/**
 * True when `text` is an optional `-` and canonical whole digits, is not negative zero, and reads
 * back as exactly one JS number (a safe integer): two canonical texts never name one key.
 */
export function isCanonicalInteger(text: string): boolean {
  return hasIntegerShape(text) && Number.isSafeInteger(Number(text));
}

/**
 * True when `text` is a canonical integer (a safe integer when it has no fraction), or one
 * followed by `.` and at least one digit that reads back as a finite number.
 */
export function isCanonicalDecimal(text: string): boolean {
  if (!text.includes(".")) return isCanonicalInteger(text);
  return hasDecimalShape(text) && Number.isFinite(Number(text));
}

function hasDecimalShape(text: string): boolean {
  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const dot = unsigned.indexOf(".");
  const whole = unsigned.slice(0, dot);
  const fraction = unsigned.slice(dot + 1);
  if (!isCanonicalWhole(whole) || !allDigits(fraction)) return false;
  // Negative zero in any spelling (`-0.0`) is not a canonical key.
  return !(negative && whole === "0" && [...fraction].every((c) => c === "0"));
}
