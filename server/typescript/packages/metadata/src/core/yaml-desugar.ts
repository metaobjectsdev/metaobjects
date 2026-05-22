// YAML authoring → canonical desugar.
//
// desugar() turns the sugared authoring object (from yaml.parse) into the
// canonical-shaped object that buildTree (parser-core.ts) consumes. It applies
// the four format-spec sugar rules:
//   1. Fused key, subType omittable — a bare `type` key resolves to the type's
//      registry default subType.
//   2. Scalar-or-map body — a scalar body becomes { name: <scalar> }.
//   3. Omit empties — absent keys stay absent; the desugar invents nothing.
//   4. `[]` arrays — a trailing `[]` on the key strips to isArray: true.
//
// Pure and total: it never throws. Malformed fragments are collected as error
// strings and a safe placeholder is substituted so buildTree does not
// double-report.

import type { TypeRegistry } from "../registry.js";
import {
  RESERVED_KEY_CHILDREN,
  RESERVED_KEY_NAME,
  RESERVED_KEY_IS_ARRAY,
  TYPE_SUBTYPE_SEPARATOR,
} from "../shared/structural.js";

const ARRAY_SUFFIX = "[]";

export interface DesugarResult {
  /** The canonical-shaped object; `{}` when the document was unusable. */
  canonical: Record<string, unknown>;
  /** Collected desugar problems (never thrown). */
  errors: string[];
}

/** Desugar a parsed-YAML authoring document into a canonical-shaped object. */
export function desugar(input: unknown, registry: TypeRegistry): DesugarResult {
  const errors: string[] = [];
  const node = desugarNode(input, registry, errors, "<root>");
  return { canonical: node ?? {}, errors };
}

// Desugar one node — a single-key mapping { "type.subType": body }.
// Returns the canonical node object, or undefined if `input` is not a usable
// node (the caller substitutes a placeholder).
function desugarNode(
  input: unknown,
  registry: TypeRegistry,
  errors: string[],
  path: string,
): Record<string, unknown> | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    errors.push(`Node at ${path} must be a mapping with one type key`);
    return undefined;
  }

  const entries = Object.keys(input as Record<string, unknown>);
  if (entries.length !== 1) {
    errors.push(
      `Node at ${path} must have exactly one type key (found: ${
        entries.length === 0 ? "none" : entries.join(", ")
      })`,
    );
    return undefined;
  }

  const rawKey = entries[0]!;
  const rawBody = (input as Record<string, unknown>)[rawKey];

  // Rule 4: a trailing "[]" on the key → isArray.
  let key = rawKey;
  let isArray = false;
  if (key.endsWith(ARRAY_SUFFIX)) {
    key = key.slice(0, -ARRAY_SUFFIX.length);
    isArray = true;
  }

  // Rule 1: a bare `type` key → the type's registry default subType.
  const canonicalKey = resolveKey(key, registry, errors, path);

  // Rule 2: a scalar body → { name: <scalar> }.
  const body = desugarBody(rawBody, errors, path);

  // Rule 4 (cont.): stamp isArray onto the canonical body.
  if (isArray) body[RESERVED_KEY_IS_ARRAY] = true;

  // Recurse into children.
  const rawChildren = body[RESERVED_KEY_CHILDREN];
  if (Array.isArray(rawChildren)) {
    const children: unknown[] = [];
    for (let i = 0; i < rawChildren.length; i++) {
      const childPath = `${path}.${RESERVED_KEY_CHILDREN}[${i}]`;
      const child = desugarNode(rawChildren[i], registry, errors, childPath);
      // On a bad child keep an empty-object placeholder so sibling indices
      // stay stable; the error is already collected.
      children.push(child ?? {});
    }
    body[RESERVED_KEY_CHILDREN] = children;
  }
  // A non-array `children` value is left untouched — buildTree reports it.

  return { [canonicalKey]: body };
}

// Rule 1 — resolve a possibly-bare key to a fused `type.subType` token.
function resolveKey(
  key: string,
  registry: TypeRegistry,
  errors: string[],
  path: string,
): string {
  if (key.includes(TYPE_SUBTYPE_SEPARATOR)) return key; // already fused
  const subType = registry.defaultSubTypeOf(key);
  if (subType === undefined) {
    errors.push(
      `Cannot resolve subType for bare type key '${key}' at ${path} — ` +
        `type '${key}' has no default subType; write the full 'type.subType'`,
    );
    return key; // pass through; buildTree reports the unknown type
  }
  return `${key}${TYPE_SUBTYPE_SEPARATOR}${subType}`;
}

// Rule 2 — normalize a node body into a canonical mapping.
function desugarBody(
  rawBody: unknown,
  errors: string[],
  path: string,
): Record<string, unknown> {
  if (
    typeof rawBody === "string" ||
    typeof rawBody === "number" ||
    typeof rawBody === "boolean"
  ) {
    return { [RESERVED_KEY_NAME]: rawBody };
  }
  if (rawBody === null || rawBody === undefined) {
    // An empty body (`field.string:` with nothing after) → an empty node.
    return {};
  }
  if (Array.isArray(rawBody)) {
    errors.push(`Node body at ${path} must be a scalar or mapping, not a list`);
    return {};
  }
  // A mapping — shallow-copy so isArray / children replacement do not mutate
  // the caller's parsed-YAML object.
  return { ...(rawBody as Record<string, unknown>) };
}
