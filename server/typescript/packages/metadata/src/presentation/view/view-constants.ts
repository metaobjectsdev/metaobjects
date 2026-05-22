// View concern constants — subtypes and attr keys for the view.* type family.

import { SUBTYPE_BASE } from "../../shared/base-types.js";

// ---------------------------------------------------------------------------
// View subtypes (13)
//
// The view's subType IS the UI control type. Each control kind has its own
// expected attrs (placeholder, maxLength, options, etc.) — runtime-ts
// surfaces them as opaque Record<string, unknown>; UI layers interpret.
// Mirrors metaobjects-dynamic/web/.../html/*View.java naming.
// ---------------------------------------------------------------------------

export const VIEW_SUBTYPE_TEXT = "text";
export const VIEW_SUBTYPE_TEXTAREA = "textarea";
export const VIEW_SUBTYPE_DATE = "date";
export const VIEW_SUBTYPE_MONTH = "month";
export const VIEW_SUBTYPE_HOTLINK = "hotlink";
export const VIEW_SUBTYPE_DROPDOWN = "dropdown";
export const VIEW_SUBTYPE_RADIO = "radio";
export const VIEW_SUBTYPE_CHECKBOX = "checkbox";
export const VIEW_SUBTYPE_NUMBER = "number";
export const VIEW_SUBTYPE_PASSWORD = "password";
export const VIEW_SUBTYPE_HIDDEN = "hidden";
export const VIEW_SUBTYPE_WEB = "web";          // abstract base for web-rendered views
export const VIEW_SUBTYPE_CURRENCY = "currency";

export const VIEW_SUBTYPES = [
  SUBTYPE_BASE,
  VIEW_SUBTYPE_TEXT,
  VIEW_SUBTYPE_TEXTAREA,
  VIEW_SUBTYPE_DATE,
  VIEW_SUBTYPE_MONTH,
  VIEW_SUBTYPE_HOTLINK,
  VIEW_SUBTYPE_DROPDOWN,
  VIEW_SUBTYPE_RADIO,
  VIEW_SUBTYPE_CHECKBOX,
  VIEW_SUBTYPE_NUMBER,
  VIEW_SUBTYPE_PASSWORD,
  VIEW_SUBTYPE_HIDDEN,
  VIEW_SUBTYPE_WEB,
  VIEW_SUBTYPE_CURRENCY,
] as const;
export type ViewSubType = (typeof VIEW_SUBTYPES)[number];

// ---------------------------------------------------------------------------
// View attrs (on currency views)
// ---------------------------------------------------------------------------

/** BCP 47 locale code on a view[currency]. Defaults to "en-US" when omitted. */
export const VIEW_CURRENCY_ATTR_LOCALE = "locale";
/** Default BCP 47 locale code when @locale is omitted on a view[currency]. */
export const VIEW_CURRENCY_ATTR_LOCALE_DEFAULT = "en-US";
