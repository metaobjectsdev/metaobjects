// Base type vocabulary — the 12 registered base types + universal/metadata subtypes.

// ---------------------------------------------------------------------------
// Base type names (the registered base types — Java metaobjects-core vocabulary,
// plus `prompt`, the TS-first FR-004 addition for prompt construction)
// ---------------------------------------------------------------------------

export const TYPE_METADATA = "metadata";
export const TYPE_OBJECT = "object";
export const TYPE_FIELD = "field";
export const TYPE_ATTR = "attr";
export const TYPE_VALIDATOR = "validator";
export const TYPE_VIEW = "view";
export const TYPE_IDENTITY = "identity";
export const TYPE_RELATIONSHIP = "relationship";
export const TYPE_LAYOUT = "layout";
export const TYPE_SOURCE = "source";
export const TYPE_ORIGIN = "origin";
export const TYPE_PROMPT = "prompt";

export const BASE_TYPES = [
  TYPE_METADATA,
  TYPE_OBJECT,
  TYPE_FIELD,
  TYPE_ATTR,
  TYPE_VALIDATOR,
  TYPE_VIEW,
  TYPE_IDENTITY,
  TYPE_RELATIONSHIP,
  TYPE_LAYOUT,
  TYPE_SOURCE,
  TYPE_ORIGIN,
  TYPE_PROMPT,
] as const;
export type BaseType = (typeof BASE_TYPES)[number];

// ---------------------------------------------------------------------------
// Universal subtype
// ---------------------------------------------------------------------------

export const SUBTYPE_BASE = "base";

// ---------------------------------------------------------------------------
// Metadata subtypes (1)
// ---------------------------------------------------------------------------

/**
 * The metadata document root subtype. The root node is `metadata.root` in the
 * canonical format. (Distinct from the universal SUBTYPE_BASE — the redesigned
 * format spec confirms the root subtype is `root`, not `base`.)
 */
export const SUBTYPE_ROOT = "root";

export const METADATA_SUBTYPES = [SUBTYPE_ROOT] as const;
export type MetadataSubType = (typeof METADATA_SUBTYPES)[number];
