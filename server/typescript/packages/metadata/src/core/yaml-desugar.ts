// YAML authoring → canonical desugar.
//
// desugar() turns the sugared authoring object (from yaml.parse) into the
// canonical-shaped object that buildTree (parser-core.ts) consumes. It applies
// the five format-spec sugar rules (ADR-0006):
//   1. Fused key, subType omittable — a bare `type` key resolves to the type's
//      registry default subType.
//   2. Scalar-or-map body — a scalar body becomes { name: <scalar> }.
//   3. Omit empties — absent keys stay absent; the desugar invents nothing.
//   4. `[]` arrays — a trailing `[]` on the key strips to isArray: true.
//   5. Sigil-free attributes (ADR-0006 D1) — every body key not in
//      RESERVED_KEYS is treated as an inline attribute and re-prefixed with `@`
//      when lowering to canonical JSON. Keys already prefixed with `@` are
//      left as-is (backward-compat). Reserved structural keywords (name,
//      package, extends, abstract, overlay, isArray, children, value) stay
//      bare. Note: an already-`@`-prefixed reserved word remains an error
//      downstream — parser-core's ERR_RESERVED_ATTR check fires.
//
// In addition, the desugar runs the ADR-0006 D2 type-coercion guard: for every
// inline attr whose owning (type, subType) has a declared schema, if the raw
// JS value's type does not match the declared valueType AND the JS value is
// one of YAML 1.2's silently coerced shapes (boolean/number/null), the
// desugar collects an ERR_YAML_COERCION error telling the author to quote the
// value. The check protects against the classic YAML footgun (e.g. an unquoted
// `column: TRUE` becoming the boolean `true` instead of the string "TRUE").
//
// Pure and total: it never throws. Malformed fragments are collected as
// CollectedError entries (a string message + optional stable error code) and a
// safe placeholder is substituted so buildTree does not double-report.

import type { TypeRegistry, AttrSchema } from "../registry.js";
import type { ErrorCode } from "../errors.js";
import {
  ATTR_PREFIX,
  RESERVED_KEYS,
  RESERVED_KEY_CHILDREN,
  RESERVED_KEY_NAME,
  RESERVED_KEY_PACKAGE,
  RESERVED_KEY_EXTENDS,
  RESERVED_KEY_IS_ARRAY,
  TYPE_SUBTYPE_SEPARATOR,
  PACKAGE_SEPARATOR,
} from "../shared/structural.js";
import { expandRef, REF_BEARING_ATTR_NAMES } from "../naming-refs.js";
import {
  getPositionMap,
  setPositionMap,
  type PositionMap,
} from "./yaml-positions.js";
import {
  ATTR_SUBTYPE_STRING,
  ATTR_SUBTYPE_CLASS,
  ATTR_SUBTYPE_INT,
  ATTR_SUBTYPE_LONG,
  ATTR_SUBTYPE_DOUBLE,
  ATTR_SUBTYPE_BOOLEAN,
  ATTR_SUBTYPE_STRINGARRAY,
} from "./attr/attr-constants.js";

const ARRAY_SUFFIX = "[]";

/** A collected desugar problem — message plus optional stable error code. */
export interface CollectedError {
  message: string;
  /** Optional stable code; absent values map to ERR_MALFORMED_YAML in parser-yaml.ts. */
  code?: ErrorCode;
}

export interface DesugarResult {
  /** The canonical-shaped object; `{}` when the document was unusable. */
  canonical: Record<string, unknown>;
  /** Collected desugar problems (never thrown). */
  errors: CollectedError[];
}

/** Desugar a parsed-YAML authoring document into a canonical-shaped object. */
export function desugar(input: unknown, registry: TypeRegistry): DesugarResult {
  const errors: CollectedError[] = [];
  // FR-032 (ADR-0032): the desugar threads the effective package context down
  // the tree so every ref-bearing attr (extends + @objectRef/@references/@from/
  // @of/@via/@parameterRef/@payloadRef/@responseRef) is expanded to its FQN via
  // expandRef. The root context is empty (the metadata.root's own `package`
  // body key seeds the first real context inside desugarNode).
  const node = desugarNode(input, registry, errors, "<root>", "");
  return { canonical: node ?? {}, errors };
}

