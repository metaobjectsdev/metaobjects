// Identity attribute schemas — per-subtype attr inventories for identity types.
// Consumed by registerCoreTypes().

import type { AttrSchema } from "../../registry.js";
import {
  ATTR_SUBTYPE_STRING,
  ATTR_SUBTYPE_BOOLEAN,
} from "../attr/attr-constants.js";
import {
  IDENTITY_SUBTYPE_PRIMARY,
  IDENTITY_SUBTYPE_SECONDARY,
  IDENTITY_SUBTYPE_REFERENCE,
  IDENTITY_ATTR_FIELDS,
  IDENTITY_ATTR_GENERATION,
  IDENTITY_ATTR_UNIQUE,
  IDENTITY_REFERENCE_ATTR_REFERENCES,
  IDENTITY_REFERENCE_ATTR_ENFORCE,
  GENERATION_VALUES,
} from "./identity-constants.js";

/** Attrs on identity.primary / identity.secondary — @fields is required. */
export const identityFieldsAttr: AttrSchema = {
  name: IDENTITY_ATTR_FIELDS,
  valueType: ATTR_SUBTYPE_STRING,
  isArray: true,
  required: true,
  description:
    "The field name(s) composing this identity. Single-element for a simple PK/index, multiple for a composite.",
};

const primaryIdentityAttrs: AttrSchema[] = [
  { ...identityFieldsAttr },
  {
    name: IDENTITY_ATTR_GENERATION,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    allowedValues: [...GENERATION_VALUES],
    description:
      "Primary-key value generation strategy: 'increment' (auto-increment), 'uuid', or 'assigned' (caller-supplied).",
  },
];

const secondaryIdentityAttrs: AttrSchema[] = [
  { ...identityFieldsAttr },
  {
    name: IDENTITY_ATTR_UNIQUE,
    valueType: ATTR_SUBTYPE_BOOLEAN,
    required: false,
    description:
      "When true (default), the secondary identity is a UNIQUE index; false makes it a plain (non-unique) index.",
  },
];

const referenceIdentityAttrs: AttrSchema[] = [
  { ...identityFieldsAttr },
  {
    name: IDENTITY_REFERENCE_ATTR_REFERENCES,
    valueType: ATTR_SUBTYPE_STRING,
    required: true,
    description:
      "Target of the reference. Bare entity name (e.g. 'Program') resolves to that entity's primary identity. " +
      "Dotted forms ('Program.id' or 'Program.fieldA,fieldB') target an explicit field set on the entity.",
  },
  {
    name: IDENTITY_REFERENCE_ATTR_ENFORCE,
    valueType: ATTR_SUBTYPE_BOOLEAN,
    required: false,
    description:
      "When true (default), the backend physically enforces the reference (SQL FK constraint, " +
      "document validation rule, graph edge guarantee). Set false to declare a logical reference " +
      "for navigation/typing/codegen only — the value may dangle at the backend level.",
  },
];

/** Attrs per identity subtype. primary adds @generation; secondary adds @unique. */
export const IDENTITY_ATTRS_MAP = new Map<string, AttrSchema[]>([
  [IDENTITY_SUBTYPE_PRIMARY, [...primaryIdentityAttrs]],
  [IDENTITY_SUBTYPE_SECONDARY, [...secondaryIdentityAttrs]],
  [IDENTITY_SUBTYPE_REFERENCE, [...referenceIdentityAttrs]],
]);
