// server/typescript/packages/metadata/src/semantic-diff.ts
//
// FR5a / ADR-0009 — Cross-port-aligned semantic-equality compare for metadata
// trees. Returns `true` if the two inputs differ in any semantically-meaningful
// way (excluding `source`, which is loader output).
//
// Algorithm (ADR-0009 §semantic_diff):
//   1. Sort attrs lexicographically; compare attr-by-attr; values by canonical
//      structural equality (key-order independent, whitespace-insensitive).
//   2. Children are compared as ordered sequences.
//   3. Reserved structural keys (name, package, extends, abstract, overlay,
//      isArray, value) participate like attrs.
//   4. `source` excluded from the diff.

type Tree = Record<string, unknown>;

const EXCLUDED = new Set(["source"]);

function isObject(v: unknown): v is Tree {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!equal(a[i], b[i])) return false;
    }
    return true;
  }
  if (isObject(a) && isObject(b)) {
    const aKeys = Object.keys(a).filter((k) => !EXCLUDED.has(k)).sort();
    const bKeys = Object.keys(b).filter((k) => !EXCLUDED.has(k)).sort();
    if (aKeys.length !== bKeys.length) return false;
    for (let i = 0; i < aKeys.length; i++) {
      if (aKeys[i] !== bKeys[i]) return false;
      if (!equal(a[aKeys[i]!], b[bKeys[i]!])) return false;
    }
    return true;
  }
  return false;
}

/** Returns `true` if the inputs differ in any semantically-meaningful way. */
export function semanticDiff(a: Tree, b: Tree): boolean {
  return !equal(a, b);
}