// FR-032: compute a node's effective package from its raw `package` body key
// (inheriting the parent context when absent). Mirrors parser-core's
// expandPackageForPath so the desugar's ref-expansion context matches the JSON
// loader's package resolution. The `package` attr itself is NEVER ref-expanded
// (ADR-0032 §2.1 — it is the node's identity, taken literally/absolute).
function effectivePackageFor(rawBody: unknown, parentPkg: string): string {
  if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) {
    return parentPkg;
  }
  const rawPkg = (rawBody as Record<string, unknown>)[RESERVED_KEY_PACKAGE];
  if (typeof rawPkg !== "string") return parentPkg;
  // Legacy expandPackageForPath: a leading "::" on a child package prepends the
  // parent; otherwise it is used as-is.
  if (parentPkg !== "" && rawPkg.startsWith(PACKAGE_SEPARATOR)) {
    return parentPkg + rawPkg;
  }
  return rawPkg;
}

// Desugar one node — a single-key mapping { "type.subType": body }.
// Returns the canonical node object, or undefined if `input` is not a usable
// node (the caller substitutes a placeholder).
function desugarNode(
  input: unknown,
  registry: TypeRegistry,
  errors: CollectedError[],
  path: string,
  parentPkg: string,
): Record<string, unknown> | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    errors.push({ message: `Node at ${path} must be a mapping with one type key` });
    return undefined;
  }

  const entries = Object.keys(input as Record<string, unknown>);
  if (entries.length !== 1) {
    errors.push({
      message:
        `Node at ${path} must have exactly one type key (found: ${
          entries.length === 0 ? "none" : entries.join(", ")
        })`,
    });
    return undefined;
  }

  const rawKey = entries[0]!;
  const rawBody = (input as Record<string, unknown>)[rawKey];

  // FR5b — capture the wrapper-level position-by-key map BEFORE re-keying.
  // The author's raw key (with `[]` suffix and possibly omitted subType) is
  // the lookup key; the desugar's canonical key is what we emit.
  const wrapperPositions = getPositionMap(input);

  // Rule 4: a trailing "[]" on the key → isArray.
  let key = rawKey;
  let isArray = false;
  if (key.endsWith(ARRAY_SUFFIX)) {
    key = key.slice(0, -ARRAY_SUFFIX.length);
    isArray = true;
  }

  // Rule 1: a bare `type` key → the type's registry default subType.
  const canonicalKey = resolveKey(key, registry, errors, path);

  // FR-032: this node's effective package context (its own `package` body key,
  // else inherited). Used to expand its ref-bearing attrs AND threaded to its
  // children so their bare/relative refs resolve against the right package.
  const nodePkg = effectivePackageFor(rawBody, parentPkg);

  // Rule 2: a scalar body → { name: <scalar> }.
  // FR5b — propagate the wrapper-key's position into the synthesized body
  // when the input body was a scalar (no body-side positions to inherit).
  const wrapperKeyPos = wrapperPositions?.[rawKey];
  const body = desugarBody(rawBody, registry, canonicalKey, errors, path, wrapperKeyPos, nodePkg);

  // Rule 4 (cont.): stamp isArray onto the canonical body.
  if (isArray) body[RESERVED_KEY_IS_ARRAY] = true;

  // Recurse into children.
  const rawChildren = body[RESERVED_KEY_CHILDREN];
  if (Array.isArray(rawChildren)) {
    const children: unknown[] = [];
    for (let i = 0; i < rawChildren.length; i++) {
      const childPath = `${path}.${RESERVED_KEY_CHILDREN}[${i}]`;
      const child = desugarNode(rawChildren[i], registry, errors, childPath, nodePkg);
      // On a bad child keep an empty-object placeholder so sibling indices
      // stay stable; the error is already collected.
      children.push(child ?? {});
    }
    body[RESERVED_KEY_CHILDREN] = children;
  }
  // A non-array `children` value is left untouched — buildTree reports it.

  // FR5b — emit a wrapper-level position-by-key map for the canonical wrapper
  // so buildTree's per-child iteration can read the position via the same
  // lookup it uses for JSON input. The single key transformation is
  // rawKey → canonicalKey (Rule 1 fuses the subType, Rule 4 strips `[]`).
  const outWrapper: Record<string, unknown> = { [canonicalKey]: body };
  if (wrapperKeyPos !== undefined) {
    setPositionMap(outWrapper, { [canonicalKey]: wrapperKeyPos });
  }

  return outWrapper;
}

