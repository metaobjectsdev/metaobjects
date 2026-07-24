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
export const ATTR_SUBTYPE_FILTER = "filter";
// #195 — a structured expression tree over a base entity's own fields (backs
// origin.computed). Object-shaped; a closed node grammar (see meta-attr-expression.ts).
export const ATTR_SUBTYPE_EXPRESSION = "expression";
// An object-shaped attr whose values are all integers (e.g. field.enum's
// @intValueMap: {memberSymbol: int}). Generic shape check only — semantic
// rules specific to a consumer (key-set membership, uniqueness) are that
// consumer's own content-rule validation, not this attr's.
export const ATTR_SUBTYPE_INT_MAP = "intMap";

/**
 * The retired `stringarray` array attr subtype. It is NO LONGER a registered
 * `(attr, subType)` — array-ness is modeled as a `string` attr with the
 * orthogonal `isArray` flag (matching Java's `StringAttribute + @isArray`), so
 * `stringarray` never appears in the registry manifest. The constant survives
 * ONLY as the key into the attr-class-map for the array-coercion class
 * (`StringArrayAttr`, the bare-string → one-element-array coercion), which the
 * loader resolves for any `isArray`-flagged attr. It is intentionally NOT in
 * `ATTR_SUBTYPES`.
 */
export const ATTR_SUBTYPE_STRINGARRAY = "stringarray";

export const ATTR_SUBTYPES = [
  SUBTYPE_BASE,
  ATTR_SUBTYPE_STRING,
  ATTR_SUBTYPE_INT,
  ATTR_SUBTYPE_LONG,
  ATTR_SUBTYPE_DOUBLE,
  ATTR_SUBTYPE_BOOLEAN,
  ATTR_SUBTYPE_CLASS,
  ATTR_SUBTYPE_PROPERTIES,
  ATTR_SUBTYPE_FILTER,
  ATTR_SUBTYPE_EXPRESSION,
  ATTR_SUBTYPE_INT_MAP,
] as const;
export type AttrSubType =
  | (typeof ATTR_SUBTYPES)[number]
  | typeof ATTR_SUBTYPE_STRINGARRAY;
