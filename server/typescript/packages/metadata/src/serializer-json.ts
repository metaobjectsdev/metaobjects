// Canonical JSON serializer — redesigned (post-v0.3) format.
//
// Every node serializes to a single-key map { "<type>.<subType>": <body> }.
// The wrapper key fuses type and subType. The body emits keys in the canonical
// order, each included only when non-default:
//   1. name      2. package   3. extends   4. abstract
//   5. overlay   6. isArray   7. @-attrs (alphabetical)   8. children

import type { MetaData, AttrValue } from "./shared/meta-data.js";
import {
  ATTR_PREFIX,
  TYPE_SUBTYPE_SEPARATOR,
  RESERVED_KEY_NAME,
  RESERVED_KEY_PACKAGE,
  RESERVED_KEY_EXTENDS,
  RESERVED_KEY_ABSTRACT,
  RESERVED_KEY_IS_ARRAY,
  RESERVED_KEY_CHILDREN,
} from "./shared/structural.js";
import {
  ATTR_SUBTYPE_STRING,
  ATTR_SUBTYPE_INT,
  ATTR_SUBTYPE_LONG,
  ATTR_SUBTYPE_DOUBLE,
  ATTR_SUBTYPE_BOOLEAN,
  ATTR_SUBTYPE_STRINGARRAY,
} from "./core/attr/attr-constants.js";
import {
  SOURCE_SUBTYPE_RDB,
  SOURCE_ATTR_KIND,
  SOURCE_ATTR_TABLE,
  DEFAULT_SOURCE_KIND,
  PHYSICAL_NAME_ATTR_BY_KIND,
} from "./persistence/source/source-constants.js";
import { TYPE_SOURCE } from "./shared/base-types.js";

const SOURCE_RDB_FUSED_KEY = `${TYPE_SOURCE}${TYPE_SUBTYPE_SEPARATOR}${SOURCE_SUBTYPE_RDB}`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SerializeOptions {
  /** Pretty-print indent. 0 = no whitespace. Default 2. */
  indent?: number;
}

export function serializeJson(model: MetaData, opts?: SerializeOptions): string {
  const indent = opts?.indent ?? 2;

  const nodeObj = serializeNode(model, false);
  return JSON.stringify(nodeObj, null, indent === 0 ? undefined : indent);
}

// ---------------------------------------------------------------------------
// Infer attr subType from a JS value (for child-node form when subType isn't known)
// ---------------------------------------------------------------------------

// Java int range — used for distinguishing int vs long subtypes.
const JAVA_INT_MAX = 2 ** 31 - 1;
const JAVA_INT_MIN = -(2 ** 31);

export function inferAttrSubType(value: AttrValue): string {
  if (Array.isArray(value)) return ATTR_SUBTYPE_STRINGARRAY;
  if (typeof value === "boolean") return ATTR_SUBTYPE_BOOLEAN;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) return ATTR_SUBTYPE_DOUBLE;
    return value >= JAVA_INT_MIN && value <= JAVA_INT_MAX
      ? ATTR_SUBTYPE_INT
      : ATTR_SUBTYPE_LONG;
  }
  return ATTR_SUBTYPE_STRING;
}

/** Build a fused `type.subType` wrapper key. */
function fusedKey(type: string, subType: string): string {
  return `${type}${TYPE_SUBTYPE_SEPARATOR}${subType}`;
}

// ---------------------------------------------------------------------------
// Serialize a single node — returns { "<type>.<subType>": { ...body } }
// ---------------------------------------------------------------------------

function serializeNode(
  model: MetaData,
  effective: boolean,
): Record<string, unknown> {
  const inner = serializeNodeInner(model, effective);
  return { [fusedKey(model.type, model.subType)]: inner };
}

