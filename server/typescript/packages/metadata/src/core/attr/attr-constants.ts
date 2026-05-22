// Attr concern constants — subtypes for the attr.* type family.

import { SUBTYPE_BASE } from "../../shared/base-types.js";

// ---------------------------------------------------------------------------
// Attr subtypes (10)
// ---------------------------------------------------------------------------

export const ATTR_SUBTYPE_STRING = "string";
export const ATTR_SUBTYPE_INT = "int";
export const ATTR_SUBTYPE_LONG = "long";
export const ATTR_SUBTYPE_DOUBLE = "double";
export const ATTR_SUBTYPE_BOOLEAN = "boolean";
export const ATTR_SUBTYPE_CLASS = "class";
export const ATTR_SUBTYPE_PROPERTIES = "properties";
export const ATTR_SUBTYPE_STRINGARRAY = "stringarray";
export const ATTR_SUBTYPE_FILTER = "filter";

export const ATTR_SUBTYPES = [
  SUBTYPE_BASE,
  ATTR_SUBTYPE_STRING,
  ATTR_SUBTYPE_INT,
  ATTR_SUBTYPE_LONG,
  ATTR_SUBTYPE_DOUBLE,
  ATTR_SUBTYPE_BOOLEAN,
  ATTR_SUBTYPE_CLASS,
  ATTR_SUBTYPE_PROPERTIES,
  ATTR_SUBTYPE_STRINGARRAY,
  ATTR_SUBTYPE_FILTER,
] as const;
export type AttrSubType = (typeof ATTR_SUBTYPES)[number];
