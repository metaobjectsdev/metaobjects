/**
 * How a stored value is shown, decided by the field's metadata.
 */
import {
  FIELD_ATTR_CURRENCY,
  FIELD_ATTR_SCALE,
  FIELD_SUBTYPE_BOOLEAN,
  FIELD_SUBTYPE_CURRENCY,
  FIELD_SUBTYPE_DATE,
  FIELD_SUBTYPE_DECIMAL,
  FIELD_SUBTYPE_ENUM,
  FIELD_SUBTYPE_OBJECT,
  VIEW_CURRENCY_ATTR_LOCALE,
} from "@metaobjectsdev/metadata/constants";
import { formatCurrency } from "@metaobjectsdev/runtime-web";
import { humanize, type FieldModel } from "./model";

/** `in_progress` to "In progress". */
export function enumLabel(member: string): string {
  return humanize(member).toLowerCase().replace(/^./, (c) => c.toUpperCase());
}

/** A decimal string padded to the field's `@scale`: `92.5` at scale 2 is `92.50`. Digits only; no rounding, no double. */
export function fixedDecimal(value: string, scale: number): string {
  const [whole = "0", fraction = ""] = value.split(".");
  return scale <= 0 || fraction.length >= scale ? value : `${whole}.${fraction.padEnd(scale, "0")}`;
}

export function currencyCode(field: FieldModel): string | undefined {
  const code = field.attr(FIELD_ATTR_CURRENCY);
  return typeof code === "string" ? code : undefined;
}

export function currencyLocale(field: FieldModel): string | undefined {
  const locale = field.view?.attr(VIEW_CURRENCY_ATTR_LOCALE);
  return typeof locale === "string" ? locale : undefined;
}

/** A value as text, for a cell or a summary. Empty for a null. */
export function displayValue(field: FieldModel, value: unknown): string {
  if (value === null || value === undefined) return "";
  // A list is its members, each drawn as the field draws one.
  if (Array.isArray(value)) return value.map((member) => displayValue(field, member)).join(", ");
  switch (field.subType) {
    case FIELD_SUBTYPE_BOOLEAN:
      return value === true ? "Yes" : "No";
    case FIELD_SUBTYPE_ENUM:
      return enumLabel(String(value));
    case FIELD_SUBTYPE_DECIMAL: {
      const scale = field.attr(FIELD_ATTR_SCALE);
      return fixedDecimal(String(value), typeof scale === "number" ? scale : 0);
    }
    case FIELD_SUBTYPE_CURRENCY:
      return typeof value === "number" ? formatCurrency(value, currencyCode(field), currencyLocale(field)) : String(value);
    case FIELD_SUBTYPE_DATE:
      // The stored text. Parsing `2026-11-24` as a Date and printing it in local time shows
      // the day before to anyone west of Greenwich.
      return String(value);
    case FIELD_SUBTYPE_OBJECT:
      return field.valueObject === undefined || typeof value !== "object"
        ? JSON.stringify(value)
        : field.valueObject.fields
            .map((member) => displayValue(member, (value as Record<string, unknown>)[member.name]))
            .filter((text) => text !== "")
            .join(", ");
    default:
      return String(value);
  }
}
