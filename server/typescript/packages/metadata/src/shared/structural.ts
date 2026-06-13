// Structural vocabulary — reserved body keys, JSON special keys, separators, wildcards, package paths.

// ---------------------------------------------------------------------------
// Reserved structural body keys (redesigned format — NOT @-prefixed, NOT attrs)
//
// Every node body is a map whose only permitted non-@ keys are these. The
// canonical body-key order is: name, package, extends, abstract, overlay,
// isArray, @-attrs (alphabetical), children.
// ---------------------------------------------------------------------------

export const RESERVED_KEY_NAME = "name";
export const RESERVED_KEY_PACKAGE = "package";
export const RESERVED_KEY_EXTENDS = "extends";   // the supertype reference
export const RESERVED_KEY_ABSTRACT = "abstract"; // true → the node is abstract
export const RESERVED_KEY_OVERLAY = "overlay";   // true → re-opens an existing same-named node
export const RESERVED_KEY_IS_ARRAY = "isArray";  // true → the node is an array
export const RESERVED_KEY_CHILDREN = "children";

/** attr-child-node body key carrying the typed value. */
export const RESERVED_KEY_VALUE = "value";

export const RESERVED_KEYS = new Set<string>([
  RESERVED_KEY_NAME,
  RESERVED_KEY_PACKAGE,
  RESERVED_KEY_EXTENDS,
  RESERVED_KEY_ABSTRACT,
  RESERVED_KEY_OVERLAY,
  RESERVED_KEY_IS_ARRAY,
  RESERVED_KEY_CHILDREN,
  RESERVED_KEY_VALUE,
]);

// ---------------------------------------------------------------------------
// JSON document special keys (top-level, ignored during wrapper-key detection)
// ---------------------------------------------------------------------------

export const JSON_KEY_SCHEMA = "$schema";

// ---------------------------------------------------------------------------
// Inline attribute prefix + fused type.subType key separator
// ---------------------------------------------------------------------------

export const ATTR_PREFIX = "@";

/** Separator fusing type and subType in a node's wrapper key (`object.entity`). */
export const TYPE_SUBTYPE_SEPARATOR = ".";

// ---------------------------------------------------------------------------
// Package path conventions
// ---------------------------------------------------------------------------

/** Separator between package segments and between package and name. */
export const PACKAGE_SEPARATOR = "::";

/**
 * FR-024 (ADR-0029): separator between an owner object and a nested child in a
 * dotted `extends` reference (`Customer.id`, `acme::sales::Customer.id`).
 * Names cannot contain `.`, so a `.` in the final `::`-segment of a ref
 * unambiguously marks a child-targeting reference.
 */
export const CHILD_REF_SEPARATOR = ".";

/** Relative-reference "go up one level" marker. */
export const PACKAGE_PARENT = "..";

// ---------------------------------------------------------------------------
// Wildcard for child-rule matching
// ---------------------------------------------------------------------------

export const CHILD_RULE_WILDCARD = "*";