function serializeNodeInner(
  model: MetaData,
  effective: boolean,
): Record<string, unknown> {
  // Canonical body-key order:
  //   1. name  2. package  3. extends  4. abstract
  //   5. overlay  6. isArray  7. inline @-attrs  8. children

  const obj: Record<string, unknown> = {};

  if (model.name !== "") {
    obj[RESERVED_KEY_NAME] = model.name;
  }

  if (model.package !== undefined && model.package !== "") {
    obj[RESERVED_KEY_PACKAGE] = model.package;
  }

  if (model.superRef !== undefined) {
    obj[RESERVED_KEY_EXTENDS] = model.superRef;
  }

  if (model.isAbstract === true) {
    obj[RESERVED_KEY_ABSTRACT] = true;
  }

  // NOTE: `overlay` is an authoring-time parser directive, not a property of
  // the resolved tree. After a merge, the merged node is a normal node — the
  // canonical serialization is the merged RESULT, which carries no overlay
  // semantics. Re-emitting `overlay: true` would break round-trip stability
  // (re-parsing would seek a non-existent node to merge into). So it is
  // deliberately NOT serialized.

  // ADR-0039: effective mode resolves array-ness through the super chain (a
  // concrete field that extends an abstract array field is itself an array);
  // own mode (canonicalSerialize) emits only the authored `isArray` so the
  // round-trip reconstructs the same extends tree.
  const isArrayForMode = effective ? model.resolvedIsArray() : model.isArray === true;
  if (isArrayForMode) {
    obj[RESERVED_KEY_IS_ARRAY] = true;
  }

  // In effective mode use children()/attrs() (own + inherited via super chain);
  // in own mode use ownChildren()/ownAttrs() (declared on this node only).
  const childList = effective ? model.children() : model.ownChildren();
  const attrMap = effective ? model.attrs() : model.ownAttrs();

  const serializedChildren: Record<string, unknown>[] = [];
  for (const child of childList) {
    // Attrs never appear in children(); only structural nodes recurse.
    serializedChildren.push(serializeNode(child, effective));
  }

  // Attrs ALWAYS emit inline @name (D5 — attrs have no children, one canonical form).
  for (const [attrName, attrValue] of attrMap) {
    obj[`${ATTR_PREFIX}${attrName}`] = attrValue;
  }

  if (serializedChildren.length > 0) {
    obj[RESERVED_KEY_CHILDREN] = serializedChildren;
  }
  return obj;
}

// ---------------------------------------------------------------------------
// canonicalSerialize — deterministic serializer for cross-language conformance
//
// Wraps serializeJson with two extra guarantees:
//   1. Inline @-attrs are emitted in alphabetical order (not Map iteration order).
//   2. Output ends with exactly one trailing newline.
//
// Both behaviors are required so Java/Python/C# implementations can produce
// byte-identical output from the same input metamodel.
// ---------------------------------------------------------------------------

export function canonicalSerialize(model: MetaData): string {
  const raw = serializeJson(model, { indent: 2 });

  const parsed = JSON.parse(raw) as unknown;
  // FR-016 / ADR-0018: rewrite legacy @table → kind-matching alias on source.rdb
  // wrappers (run before alphabetical sort so the rewritten key sorts in its
  // canonical position).
  rewriteSourceRdbPhysicalNames(parsed);
  const sorted = sortAttrKeys(parsed);
  const out = JSON.stringify(sorted, null, 2);

  return out + "\n";
}

/**
 * Like canonicalSerialize, but emits the EFFECTIVE tree — children() and
 * attrs() at every node (own + inherited via the super chain), so the
 * super-chain merge is materialized in the output.
 * Used by the conformance harness's expected-effective fixtures.
 */
export function canonicalSerializeEffective(model: MetaData): string {
  const nodeObj = serializeNode(model, true);
  const raw = JSON.stringify(nodeObj, null, 2);

  const parsed = JSON.parse(raw) as unknown;
  rewriteSourceRdbPhysicalNames(parsed);
  const sorted = sortAttrKeys(parsed);
  const out = JSON.stringify(sorted, null, 2);

  return out + "\n";
}

