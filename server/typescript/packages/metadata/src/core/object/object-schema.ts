// Object attribute schemas — attrs common to every object subtype.
// Consumed by registerCoreTypes().

import type { AttrSchema } from "../../registry.js";
import { ATTR_SUBTYPE_STRING } from "../attr/attr-constants.js";
import {
  OBJECT_ATTR_DISCRIMINATOR,
  OBJECT_ATTR_DISCRIMINATOR_VALUE,
} from "./object-constants.js";

/** Attrs common to every object subtype. */
export const objectAttrs: AttrSchema[] = [
  {
    name: OBJECT_ATTR_DISCRIMINATOR,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    description:
      "FR-014: names the field on this entity (resolvable via extends:) that " +
      "holds the subtype-discriminator value. Subtypes of this entity declare " +
      "@discriminatorValue to bind their rows to a discriminator value. The " +
      "discriminator field itself is an ordinary field declaration (typically " +
      "field.enum or field.int / field.string).",
  },
  {
    name: OBJECT_ATTR_DISCRIMINATOR_VALUE,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    description:
      "FR-014: on a subtype of an entity with @discriminator — the value that " +
      "identifies rows of this subtype in the shared discriminator field. Wire " +
      "form is always a string; the underlying field's subtype (enum / int / " +
      "string) controls codegen + storage coercion. Required on every concrete " +
      "subtype of a discriminated entity.",
  },
];
