/**
 * Currency helpers — read-side display, write-side parsing, minor-units lookup.
 * All operations are integer-cents in / integer-cents out. parseCurrency does
 * exact decimal-string arithmetic, so it never multiplies a float (e.g.,
 * 15.99 * 100 = 1598.999...).
 */

const intlCache = new Map<string, Intl.NumberFormat>();

function intlFor(currency: string, locale: string): Intl.NumberFormat {
  const key = `${locale}\u0000${currency}`;
  let fmt = intlCache.get(key);
  if (fmt === undefined) {
    fmt = new Intl.NumberFormat(locale, { style: "currency", currency });
    intlCache.set(key, fmt);
  }
  return fmt;
}

export function minorUnitsFor(currency: string, locale = "en-US"): number {
  try {
    return intlFor(currency, locale).resolvedOptions().minimumFractionDigits ?? 2;
  } catch {
    return 2;  // invalid currency code falls back to 2 minor units
  }
}

export function formatCurrency(
  cents: number,
  currency = "USD",
  locale = "en-US",
): string {
  const factor = Math.pow(10, minorUnitsFor(currency, locale));
  return intlFor(currency, locale).format(cents / factor);
}

/** Whitespace-like group separators (fr-FR uses U+202F) accept any ordinary space typed. */
const SPACE_LIKE = /^[\s  ]+$/;
const SPACE_CLASS = "[\\s\\u00a0\\u202f]";

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** What the locale writes: separators, digit grouping sizes, and the currency's spellings. */
interface LocaleShape {
  readonly group: string;
  readonly decimal: string;
  /** Size of the last integer group and of the ones before it (3/3, or 3/2 for en-IN). */
  readonly primary: number;
  readonly secondary: number;
  readonly tokens: readonly string[];
}

/** What `parseCurrency` derives per (currency, locale): the shape and its compiled regexes. */
interface ParseSpec {
  readonly shape: LocaleShape;
  readonly grammar: RegExp;
  readonly groupStrip: RegExp;
}

const parseSpecCache = new Map<string, ParseSpec>();

function parseSpecFor(currency: string, locale: string): ParseSpec {
  const key = `${locale}\u0000${currency}`;
  let spec = parseSpecCache.get(key);
  if (spec === undefined) {
    const shape = localeShape(currency, locale);
    spec = {
      shape,
      grammar: numberGrammar(shape),
      groupStrip: new RegExp(groupClass(shape), "g"),
    };
    parseSpecCache.set(key, spec);
  }
  return spec;
}

function localeShape(currency: string, locale: string): LocaleShape {
  let group = ",";
  let decimal = ".";
  let primary = 3;
  let secondary = 3;
  const tokens = new Set<string>();
  try {
    const parts = new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      useGrouping: true,
      minimumFractionDigits: 2,
    }).formatToParts(123456789.12);
    group = parts.find((p) => p.type === "group")?.value ?? group;
    decimal = parts.find((p) => p.type === "decimal")?.value ?? decimal;
    const groups = parts.filter((p) => p.type === "integer").map((p) => p.value.length);
    primary = groups[groups.length - 1] ?? primary;
    secondary = groups[groups.length - 2] ?? primary;
    for (const display of ["symbol", "narrowSymbol", "code"] as const) {
      const token = new Intl.NumberFormat(locale, { style: "currency", currency, currencyDisplay: display })
        .formatToParts(1)
        .find((p) => p.type === "currency")?.value;
      if (token) tokens.add(token);
    }
  } catch {
    // unknown currency or locale: fall back to the en-US shape, with the code as the token
    tokens.add(currency);
  }
  // Longest first so "US$" is peeled before "$".
  return { group, decimal, primary, secondary, tokens: [...tokens].sort((x, y) => y.length - x.length) };
}

function groupClass(shape: LocaleShape): string {
  return SPACE_LIKE.test(shape.group) ? SPACE_CLASS : escapeRe(shape.group);
}

/** The unsigned number grammar for a locale: grouped or plain integer, optional fraction. */
function numberGrammar(shape: LocaleShape): RegExp {
  const g = groupClass(shape);
  const d = escapeRe(shape.decimal);
  const grouped = `\\d{1,${shape.secondary}}(?:${g}\\d{${shape.secondary}})*${g}\\d{${shape.primary}}`;
  return new RegExp(`^(${grouped}|\\d+)?(?:${d}(\\d*))?$`);
}

/**
 * Parse text a person typed or pasted into integer minor units, or `null` when it is not a
 * money amount in this locale. The locale's own separators, grouping and currency spellings
 * come from `Intl.NumberFormat#formatToParts`; the accepted forms are a strict grammar, not
 * "strip everything that is not a digit". One negative marker is allowed, in any of the
 * forms `-5.00`, `$-5.00`, `-$5.00`, `5.00-` or `(5.00)`; two, or anything unrecognised
 * (`1e3`, `12.50 (2 items)`, a separator the locale does not use), is `null`.
 */
export function parseCurrency(
  text: string,
  currency = "USD",
  locale = "en-US",
): number | null {
  if (typeof text !== "string") return null;
  const { shape, grammar, groupStrip } = parseSpecFor(currency, locale);
  let rest = text.replace(/[−‒-—]/g, "-").trim();
  if (rest === "") return null;

  let markers = 0; // negative markers seen: sign or parentheses
  let positive = false;
  let tokenSeen = false;
  for (let peeled = true; peeled; ) {
    peeled = false;
    rest = rest.trim();
    if (rest.startsWith("(") && rest.endsWith(")")) {
      rest = rest.slice(1, -1);
      markers++;
      peeled = true;
    } else if (rest.startsWith("-") || rest.startsWith("+")) {
      if (rest[0] === "-") markers++;
      else positive = true;
      rest = rest.slice(1);
      peeled = true;
    } else if (rest.endsWith("-")) {
      markers++;
      rest = rest.slice(0, -1);
      peeled = true;
    } else if (!tokenSeen) {
      const token = shape.tokens.find((t) => rest.startsWith(t) || rest.endsWith(t));
      if (token !== undefined) {
        rest = rest.startsWith(token) ? rest.slice(token.length) : rest.slice(0, -token.length);
        tokenSeen = true;
        peeled = true;
      }
    }
  }
  if (markers > 1 || (markers === 1 && positive)) return null;

  const match = grammar.exec(rest.trim());
  if (match === null) return null;
  const whole = (match[1] ?? "").replace(groupStrip, "");
  const fraction = match[2] ?? "";
  if (whole === "" && fraction === "") return null;

  // Exact decimal-string arithmetic: no float multiply, half rounds away from zero.
  const minor = minorUnitsFor(currency, locale);
  const kept = fraction.slice(0, minor).padEnd(minor, "0");
  let units = Number(`${whole === "" ? "0" : whole}${kept}`);
  if ((fraction[minor] ?? "0") >= "5") units += 1;
  if (!Number.isSafeInteger(units)) return null;
  return markers === 1 && units !== 0 ? -units : units;
}
