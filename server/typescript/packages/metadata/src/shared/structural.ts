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


/**
 * The reserved structural keywords that can NEVER be an attribute, mapped to the
 * native accessor that answers the same question.
 *
 * `value` is deliberately absent: an `attr` node stores its own typed payload under
 * that key and reads it back with `ownAttr(RESERVED_KEY_VALUE)`, which is the one
 * legitimate reserved-key attr read in the model.
 */
export const STRUCTURAL_KEYWORD_ACCESSORS: ReadonlyMap<string, string> = new Map([
  [RESERVED_KEY_NAME, "the `.name` property"],
  [RESERVED_KEY_PACKAGE, "the `.package` property (or effectivePackage(node) for the file-default fold)"],
  [RESERVED_KEY_EXTENDS, "the `.superData` property"],
  [RESERVED_KEY_ABSTRACT, "the `.isAbstract` property"],
  [RESERVED_KEY_OVERLAY, "the node's overlay flag"],
  [RESERVED_KEY_IS_ARRAY, "`.resolvedIsArray()` (NOT the `.isArray` own flag — that one drops what `extends` contributes)"],
  [RESERVED_KEY_CHILDREN, "`.children()`"],
]);

/**
 * Refuse an attribute lookup for a reserved structural keyword.
 *
 * These names are NATIVE PROPERTIES, not attributes: `@isArray` and friends are
 * rejected at the load with ERR_RESERVED_ATTR, so no document can ever set one and
 * the lookup can only ever answer `undefined`. That answer is indistinguishable
 * from "the author did not set that attribute", which is what made this silent.
 *
 * It was not hypothetical. An adopter's own generator typed a field as
 * `f.attr("isArray") === true ? base + "[]" : base`, and the reference document it
 * generated — the one bot authors read — described ALL 31 of that model's array
 * fields as scalars. Its sibling module had used the resolving accessor since the
 * day it was written, with a comment naming the trap, and nothing compared the two.
 * The file's own header taught the rule fourteen lines above the violation: prose
 * is not a gate.
 *
 * A throw rather than a warning because there is no reading under which this call
 * is correct, and the fix is one line at the call site.
 */
export function assertNotStructuralKeyword(name: string, accessor: string): void {
  const native = STRUCTURAL_KEYWORD_ACCESSORS.get(name);
  if (native === undefined) return;
  throw new Error(
    `${accessor}(${JSON.stringify(name)}): '${name}' is a reserved structural keyword, ` +
      `not an attribute — '@${name}' fails the load with ERR_RESERVED_ATTR, so this ` +
      `lookup can only ever return undefined. Read ${native} instead.`,
  );
}

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