/**
 * FR-016 / ADR-0018 — when a source.rdb wrapper carries @table with a non-table
 * @kind (the pre-1.0 legacy spelling), rewrite the attr key in place to the
 * kind-matching alias (@view / @materializedView / @proc / @function). Mutates
 * the parsed JSON in place; idempotent and a no-op for canonical inputs.
 */
function rewriteSourceRdbPhysicalNames(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) rewriteSourceRdbPhysicalNames(item);
    return;
  }
  if (value === null || typeof value !== "object") return;

  const obj = value as Record<string, unknown>;
  const rdbBody = obj[SOURCE_RDB_FUSED_KEY];
  if (rdbBody !== undefined && rdbBody !== null && typeof rdbBody === "object" && !Array.isArray(rdbBody)) {
    const body = rdbBody as Record<string, unknown>;
    const kindRaw = body[`${ATTR_PREFIX}${SOURCE_ATTR_KIND}`];
    const kind = typeof kindRaw === "string" && kindRaw !== "" ? kindRaw : DEFAULT_SOURCE_KIND;
    const canonical = PHYSICAL_NAME_ATTR_BY_KIND.get(kind);
    if (canonical !== undefined && canonical !== SOURCE_ATTR_TABLE) {
      const legacyKey = `${ATTR_PREFIX}${SOURCE_ATTR_TABLE}`;
      const canonicalKey = `${ATTR_PREFIX}${canonical}`;
      const legacyValue = body[legacyKey];
      if (legacyValue !== undefined && body[canonicalKey] === undefined) {
        body[canonicalKey] = legacyValue;
        delete body[legacyKey];
      }
    }
  }

  // Recurse through every value (in particular `children`).
  for (const v of Object.values(obj)) rewriteSourceRdbPhysicalNames(v);
}

function sortAttrKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortAttrKeys);
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);

    const structuralKeys: string[] = [];
    const attrKeys: string[] = [];
    for (const k of keys) {
      if (k.startsWith(ATTR_PREFIX)) attrKeys.push(k);
      else structuralKeys.push(k);
    }
    attrKeys.sort();

    const result: Record<string, unknown> = {};
    const hasChildren = structuralKeys.includes(RESERVED_KEY_CHILDREN);
    for (const k of structuralKeys) {
      if (k === RESERVED_KEY_CHILDREN) continue;
      result[k] = sortAttrKeys(obj[k]);
    }
    // @-attr values: an object-typed attr value (e.g. @enumDoc / @filter) gets
    // the value-shape canonical-order treatment; everything else recurses normally.
    for (const k of attrKeys) {
      result[k] = sortAttrValue(obj[k]);
    }
    if (hasChildren) {
      result[RESERVED_KEY_CHILDREN] = sortAttrKeys(obj[RESERVED_KEY_CHILDREN]);
    }
    return result;
  }
  return value;
}

/**
 * Canonicalize an inline @-attr's value. The two object-typed attr subtypes need
 * different key order in canonical form, and the serializer is schema-free — so
 * distinguish by value shape, which exactly tracks the subtype:
 *   • `properties` (e.g. @enumDoc / @enumAlias) is a flat scalar→scalar map → keys
 *     sort ordinally (cross-port canonical form; matches the Java reference, whose
 *     Properties is unordered and serializes sorted).
 *   • `filter` maps a field to an operator object ({eq:…}/{in:[…]}) or carries
 *     or/and arrays — at least one value is itself an object/array → declaration
 *     order is preserved (significant). The filter desugar runs before serialization,
 *     so a filter clause is never a bare scalar.
 * Mirrors the C# AttrObjectToJsonNode value-shape heuristic.
 */
function sortAttrValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortAttrValue);
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    const allScalar = keys.every((k) => {
      const v = obj[k];
      return v === null || typeof v !== "object";
    });
    const orderedKeys = allScalar ? [...keys].sort() : keys;
    const result: Record<string, unknown> = {};
    for (const k of orderedKeys) {
      result[k] = sortAttrValue(obj[k]);
    }
    return result;
  }
  return value;
}