// Rule 1 — resolve a possibly-bare key to a fused `type.subType` token.
function resolveKey(
  key: string,
  registry: TypeRegistry,
  errors: CollectedError[],
  path: string,
): string {
  if (key.includes(TYPE_SUBTYPE_SEPARATOR)) return key; // already fused
  const subType = registry.defaultSubTypeOf(key);
  if (subType === undefined) {
    errors.push({
      message:
        `Cannot resolve subType for bare type key '${key}' at ${path} — ` +
        `type '${key}' has no default subType; write the full 'type.subType'`,
    });
    return key; // pass through; buildTree reports the unknown type
  }
  return `${key}${TYPE_SUBTYPE_SEPARATOR}${subType}`;
}

// Rule 2 + 5 — normalize a node body into a canonical mapping. Reserved
// structural keys stay bare; every other key is treated as an inline attribute
// and `@`-prefixed (Rule 5 / ADR-0006 D1). Keys already starting with `@` are
// kept as-authored so the awkward "@column: foo" form remains accepted.
//
// Also runs the D2 type-coercion guard: for each inline attr that the owning
// (type, subType) declares with a typed `valueType`, if the raw JS value's
// type was silently coerced by YAML 1.2 to something incompatible (e.g. a
// `boolean` for a `string`-declared attr), an ERR_YAML_COERCION is collected.
function desugarBody(
  rawBody: unknown,
  registry: TypeRegistry,
  canonicalKey: string,
  errors: CollectedError[],
  path: string,
  /** FR5b — position of the WRAPPER key (the `field.string:` line). Used to
   *  back-fill `yamlPosition` on synthesized bodies (Rule 2's scalar lift) +
   *  empty bodies; for mapping bodies we use the body's own position-by-key
   *  map. */
  wrapperKeyPos: { line: number; col: number } | undefined,
  /** FR-032: this node's effective package context, used to expand its
   *  ref-bearing attrs (extends + @objectRef/@references/@from/@of/@via/
   *  @parameterRef/@payloadRef/@responseRef) to FQN via expandRef. */
  nodePkg: string,
): Record<string, unknown> {
  if (
    typeof rawBody === "string" ||
    typeof rawBody === "number" ||
    typeof rawBody === "boolean"
  ) {
    // FR5b — the synthesized `{ name: rawBody }` has no YAML-side
    // counterpart; we attribute the `name` slot to the wrapper-key's
    // position (the only YAML position that meaningfully belongs to this
    // synthesis).
    const out: Record<string, unknown> = { [RESERVED_KEY_NAME]: rawBody };
    if (wrapperKeyPos !== undefined) {
      setPositionMap(out, { [RESERVED_KEY_NAME]: wrapperKeyPos });
    }
    return out;
  }
  if (rawBody === null || rawBody === undefined) {
    // An empty body (`field.string:` with nothing after) → an empty node.
    // No body keys to position; the wrapper carries the node's position.
    return {};
  }
  if (Array.isArray(rawBody)) {
    errors.push({
      message: `Node body at ${path} must be a scalar or mapping, not a list`,
    });
    return {};
  }
  // A mapping — shallow-copy so isArray / children replacement do not mutate
  // the caller's parsed-YAML object, AND apply Rule 5 (sigil-free attrs) +
  // Rule D2 (type-coercion guard).
  const src = rawBody as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  // FR5b — translate the body's position-by-key map across the sigil-free
  // rewrite. A bare `filterable` key in the source maps to `@filterable` in
  // the canonical body; the YAML position belongs to BOTH names (the YAML
  // author only wrote one). We re-key the position map to match the canonical
  // body's keys so buildTree's per-attr inspection (FR5b follow-ups, e.g.
  // ERR_BAD_ATTR_VALUE) can find the position via the canonical key.
  const srcPositions = getPositionMap(src);
  const outPositions: PositionMap = {};
  let hasOutPositions = false;
  const schemaIndex = attrSchemaIndex(registry, canonicalKey);
  for (const key of Object.keys(src)) {
    let outKey: string;
    if (RESERVED_KEYS.has(key) || key.startsWith(ATTR_PREFIX)) {
      outKey = key;
      // FR-032: expand a ref-bearing value to FQN. `extends` (reserved) and the
      // @-prefixed ref attrs are expanded; everything else is copied verbatim.
      const attrName = key.startsWith(ATTR_PREFIX) ? key.slice(ATTR_PREFIX.length) : "";
      if (key === RESERVED_KEY_EXTENDS || (attrName !== "" && REF_BEARING_ATTR_NAMES.has(attrName))) {
        out[key] = expandRefValue(src[key], nodePkg, errors, path, key);
      } else {
        out[key] = src[key];
      }
      // D2 also applies to author-written @-keys (the awkward form).
      if (attrName !== "" && !RESERVED_KEYS.has(attrName)) {
        checkCoercion(attrName, src[key], schemaIndex, errors, path);
      }
    } else {
      outKey = `${ATTR_PREFIX}${key}`;
      // FR-032: a bare (sigil-free) ref-bearing attr is expanded to FQN too.
      if (REF_BEARING_ATTR_NAMES.has(key)) {
        out[outKey] = expandRefValue(src[key], nodePkg, errors, path, outKey);
      } else {
        out[outKey] = src[key];
      }
      checkCoercion(key, src[key], schemaIndex, errors, path);
    }
    const pos = srcPositions?.[key];
    if (pos !== undefined) {
      outPositions[outKey] = pos;
      hasOutPositions = true;
    }
  }
  if (hasOutPositions) setPositionMap(out, outPositions);
  return out;
}

