// Canonical JSON serializer — redesigned (post-v0.3) format.
//
// Every node serializes to a single-key map { "<type>.<subType>": <body> }.
// The wrapper key fuses type and subType. The body emits keys in the canonical
// order, each included only when non-default:
//   1. name      2. package   3. extends   4. abstract
//   5. overlay   6. isArray   7. @-attrs (alphabetical)   8. children

import type { MetaModel, AttrValue } from "./meta/meta-data.js";
import {
  TYPE_ATTR,
  ATTR_PREFIX,
  TYPE_SUBTYPE_SEPARATOR,
  RESERVED_KEY_NAME,
  RESERVED_KEY_PACKAGE,
  RESERVED_KEY_EXTENDS,
  RESERVED_KEY_ABSTRACT,
  RESERVED_KEY_IS_ARRAY,
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
  /** Prefer inline @-attrs over child {"attr.*": {...}} nodes when type is unambiguous. Default true. */
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
  return ATTR_SUBTYPE_STRING;
}

/** Build a fused `type.subType` wrapper key. */
function fusedKey(type: string, subType: string): string {
  return `${type}${TYPE_SUBTYPE_SEPARATOR}${subType}`;
}

// ---------------------------------------------------------------------------
// Serialize a single node — returns { "<type>.<subType>": { ...body } }
// ---------------------------------------------------------------------------

function serializeNode(model: MetaModel, inlineAttrs: boolean): Record<string, unknown> {
  const inner = serializeNodeInner(model, inlineAttrs);
  return { [fusedKey(model.type, model.subType)]: inner };
}

function serializeNodeInner(model: MetaModel, inlineAttrs: boolean): Record<string, unknown> {
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

  if (model.isArray === true) {
    obj[RESERVED_KEY_IS_ARRAY] = true;
  }

  // Walk children: structural children recurse; attr children emit either as
  // inline @-attrs or as child {"attr.*": {...}} nodes.
  const emittedAsChild = new Set<string>();
  const serializedChildren: Record<string, unknown>[] = [];

  for (const child of model.children()) {
    if (child.type !== TYPE_ATTR) {
      serializedChildren.push(serializeNode(child, inlineAttrs));
      continue;
    }

    // Emit attr as child node form
    const attrName = child.name;
    const attrValue = child.attr(RESERVED_KEY_VALUE);
    const attrSubType =
      child.subType !== SUBTYPE_BASE ? child.subType : inferAttrSubType(attrValue ?? "");

    if (attrValue === undefined) {
      console.warn(`[serializer-json] attr child "${attrName}" has no value attr — emitting null`);
    }

    serializedChildren.push({
      [fusedKey(TYPE_ATTR, attrSubType)]: {
        [RESERVED_KEY_NAME]: attrName,
        [RESERVED_KEY_VALUE]: attrValue === undefined ? null : attrValue,
      },
    });
    emittedAsChild.add(attrName);
  }

  // Inline @-attrs: emit attrs NOT already emitted as child nodes.
  for (const [attrName, attrValue] of model.attrs()) {
    if (emittedAsChild.has(attrName)) continue;

    if (inlineAttrs) {
      obj[`${ATTR_PREFIX}${attrName}`] = attrValue;
    } else {
      serializedChildren.push({
        [fusedKey(TYPE_ATTR, inferAttrSubType(attrValue))]: {
          [RESERVED_KEY_NAME]: attrName,
          [RESERVED_KEY_VALUE]: attrValue,
        },
      });
    }
  }

  // children — emit only if non-empty
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
