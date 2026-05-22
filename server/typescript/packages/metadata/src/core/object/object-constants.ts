// Object concern constants — subtypes for the object.* type family.

import { SUBTYPE_BASE } from "../../shared/base-types.js";

// ---------------------------------------------------------------------------
// Object subtypes (cross-language, conceptual)
// ---------------------------------------------------------------------------
//
//   - base   : abstract template (no runtime semantics)
//   - entity : persistent record (typically has @primary identity)
//   - value  : value-object (no identity; equality by content)
//
export const OBJECT_SUBTYPE_ENTITY = "entity";
export const OBJECT_SUBTYPE_VALUE = "value";

export const OBJECT_SUBTYPES = [
  SUBTYPE_BASE,
  OBJECT_SUBTYPE_ENTITY,
  OBJECT_SUBTYPE_VALUE,
] as const;
export type ObjectSubType = (typeof OBJECT_SUBTYPES)[number];