// ---------------------------------------------------------------------------
// FR-032 (ADR-0032) — expand a ref-bearing value to FQN.
//
// A ref value is a single string (most refs) or a string-array (@references can
// carry multiple). expandRef preserves any FR-024 dotted child suffix and the
// `package` attr is never touched here (it is not a ref). A parent-relative
// over-drop (more `..::` than the package has segments) throws inside expandRef;
// we collect it as ERR_BAD_ATTR_VALUE and pass the raw value through so the rest
// of the desugar/load proceeds and surfaces a single actionable error.
// ---------------------------------------------------------------------------

function expandRefValue(
  raw: unknown,
  nodePkg: string,
  errors: CollectedError[],
  path: string,
  refLabel: string,
): unknown {
  if (typeof raw === "string") {
    try {
      return expandRef(raw, nodePkg);
    } catch (err) {
      errors.push({
        message: `Cannot expand reference '${refLabel}' at ${path}: ${(err as Error).message}`,
        code: "ERR_BAD_ATTR_VALUE",
      });
      return raw;
    }
  }
  if (Array.isArray(raw)) {
    return raw.map((el) => (typeof el === "string" ? expandRefValue(el, nodePkg, errors, path, refLabel) : el));
  }
  return raw;
}

// ---------------------------------------------------------------------------
// D2 — YAML type-coercion guard
// ---------------------------------------------------------------------------

// Build a name → AttrSchema map for the given canonical key (type.subType).
// Returns undefined when the key has no declared attrs (open schema).
function attrSchemaIndex(
  registry: TypeRegistry,
  canonicalKey: string,
): Map<string, AttrSchema> | undefined {
  // canonicalKey is "type.subType" — split on the FIRST dot only so a subType
  // that happens to contain a dot still works.
  const dot = canonicalKey.indexOf(TYPE_SUBTYPE_SEPARATOR);
  if (dot < 0) return undefined;
  const type = canonicalKey.slice(0, dot);
  const subType = canonicalKey.slice(dot + 1);
  const schema = registry.attrsOf(type, subType);
  if (schema.length === 0) return undefined;
  const idx = new Map<string, AttrSchema>();
  for (const spec of schema) idx.set(spec.name, spec);
  return idx;
}

