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
/** M:N junction (through) entity — a third entity declaring two identity.reference children. */
export const RELATIONSHIP_ATTR_THROUGH = "through";
/** M:N directed-self-join disambiguator — names the source-side FK field on the junction. */
export const RELATIONSHIP_ATTR_SOURCE_REF_FIELD = "sourceRefField";
/** M:N undirected-self-join flag — union-on-read; valid only when objectRef == the declaring entity. */
export const RELATIONSHIP_ATTR_SYMMETRIC = "symmetric";

// ---------------------------------------------------------------------------
// Relationship cardinality values (for RELATIONSHIP_ATTR_CARDINALITY)
// ---------------------------------------------------------------------------

export const CARDINALITY_ONE = "one";
export const CARDINALITY_MANY = "many";

export const CARDINALITY_VALUES = [CARDINALITY_ONE, CARDINALITY_MANY] as const;
export type CardinalityValue = (typeof CARDINALITY_VALUES)[number];

// ---------------------------------------------------------------------------
// Referential action attrs (@onDelete / @onUpdate)
// ---------------------------------------------------------------------------

export const RELATIONSHIP_ATTR_ON_DELETE = "onDelete";
export const RELATIONSHIP_ATTR_ON_UPDATE = "onUpdate";

/** Referential actions — the canonical cross-language set (kebab-case, no setDefault).
 *  MUST equal migrate-ts's FkAction union (server/typescript/packages/migrate-ts/src/types.ts). */
export const REFERENTIAL_ACTIONS = ["cascade", "set-null", "restrict", "no-action"] as const;
export type ReferentialAction = (typeof REFERENTIAL_ACTIONS)[number];

/** Default @onDelete per relationship subtype (rollout decided defaults). */
export const ON_DELETE_DEFAULT_BY_SUBTYPE: Readonly<Record<string, ReferentialAction>> = {
  [RELATIONSHIP_SUBTYPE_COMPOSITION]: "cascade",
  [RELATIONSHIP_SUBTYPE_AGGREGATION]: "set-null",
  [RELATIONSHIP_SUBTYPE_ASSOCIATION]: "restrict",
};
export const ON_UPDATE_DEFAULT: ReferentialAction = "cascade";
