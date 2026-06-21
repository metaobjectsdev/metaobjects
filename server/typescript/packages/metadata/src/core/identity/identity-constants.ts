// Identity concern constants — subtypes, attr keys, and generation strategy values.

// ---------------------------------------------------------------------------
// Identity subtypes (3: primary, secondary, reference — NO base; Java doesn't register one)
// ---------------------------------------------------------------------------

export const IDENTITY_SUBTYPE_PRIMARY = "primary";
export const IDENTITY_SUBTYPE_SECONDARY = "secondary";
export const IDENTITY_SUBTYPE_REFERENCE = "reference";

export const IDENTITY_SUBTYPES = [
  IDENTITY_SUBTYPE_PRIMARY,
  IDENTITY_SUBTYPE_SECONDARY,
  IDENTITY_SUBTYPE_REFERENCE,
] as const;
export type IdentitySubType = (typeof IDENTITY_SUBTYPES)[number];

// ---------------------------------------------------------------------------
// Identity attrs
// ---------------------------------------------------------------------------

export const IDENTITY_ATTR_FIELDS = "fields";
export const IDENTITY_ATTR_GENERATION = "generation";
/** On secondary identities: true → uniqueIndex; false/absent → index. Defaults to true for back-compat. */
export const IDENTITY_ATTR_UNIQUE = "unique";
/** Identity-reference attr: target entity (bare or dotted `Entity.field` / `Entity.fA,fB`). */
export const IDENTITY_REFERENCE_ATTR_REFERENCES = "references";
/** Identity-reference attr: physical-enforcement flag. Default true → hard FK constraint; false → logical-only reference. */
export const IDENTITY_REFERENCE_ATTR_ENFORCE = "enforce";
/** Identity-reference attr: referential action on parent delete (cascade/set-null/restrict/no-action). */
export const IDENTITY_REFERENCE_ATTR_ON_DELETE = "onDelete";
/** Identity-reference attr: referential action on key update (cascade/set-null/restrict/no-action). */
export const IDENTITY_REFERENCE_ATTR_ON_UPDATE = "onUpdate";

// NOTE: physical RDB-only identity attrs (@constraintName on identity.reference;
// @orders / @where on identity.secondary) are NOT core — they are contributed by
// the db provider and declared in persistence/db/db-constants.ts.

// ---------------------------------------------------------------------------
// Identity generation strategies (values for IDENTITY_ATTR_GENERATION)
// ---------------------------------------------------------------------------

export const GENERATION_INCREMENT = "increment";
export const GENERATION_UUID = "uuid";
export const GENERATION_ASSIGNED = "assigned";

export const GENERATION_VALUES = [
  GENERATION_INCREMENT,
  GENERATION_UUID,
  GENERATION_ASSIGNED,
] as const;
export type GenerationValue = (typeof GENERATION_VALUES)[number];
