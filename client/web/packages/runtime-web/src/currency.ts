/**
 * Currency helpers — read-side display, write-side parsing, minor-units lookup.
 * All operations are integer-cents in / integer-cents out; float arithmetic is
 * confined to a single Math.round to avoid drift (e.g., 15.99 * 100 = 1598.999...).
 */

function intlFor(currency: string, locale: string): Intl.NumberFormat {
  return new Intl.NumberFormat(locale, { style: "currency", currency });
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

export function parseCurrency(
  text: string,
  currency = "USD",
  locale = "en-US",
): number | null {
  if (typeof text !== "string" || text.trim() === "") return null;

  // Detect locale's decimal separator via Intl.
  const sample = (0.1).toLocaleString(locale);
  const decimalSep = sample.includes(",") ? "," : ".";

  // Determine sign from leading minus.
  const sign = text.trim().startsWith("-") ? -1 : 1;

  // Remove all non-numeric chars except the decimal separator.
  const escapedSep = decimalSep === "." ? "\\." : decimalSep;
  const digitsAndDecimal = text.replace(new RegExp(`[^0-9${escapedSep}]`, "g"), "");
  if (digitsAndDecimal === "" || digitsAndDecimal === decimalSep) return null;

  // Normalize to "." for parseFloat.
  const normalized =
    decimalSep === "." ? digitsAndDecimal : digitsAndDecimal.replace(decimalSep, ".");

  if ((normalized.match(/\./g) ?? []).length > 1) return null;

  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed)) return null;

  const factor = Math.pow(10, minorUnitsFor(currency, locale));
  return Math.round(sign * parsed * factor);
}
