// Shared field-level metadata helpers — consumed by entity-constants.ts,
// projection-decl.ts, and any future generator that needs per-field inference.
//
// All helpers take a MetaField node.

import { MetaField } from "@metaobjectsdev/metadata";
import {
  FIELD_SUBTYPE_STRING,
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_LONG,
  FIELD_SUBTYPE_SHORT,
  FIELD_SUBTYPE_BYTE,
  FIELD_SUBTYPE_DOUBLE,
  FIELD_SUBTYPE_FLOAT,
  FIELD_SUBTYPE_DECIMAL,
  FIELD_SUBTYPE_BOOLEAN,
  FIELD_SUBTYPE_DATE,
  FIELD_SUBTYPE_TIME,
  FIELD_SUBTYPE_TIMESTAMP,
  FIELD_SUBTYPE_CURRENCY,
  FIELD_SUBTYPE_ENUM,
  FIELD_SUBTYPE_UUID,
  VIEW_SUBTYPE_TEXT,
  VIEW_SUBTYPE_DATE,
  VIEW_SUBTYPE_NUMBER,
  VIEW_SUBTYPE_CHECKBOX,
  VIEW_SUBTYPE_CURRENCY,
  FIELD_ATTR_CURRENCY,
  FIELD_ATTR_CURRENCY_DEFAULT,
  VIEW_CURRENCY_ATTR_LOCALE,
  VIEW_CURRENCY_ATTR_LOCALE_DEFAULT,
} from "@metaobjectsdev/metadata";
import { enumValues, zodEnumExpr } from "../enum-meta.js";

// ---------------------------------------------------------------------------
// inferViewKind
// ---------------------------------------------------------------------------

/**
 * Resolve the cell-renderer key (view kind) for a field.
 * Explicit view child wins; field subType determines default.
 */
export function inferViewKind(field: MetaField): string {
  // Explicit view (own or inherited via extends) has highest priority.
  const viewChild = field.views()[0];
  if (viewChild) return viewChild.subType;
  // Field subtype → default view.
  return defaultViewForSubType(field.subType);
}

function defaultViewForSubType(subType: string): string {
  switch (subType) {
    case FIELD_SUBTYPE_BOOLEAN:
      return VIEW_SUBTYPE_CHECKBOX;
    case FIELD_SUBTYPE_INT:
    case FIELD_SUBTYPE_LONG:
    case FIELD_SUBTYPE_SHORT:
    case FIELD_SUBTYPE_BYTE:
    case FIELD_SUBTYPE_DOUBLE:
    case FIELD_SUBTYPE_FLOAT:
    case FIELD_SUBTYPE_DECIMAL:
      return VIEW_SUBTYPE_NUMBER;
    case FIELD_SUBTYPE_DATE:
    case FIELD_SUBTYPE_TIME:
    case FIELD_SUBTYPE_TIMESTAMP:
      return VIEW_SUBTYPE_DATE;
    case FIELD_SUBTYPE_CURRENCY:
      return VIEW_SUBTYPE_CURRENCY;
    default:
      return VIEW_SUBTYPE_TEXT;
  }
}

// ---------------------------------------------------------------------------
// zodTypeFor
// ---------------------------------------------------------------------------

/**
 * Resolve the Zod validator expression for a field's storage type.
 */
export function zodTypeFor(field: MetaField): string {
  switch (field.subType) {
    case FIELD_SUBTYPE_STRING:
    case FIELD_SUBTYPE_UUID:
      return "z.string()";
    case FIELD_SUBTYPE_BOOLEAN:
      return "z.boolean()";
    case FIELD_SUBTYPE_DATE:
    case FIELD_SUBTYPE_TIME:
    case FIELD_SUBTYPE_TIMESTAMP:
      // Returned as ISO strings from SQLite/Postgres drivers.
      return "z.string()";
    case FIELD_SUBTYPE_INT:
    case FIELD_SUBTYPE_LONG:
    case FIELD_SUBTYPE_SHORT:
    case FIELD_SUBTYPE_BYTE:
    case FIELD_SUBTYPE_CURRENCY:
      return "z.number().int()";
    case FIELD_SUBTYPE_DOUBLE:
    case FIELD_SUBTYPE_FLOAT:
    case FIELD_SUBTYPE_DECIMAL:
      return "z.number()";
    case FIELD_SUBTYPE_ENUM: {
      const values = enumValues(field);
      return values !== undefined ? zodEnumExpr(values) : "z.string()";
    }
    default:
      return "z.unknown()";
  }
}

// ---------------------------------------------------------------------------
// currencyMetaFor
// ---------------------------------------------------------------------------

/**
 * Resolve currency code + locale for a currency-subtype field.
 * Returns null for non-currency fields.
 */
export function currencyMetaFor(field: MetaField): { currency: string; locale: string } | null {
  if (field.subType !== FIELD_SUBTYPE_CURRENCY) return null;
  const currency =
    (field.ownAttr(FIELD_ATTR_CURRENCY) as string | undefined) ?? FIELD_ATTR_CURRENCY_DEFAULT;
  const viewChild = field.views().find((c) => c.subType === VIEW_SUBTYPE_CURRENCY);
  const locale =
    (viewChild?.ownAttr(VIEW_CURRENCY_ATTR_LOCALE) as string | undefined) ??
    VIEW_CURRENCY_ATTR_LOCALE_DEFAULT;
  return { currency, locale };
}

// ---------------------------------------------------------------------------
// labelFor
// ---------------------------------------------------------------------------

/**
 * Resolve the human-readable label for a field.
 * Uses @label attr on a view child if present; otherwise humanizes the field name.
 */
export function labelFor(field: MetaField): string {
  for (const child of field.views()) {
    const label = child.ownAttr("label");
    if (typeof label === "string" && label.length > 0) return label;
  }
  return humanize(field.name);
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/** Convert a camelCase or PascalCase field name to a human-friendly label. */
function humanize(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}
