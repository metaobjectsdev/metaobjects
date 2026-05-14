// v0.3 JSON serializer — wrapper-keyed format

import type { MetaModel, AttrValue } from "./model.js";
import {
  TYPE_ATTR,
  ATTR_PREFIX,
  ATTR_NAME_IS_ARRAY,
  ATTR_NAME_IS_ABSTRACT,
  RESERVED_KEY_NAME,
  RESERVED_KEY_SUBTYPE,
  RESERVED_KEY_PACKAGE,
  RESERVED_KEY_EXTENDS,
  RESERVED_KEY_IS_ABSTRACT,
  RESERVED_KEY_CHILDREN,
  RESERVED_KEY_VALUE,
  ATTR_SUBTYPE_STRING,
  ATTR_SUBTYPE_INT,
  ATTR_SUBTYPE_LONG,
  ATTR_SUBTYPE_DOUBLE,
  ATTR_SUBTYPE_BOOLEAN,
  ATTR_SUBTYPE_STRINGARRAY,
  SUBTYPE_BASE,
} from "./constants.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SerializeOptions {
  /** Prefer inline @-attrs over child {"attr": {...}} nodes when type is unambiguous. Default true. */
  inlineAttrs?: boolean;
  /** Pretty-print indent. 0 = no whitespace. Default 2. */
  indent?: number;
}

export function serializeJson(model: MetaModel, opts?: SerializeOptions): string {
  const inlineAttrs = opts?.inlineAttrs ?? true;
  const indent = opts?.indent ?? 2;

  const nodeObj = serializeNode(model, inlineAttrs);
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
  // string (includes numeric strings that were preserved verbatim)
  return ATTR_SUBTYPE_STRING;
}

// ---------------------------------------------------------------------------
// Serialize a single node — returns { "<type>": { ...nodeProps } }
// ---------------------------------------------------------------------------

function serializeNode(model: MetaModel, inlineAttrs: boolean): Record<string, unknown> {
  const inner = serializeNodeInner(model, inlineAttrs);
  return { [model.type]: inner };
}

function serializeNodeInner(model: MetaModel, inlineAttrs: boolean): Record<string, unknown> {
  // Strict key order per spec:
  //   1. package  2. name  3. subType  4. extends  5. isAbstract
  //   6. @isArray  7. inline @-attrs  8. children
  //
  // subType is always emitted — being explicit is never wrong, and we lack
  // registry access here to compute what the parser would infer.

  const obj: Record<string, unknown> = {};

  if (model.package !== undefined && model.package !== "") {
    obj[RESERVED_KEY_PACKAGE] = model.package;
  }

  if (model.name !== "") {
    obj[RESERVED_KEY_NAME] = model.name;
  }

  obj[RESERVED_KEY_SUBTYPE] = model.subType;

  if (model.superRef !== undefined) {
    obj[RESERVED_KEY_EXTENDS] = model.superRef;
  }

  // isAbstract — reserved-key form (NOT @isAbstract)
  if (model.isAbstract === true) {
    obj[RESERVED_KEY_IS_ABSTRACT] = true;
  }

  // isArray — emitted as @isArray (native attr-like key)
  if (model.isArray === true) {
    obj[`${ATTR_PREFIX}${ATTR_NAME_IS_ARRAY}`] = true;
  }

  // 7. Attrs: walk children first to find attr children, track names emitted as child nodes
  const emittedAsChild = new Set<string>();

  // Build the serialized children array (non-attr children + attr children in original order)
  const serializedChildren: Record<string, unknown>[] = [];

  for (const child of model.children()) {
    if (child.type !== TYPE_ATTR) {
      // Structural child — recurse
      serializedChildren.push(serializeNode(child, inlineAttrs));
      continue;
    }

    // Emit attr as child node form
    const attrName = child.name;
    const attrValue = child.attr(RESERVED_KEY_VALUE);
    const attrSubType =
      child.subType !== SUBTYPE_BASE ? child.subType : inferAttrSubType(attrValue ?? "");

    if (attrValue === undefined) {
      // Shouldn't happen if parser is correct; emit null defensively
      console.warn(`[serializer-json] attr child "${attrName}" has no value attr — emitting null`);
    }

    serializedChildren.push({
      [TYPE_ATTR]: {
        [RESERVED_KEY_NAME]: attrName,
        [RESERVED_KEY_SUBTYPE]: attrSubType,
        [RESERVED_KEY_VALUE]: attrValue === undefined ? null : serializeAttrValue(attrValue),
      },
    });
    emittedAsChild.add(attrName);
  }

  // 8. Inline @-attrs: emit attrs NOT already emitted as child nodes.
  //    Also skip isArray and isAbstract (handled via native paths above).
  for (const [attrName, attrValue] of model.attrs()) {
    if (emittedAsChild.has(attrName)) continue;
    if (attrName === ATTR_NAME_IS_ARRAY || attrName === ATTR_NAME_IS_ABSTRACT) continue;

    if (inlineAttrs) {
      obj[`${ATTR_PREFIX}${attrName}`] = serializeAttrValue(attrValue);
    } else {
      // Emit as child attr node — appended after the structural/attr children above.
      serializedChildren.push({
        [TYPE_ATTR]: {
          [RESERVED_KEY_NAME]: attrName,
          [RESERVED_KEY_SUBTYPE]: inferAttrSubType(attrValue),
          [RESERVED_KEY_VALUE]: serializeAttrValue(attrValue),
        },
      });
    }
  }

  // 9. children — emit only if non-empty
  if (serializedChildren.length > 0) {
    obj[RESERVED_KEY_CHILDREN] = serializedChildren;
  }

  return obj;
}

// ---------------------------------------------------------------------------
// Serialize an AttrValue to a JSON-compatible value
// ---------------------------------------------------------------------------

function serializeAttrValue(value: AttrValue): unknown {
  if (Array.isArray(value)) {
    // string[] — emit as JSON array of strings
    return value;
  }
  // boolean, number, string — pass through as-is
  return value;
}

// ---------------------------------------------------------------------------
// canonicalSerialize — deterministic serializer for cross-language conformance
//
// Wraps serializeJson with two extra guarantees:
//   1. Inline @-attrs are emitted in alphabetical order (not Map iteration order).
//   2. Output ends with exactly one trailing newline.
//
// Both behaviors are required so Java/Python/C# implementations can produce
// byte-identical output from the same input metamodel. See
// metaobjects/spec/conformance-tests.md for the full canonical contract.
// ---------------------------------------------------------------------------

export function canonicalSerialize(model: MetaModel): string {
  const raw = serializeJson(model, { inlineAttrs: true, indent: 2 });

  const parsed = JSON.parse(raw) as unknown;
  const sorted = sortAttrKeys(parsed);
  const out = JSON.stringify(sorted, null, 2);

  return out + "\n";
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
    for (const k of attrKeys) {
      result[k] = sortAttrKeys(obj[k]);
    }
    if (hasChildren) {
      result[RESERVED_KEY_CHILDREN] = sortAttrKeys(obj[RESERVED_KEY_CHILDREN]);
    }
    return result;
  }
  return value;
}

