// Index concern constants — type name, subtypes, and attr keys.

// ---------------------------------------------------------------------------
// Index type name (re-exported from shared/base-types.ts as TYPE_INDEX)
// ---------------------------------------------------------------------------

/**
 * Index type name as the brief-specified interface name.
 * Downstream tasks import `INDEX` from here; `TYPE_INDEX` comes from base-types.
 */
export const INDEX = "index";

// ---------------------------------------------------------------------------
// Index subtypes (1: lookup)
// ---------------------------------------------------------------------------

export const INDEX_SUBTYPE_LOOKUP = "lookup";

export const INDEX_SUBTYPES = [INDEX_SUBTYPE_LOOKUP] as const;
export type IndexSubType = (typeof INDEX_SUBTYPES)[number];

// ---------------------------------------------------------------------------
// Index attrs (logical — core)
// ---------------------------------------------------------------------------

/** The field name(s) composing this index. */
export const INDEX_ATTR_FIELDS = "fields";

// NOTE: physical RDB-only index attrs (@using / @expr / @where / @orders) are
// NOT core — they are contributed by the db provider, reusing the existing
// IDENTITY_ATTR_* constants in persistence/db/db-constants.ts.
