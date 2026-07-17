// Object concern constants — subtypes for the object.* type family.

import { SUBTYPE_BASE } from "../../shared/base-types.js";

// ---------------------------------------------------------------------------
// Object subtypes (cross-language, conceptual)
// ---------------------------------------------------------------------------
//
//   - base   : abstract template (no runtime semantics)
//   - entity : persistent record (typically has @primary identity)
//   - value  : value-object (no identity; equality by content)
//   - projection : derived read-only representation of entities (FR-024, ADR-0028)
//
export const OBJECT_SUBTYPE_ENTITY = "entity";
export const OBJECT_SUBTYPE_VALUE = "value";
export const OBJECT_SUBTYPE_PROJECTION = "projection";

export const OBJECT_SUBTYPES = [
  SUBTYPE_BASE,
  OBJECT_SUBTYPE_ENTITY,
  OBJECT_SUBTYPE_VALUE,
  OBJECT_SUBTYPE_PROJECTION,
] as const;
export type ObjectSubType = (typeof OBJECT_SUBTYPES)[number];

// ---------------------------------------------------------------------------
// FR-014 — TPH discriminator (Table-per-Hierarchy single-table inheritance)
// ---------------------------------------------------------------------------
// Both attrs live on object.entity. Logical layer (ADR-0013): metadata
// describes the polymorphism; codegen / ORM emit the per-stack idiom
// (EF HasDiscriminator / JPA @DiscriminatorColumn / SQLAlchemy polymorphic_on
// / Kotlin sealed class / TS discriminated union).

/** FR-014: names the field on this entity (resolvable via extends) that holds
 *  the subtype-discriminator value. Subtypes declare @discriminatorValue to
 *  bind their rows to a value of that field. */
export const OBJECT_ATTR_DISCRIMINATOR = "discriminator";

/** FR-014: on a subtype of an entity with @discriminator: the value that
 *  identifies rows of this subtype in the shared discriminator field. */
export const OBJECT_ATTR_DISCRIMINATOR_VALUE = "discriminatorValue";

// ---------------------------------------------------------------------------
// #207 — projection row-scope @filter (view-level WHERE)
// ---------------------------------------------------------------------------
/** #207: an optional row-scope predicate on an object.projection (an attr.filter
 *  object) selecting which rows the derived view returns — lowered to an outer
 *  SQL WHERE. Mirrors origin.aggregate's @filter placement (attr.filter subType),
 *  but resolves against the projection's OWN declared fields rather than one
 *  aggregated entity. An aggregate-derived field is not addressable (fail-closed). */
export const OBJECT_PROJECTION_ATTR_FILTER = "filter";
