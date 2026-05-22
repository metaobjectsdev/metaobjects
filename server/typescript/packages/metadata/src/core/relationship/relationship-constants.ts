// Relationship concern constants — subtypes, attr keys, and cardinality values.

import { SUBTYPE_BASE } from "../../shared/base-types.js";

// ---------------------------------------------------------------------------
// Relationship subtypes (4)
// ---------------------------------------------------------------------------

export const RELATIONSHIP_SUBTYPE_ASSOCIATION = "association";
export const RELATIONSHIP_SUBTYPE_AGGREGATION = "aggregation";
export const RELATIONSHIP_SUBTYPE_COMPOSITION = "composition";

export const RELATIONSHIP_SUBTYPES = [
  SUBTYPE_BASE,
  RELATIONSHIP_SUBTYPE_ASSOCIATION,
  RELATIONSHIP_SUBTYPE_AGGREGATION,
  RELATIONSHIP_SUBTYPE_COMPOSITION,
] as const;
export type RelationshipSubType = (typeof RELATIONSHIP_SUBTYPES)[number];

// ---------------------------------------------------------------------------
// Relationship attrs
// ---------------------------------------------------------------------------

export const RELATIONSHIP_ATTR_CARDINALITY = "cardinality";
export const RELATIONSHIP_ATTR_OBJECT_REF = "objectRef";
export const RELATIONSHIP_ATTR_JOIN_ENTITY = "joinEntity";    // N:M cardinality
export const RELATIONSHIP_ATTR_JOIN_FIELDS = "joinFields";    // N:M cardinality

// ---------------------------------------------------------------------------
// Relationship cardinality values (for RELATIONSHIP_ATTR_CARDINALITY)
// ---------------------------------------------------------------------------

export const CARDINALITY_ONE = "one";
export const CARDINALITY_MANY = "many";

export const CARDINALITY_VALUES = [CARDINALITY_ONE, CARDINALITY_MANY] as const;
export type CardinalityValue = (typeof CARDINALITY_VALUES)[number];