// Check a single attr value against its declared schema's `valueType`. Emits
// an ERR_YAML_COERCION when the JS type was silently changed by YAML 1.2's
// core schema (boolean/number/null where a string/stringarray was declared,
// or vice versa for booleans/numbers).
function checkCoercion(
  attrName: string,
  raw: unknown,
  schemaIndex: Map<string, AttrSchema> | undefined,
  errors: CollectedError[],
  path: string,
): void {
  if (schemaIndex === undefined) return;
  const spec = schemaIndex.get(attrName);
  if (spec === undefined || spec.valueType === undefined) return;

  // Array-valued attr (the `string` + `isArray` model that replaced the
  // `stringarray` subtype): validate as a string-array regardless of the scalar
  // valueType token.
  const effectiveValueType = spec.isArray === true ? ATTR_SUBTYPE_STRINGARRAY : spec.valueType;

  switch (effectiveValueType) {
    case ATTR_SUBTYPE_STRING:
    case ATTR_SUBTYPE_CLASS:
      if (typeof raw !== "string") emitCoercion(attrName, raw, "string", errors, path);
      return;
    case ATTR_SUBTYPE_BOOLEAN:
      if (typeof raw !== "boolean") emitCoercion(attrName, raw, "boolean", errors, path);
      return;
    case ATTR_SUBTYPE_INT:
    case ATTR_SUBTYPE_LONG:
    case ATTR_SUBTYPE_DOUBLE:
      if (typeof raw !== "number") emitCoercion(attrName, raw, "number", errors, path);
      return;
    case ATTR_SUBTYPE_STRINGARRAY:
      // A bare string at the value position is the legitimate one-element
      // authoring shorthand for a string-array attr (StringArrayAttr.coerce
      // wraps it into a one-element array). It is NOT a coercion. A
      // non-string non-array scalar (boolean/number/null), however, is.
      if (typeof raw === "string") return;
      if (!Array.isArray(raw)) {
        emitCoercion(attrName, raw, "string-array (or single string)", errors, path);
        return;
      }
      // For an array, check every element. A non-string element is a YAML
      // coercion (e.g. unquoted `true` in a string-array list).
      for (let i = 0; i < raw.length; i++) {
        if (typeof raw[i] !== "string") {
          emitCoercion(
            `${attrName}[${i}]`,
            raw[i],
            "string (in string-array)",
            errors,
            path,
          );
        }
      }
      return;
    default:
      // Object-shaped attrs (properties, filter) — accept any object/array,
      // no YAML coercion path applies.
      return;
  }
}

// Build the "quote this value" error. The shape is intentionally explicit so
// AI authors can act on it: it identifies the attr, the (coerced) JS value,
// its JS type, the declared expected type, and a one-line fix hint.
function emitCoercion(
  attrName: string,
  raw: unknown,
  expected: string,
  errors: CollectedError[],
  path: string,
): void {
  const actualType = coercedTypeName(raw);
  const literal = literalRepr(raw);
  errors.push({
    message:
      `Attribute '@${attrName}' at ${path}: expected ${expected} but got ${actualType} (${literal}). ` +
      `YAML 1.2 silently coerced an unquoted value — quote it in YAML: ` +
      `'@${attrName}: "${literal}"' not '@${attrName}: ${literal}'.`,
    code: "ERR_YAML_COERCION",
  });
}

function coercedTypeName(raw: unknown): string {
  if (raw === null) return "null";
  if (Array.isArray(raw)) return "array";
  return typeof raw;
}

function literalRepr(raw: unknown): string {
  if (raw === null) return "null";
  if (typeof raw === "boolean") return raw ? "true" : "false";
  if (typeof raw === "number") return String(raw);
  if (typeof raw === "string") return raw;
  return JSON.stringify(raw);
}
