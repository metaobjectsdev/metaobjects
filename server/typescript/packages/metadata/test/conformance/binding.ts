// binding.ts — the capability dispatch table for the TS ConformanceAdapter.
//
// Each entry maps a capability-id to a function that invokes a typed-tree
// accessor on a node and normalizes the return into a NormalizedResult.
//
// Reality vs. plan: `MetaField.isRequired` and `MetaField.maxLength` are
// getters (properties), not methods — the plan's illustrative code assumed
// `isRequired()` / `maxLength()`. Bound here as property reads.

import type { NormalizedResult } from "@metaobjectsdev/conformance";
import type { MetaData } from "../../src/shared/meta-data.js";
import { MetaObject } from "../../src/core/object/meta-object.js";
import { MetaField } from "../../src/core/field/meta-field.js";
import { canonicalSerialize } from "../../src/serializer-json.js";
import { opsForField } from "../../src/core/query/query-constants.js";

type CapabilityArgs = Record<string, string | number | boolean>;
type CapabilityFn = (node: MetaData, args: CapabilityArgs) => NormalizedResult;

/** `{ names: [...] }` from a list of nodes. */
function names(nodes: readonly MetaData[]): NormalizedResult {
  return { names: nodes.map((n) => n.name) };
}

/** `{ absent: true }` or `{ name }` for an optional node. */
function optional(node: MetaData | undefined): NormalizedResult {
  return node === undefined ? { absent: true } : { name: node.name };
}

/** Coerce a capability arg to a string, failing loudly if absent. */
function stringArg(args: CapabilityArgs, key: string): string {
  const v = args[key];
  if (typeof v !== "string") {
    throw new Error(`capability arg "${key}" must be a string`);
  }
  return v;
}

function asObject(node: MetaData): MetaObject {
  if (!(node instanceof MetaObject)) {
    throw new Error(`expected an object node, got ${node.type}`);
  }
  return node;
}

function asField(node: MetaData): MetaField {
  if (!(node instanceof MetaField)) {
    throw new Error(`expected a field node, got ${node.type}`);
  }
  return node;
}

/** capability-id → normalizer. The runner looks up by id; a miss is a parity gap. */
export const binding: Readonly<Record<string, CapabilityFn>> = {
  // object.effective-fields → MetaObject.fields() (own + inherited via extends)
  "object.effective-fields": (node) => names(asObject(node).fields()),

  // object.own-fields → MetaObject.ownFields() (excludes inherited)
  "object.own-fields": (node) => names(asObject(node).ownFields()),

  // object.find-field → MetaObject.findField(name); a miss → { absent: true }
  "object.find-field": (node, args) =>
    optional(asObject(node).findField(stringArg(args, "name"))),

  // object.primary-identity → MetaObject.primaryIdentity(); subtype or absent
  "object.primary-identity": (node) => {
    const id = asObject(node).primaryIdentity();
    return id === undefined ? { absent: true } : { subtype: id.subType };
  },

  // field.effective-validators → MetaField.validators() (own + inherited)
  "field.effective-validators": (node) => names(asField(node).validators()),

  // field.is-required → MetaField.isRequired (getter)
  "field.is-required": (node) => ({ scalar: asField(node).isRequired }),

  // field.max-length → MetaField.maxLength (getter); undefined → absent
  "field.max-length": (node) => {
    const len = asField(node).maxLength;
    return len === undefined ? { absent: true } : { scalar: len };
  },

  // field.effective-tree → canonical serialization of the node subtree
  "field.effective-tree": (node) => ({
    "effective-tree": canonicalSerialize(asField(node)),
  }),

  // field.filter-ops → the canonical per-FIELD filter-operator band. Returns
  // `{ names: [...] }` in canonical operator order so the cross-port matrix
  // fixture compares order-sensitively. The single source of truth for the band
  // is opsForField — the same function the server allowlist + codegen consume.
  //
  // opsForField, not opsForSubType: the band is field-level because an int-backed
  // field.enum (@intValueMap) stores as an integer and so drops `like`.
  "field.filter-ops": (node) => ({
    names: [...opsForField(asField(node))],
  }),
};
