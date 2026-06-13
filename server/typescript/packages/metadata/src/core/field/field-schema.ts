// Field attribute schema(s) still authored as code.
//
// FR-033: the FIELD provider's per-subtype attr constraints + descriptions are
// externalized to spec/metamodel/field.json (embedded as FIELD_DEFINITION) and
// lowered via defineProviderFromData. What remains here is `normalizeAttr` —
// shared between field.enum AND object.value (the object-level default
// normalization mode for its enum fields), so it stays a code-shared AttrSchema
// consumed by core-types.ts when registering object.value.

import type { AttrSchema } from "../../registry.js";
import { ATTR_SUBTYPE_STRING } from "../attr/attr-constants.js";
import {
  FIELD_ATTR_NORMALIZE,
  NORMALIZE_MODES,
  NORMALIZE_DEFAULT,
} from "./field-constants.js";

/** FR-011: the @normalize attr — on field.enum (per-field) and object.value (object default).
 *  Closed enum (none|collapse|strip); controls the ASCII normalization applied during tolerant
 *  enum extract. Resolved field → owning object.value → global default (strip). */
export const normalizeAttr: AttrSchema = {
  name: FIELD_ATTR_NORMALIZE,
  valueType: ATTR_SUBTYPE_STRING,
  required: false,
  default: NORMALIZE_DEFAULT,
  allowedValues: [...NORMALIZE_MODES],
  description:
    "ASCII normalization mode for tolerant enum extract (none|collapse|strip, default strip). " +
    "On field.enum it is per-field; on object.value it is the default for the object's enum fields.",
};
