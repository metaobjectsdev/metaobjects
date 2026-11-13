// Base type vocabulary — the 12 registered base types + universal/metadata subtypes.

// ---------------------------------------------------------------------------
// Base type names (the registered base types — Java metaobjects-core vocabulary,
// plus `template`, the TS-first FR-004 addition for prompt construction)
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
export const TYPE_TEMPLATE = "template";
/** Non-unique lookup indexes — `index.lookup` is the only registered subtype. */
export const TYPE_INDEX = "index";
/** Capability / requirement records — `requirement.functional` (existence check)
 *  and `requirement.architectural` (universality check). Ruling amendment 3. */
export const TYPE_REQUIREMENT = "requirement";
/** FR-044 reporting vocabulary — a named group-by attribute (`dimension.attribute`,
 *  `dimension.time`), a named aggregate (`measure.aggregate`, `measure.ratio`) and a
 *  named row filter (`segment.filter`), all declared on an `object.entity`. */
export const TYPE_DIMENSION = "dimension";
export const TYPE_MEASURE = "measure";
export const TYPE_SEGMENT = "segment";
/** ADR-0030 / ADR-0063 — the declared API surface: `api.operational` holds
 *  `operation.command` / `operation.query`, each optionally carrying a `binding.rest`. */
export const TYPE_API = "api";
export const TYPE_OPERATION = "operation";
export const TYPE_BINDING = "binding";
/** ADR-0063 — an allowed move between two members of a `field.enum` (`transition.action`). */
export const TYPE_TRANSITION = "transition";

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
  TYPE_TEMPLATE,
  TYPE_INDEX,
  TYPE_REQUIREMENT,
  TYPE_DIMENSION,
  TYPE_MEASURE,
  TYPE_SEGMENT,
  TYPE_API,
  TYPE_OPERATION,
  TYPE_BINDING,
  TYPE_TRANSITION,
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
