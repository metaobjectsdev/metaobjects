// Shared field-level metadata helpers — consumed by entity-constants.ts,
// projection-decl.ts, and any future generator that needs per-field inference.
//
// All helpers take a MetaField node.

import { MetaField } from "@metaobjectsdev/metadata";
import {
  FIELD_SUBTYPE_STRING,
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_LONG,
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
  FIELD_SUBTYPE_URI,
  FIELD_SUBTYPE_INET,
  FIELD_ATTR_STRING_FORMAT,
  FIELD_ATTR_LENIENT,
  STRING_FORMAT_EMAIL,
  STRING_FORMAT_HOSTNAME,
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
import { ZOD_INET_EXPR } from "./net-regex.js";

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
 *
 * `timestampMode` (default "string") mirrors zod-validators.ts's zodFieldExpr:
 * a "date"-mode FIELD_SUBTYPE_TIMESTAMP column (view/projection read schemas —
 * see view-decl.ts's renderViewReadZodObject, which sources its column TYPE from
 * `mapColumnType(..., timestampMode)`) must agree with the Zod line built here or
 * `z.infer<>` disagrees with the Drizzle column and callers fail to typecheck.
 * FIELD_SUBTYPE_DATE / FIELD_SUBTYPE_TIME are NOT governed by timestampMode —
 * calendar date / time-of-day stay ISO-string-shaped always (verified correct;
 * see zodFieldExpr's identical DATE/TIME case).
 */
export function zodTypeFor(field: MetaField, timestampMode: "date" | "string" = "string"): string {
  switch (field.subType) {
    case FIELD_SUBTYPE_STRING: {
      // ADR-0036/0037 Wave 3: @stringFormat narrows a plain string. Codegen owns
      // the canonical matcher (mirrors zod-validators.ts).
      const fmt = field.attr(FIELD_ATTR_STRING_FORMAT);
      if (fmt === STRING_FORMAT_EMAIL) return "z.string().email()";
      if (fmt === STRING_FORMAT_HOSTNAME) {
        return "z.string().regex(/^(?=.{1,253}$)([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/)";
      }
      return "z.string()";
    }
    case FIELD_SUBTYPE_UUID:
      return "z.string()";
    case FIELD_SUBTYPE_URI:
      // ADR-0036/0037 Wave 3: a URI string — codegen owns the URL matcher.
      // #234: @lenient opts out of well-formedness — bind a plain string.
      return field.attr(FIELD_ATTR_LENIENT) === true ? "z.string()" : "z.string().url()";
    case FIELD_SUBTYPE_INET:
      // ADR-0036/0037 Wave 3 + #234: an IP string — codegen owns the IP matcher
      // (v4 or v6 literal). Zod-version-agnostic regex union (Zod 4 removed
      // `z.string().ip()`); see net-regex.ts. @lenient → a plain string.
      return field.attr(FIELD_ATTR_LENIENT) === true ? "z.string()" : ZOD_INET_EXPR;
    case FIELD_SUBTYPE_BOOLEAN:
      return "z.boolean()";
    case FIELD_SUBTYPE_DATE:
    case FIELD_SUBTYPE_TIME:
      // Calendar date / time-of-day — always ISO-string-shaped, not governed by
      // timestampMode (verified correct; mirrors zodFieldExpr).
      return "z.string()";
    case FIELD_SUBTYPE_TIMESTAMP:
      // CRITICAL 3 (#281 sweep miss): must agree with the Drizzle view/projection
      // column's mode (mapColumnType via ViewDeclOpts.timestampMode) — a
      // hardcoded z.string() here disagreed with a "date"-mode column (Date-typed),
      // producing the same TS2322 cascade Critical 1 fixed for insert/update.
      // z.coerce.date() (not z.date()) for uniformity with zodFieldExpr: it
      // passes a DB-driver Date through unchanged (the read case this function
      // serves) and would equally accept an ISO string if ever reused for a
      // wire-parsing schema.
      return timestampMode === "date" ? "z.coerce.date()" : "z.string()";
    case FIELD_SUBTYPE_INT:
    case FIELD_SUBTYPE_LONG:
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
    (field.attr(FIELD_ATTR_CURRENCY) as string | undefined) ?? FIELD_ATTR_CURRENCY_DEFAULT;
  const viewChild = field.views().find((c) => c.subType === VIEW_SUBTYPE_CURRENCY);
  // ADR-0039: resolving — a view may inherit @locale via extends.
  const locale =
    (viewChild?.attr(VIEW_CURRENCY_ATTR_LOCALE) as string | undefined) ??
    VIEW_CURRENCY_ATTR_LOCALE_DEFAULT;
  return { currency, locale };
}

// ---------------------------------------------------------------------------
// labelFor
// ---------------------------------------------------------------------------

/**
 * Resolve the human-readable label for a field.
 * Uses the registered `@title` common attr — on a view child first, else on the field
 * itself; otherwise humanizes the field name.
 *
 * #353 — this read `@label`, which no provider registers on any `view.*` subtype, so the
 * override branch was unreachable: authoring it fails the strict load `meta verify` runs
 * (ERR_UNKNOWN_ATTR). `title` is already a registered common attr on every node and
 * already means "a noun phrase", so nothing was registered for this (ADR-0037 step 0).
 */
export function labelFor(field: MetaField): string {
  for (const child of field.views()) {
    // ADR-0039: resolving — a view may inherit @title via extends.
    const title = child.attr("title");
    if (typeof title === "string" && title.length > 0) return title;
  }
  const fieldTitle = field.attr("title");
  if (typeof fieldTitle === "string" && fieldTitle.length > 0) return fieldTitle;
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
