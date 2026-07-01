// Validation pass: FR-024 projection identity pass-through + key correspondence.
//
// A projection's identity is a PASS-THROUGH of an entity identity:
//
//   - every identity child of an object.projection MUST extend an entity
//     identity (the dotted by-name form, e.g. `extends: "Customer.id"`);
//     a projection identity without `extends` → ERR_PROJECTION_IDENTITY_NOT_EXTENDED.
//   - key correspondence: every field named by the extended identity's
//     @fields must have a local projection field extending it; a missing
//     pass-through → ERR_IDENTITY_KEY_MISMATCH.
//   - the identity's local key is COMPUTED from those local fields (in the
//     extended identity's order) — derived on read, NEVER written back into
//     the tree (metadata is the authored spine; the loader never mutates it).
//     An explicit @fields that disagrees with the computed set →
//     ERR_IDENTITY_KEY_MISMATCH.
//
// Unresolved / type-mismatched `extends` refs are NOT re-reported here — the
// deferred-super pass already emitted ERR_UNRESOLVED_SUPER /
// ERR_EXTENDS_TARGET_MISMATCH for those.

import type { MetaData } from "../../shared/meta-data.js";
import { ParseError } from "../../errors.js";
import { TYPE_OBJECT, TYPE_IDENTITY, TYPE_FIELD } from "../../shared/base-types.js";
import { OBJECT_SUBTYPE_PROJECTION } from "../object/object-constants.js";
import { IDENTITY_ATTR_FIELDS } from "./identity-constants.js";

/**
 * Normalize an identity's OWN @fields attr to a string[]. Accepts both the
 * array form (["id"]) and the comma-string form ("id" / "a,b"); returns
 * undefined when the identity declares no own @fields (the pass-through case).
 */
export function identityOwnFields(identity: MetaData): string[] | undefined {
  // ADR-0039: own — the OWN @fields is read deliberately (paired with
  // identityEffectiveFields below) to detect an explicit author-declared @fields
  // that disagrees with the computed pass-through key.
  return normalizeFields(identity.ownAttr(IDENTITY_ATTR_FIELDS));
}

/** Normalize an identity's EFFECTIVE @fields attr (inherits through extends). */
export function identityEffectiveFields(identity: MetaData): string[] | undefined {
  return normalizeFields(identity.attr(IDENTITY_ATTR_FIELDS));
}

function normalizeFields(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (Array.isArray(raw)) return raw.map((v) => String(v).trim());
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return undefined;
}

/** The result of deriving a projection identity's pass-through key. */
export interface IdentityPassthroughResolution {
  /** The owning entity of the extended identity. */
  readonly entity: MetaData;
  /** Local pass-through field names, in the extended identity's @fields order. */
  readonly computedFields: string[];
  /** Extended-identity field names with NO local pass-through field. */
  readonly missing: string[];
}

/**
 * Derive a projection identity's pass-through key — a PURE read of the
 * resolved tree (no mutation): for each field name in the extended identity's
 * effective @fields, find the local field whose extends-chain reaches the
 * entity's field of that name; the computed key is those local field names in
 * the extended identity's order.
 *
 * Returns undefined when the identity has no resolved identity super (the
 * not-extended / unresolved / mismatched cases — reported elsewhere).
 */
export function resolveIdentityPassthrough(
  identity: MetaData,
): IdentityPassthroughResolution | undefined {
  const extended = identity.superResolved;
  if (extended === undefined || extended.type !== TYPE_IDENTITY) return undefined;
  const entity = extended.parent;
  if (entity === undefined || entity.type !== TYPE_OBJECT) return undefined;
  const owner = identity.parent;
  if (owner === undefined) return undefined;

  const extendedFields = identityEffectiveFields(extended) ?? [];
  const computedFields: string[] = [];
  const missing: string[] = [];
  for (const fieldName of extendedFields) {
    const entityField = entity
      .children()
      .find((c) => c.type === TYPE_FIELD && c.name === fieldName);
    if (entityField === undefined) {
      missing.push(fieldName);
      continue;
    }
    const local = owner
      // ADR-0039: own — a pass-through field must be LOCALLY declared on the
      // projection (it carries the extends ref reaching the entity field).
      .ownChildren()
      .find((c) => c.type === TYPE_FIELD && extendsChainReaches(c, entityField));
    if (local === undefined) {
      missing.push(fieldName);
      continue;
    }
    computedFields.push(local.name);
  }
  return { entity, computedFields, missing };
}

/**
 * The computed pass-through key of a projection identity, or undefined when
 * the identity is not a fully-corresponding pass-through. Codegen-facing
 * convenience over resolveIdentityPassthrough.
 */
export function computedIdentityFields(identity: MetaData): string[] | undefined {
  const res = resolveIdentityPassthrough(identity);
  if (res === undefined || res.missing.length > 0) return undefined;
  return res.computedFields;
}

function extendsChainReaches(node: MetaData, target: MetaData): boolean {
  let cur = node.superResolved;
  while (cur !== undefined) {
    if (cur === target) return true;
    cur = cur.superResolved;
  }
  return false;
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Walk every object.projection in the root and enforce the pass-through +
 * key-correspondence rules. Returns errors; never mutates the tree.
 */
export function validateIdentityPassthrough(root: MetaData): ParseError[] {
  const errors: ParseError[] = [];

  // ADR-0039: root has no super; children()==ownChildren() but resolving is the default.
  for (const obj of root
    .children()
    .filter(
      (c) => c.type === TYPE_OBJECT && c.subType === OBJECT_SUBTYPE_PROJECTION,
    )) {
    // ADR-0039: own — validates the projection's OWN-declared identities (the
    // pass-through subjects; an inherited identity was validated on its declarer).
    for (const identity of obj
      .ownChildren()
      .filter((c) => c.type === TYPE_IDENTITY)) {
      if (identity.superRef === undefined) {
        errors.push(
          new ParseError(
            `identity '${identity.name}' on projection '${obj.name}' must extend an entity identity ` +
              `(e.g. extends: "Customer.id") — a projection identity is a pass-through (FR-024)`,
            {
              code: "ERR_PROJECTION_IDENTITY_NOT_EXTENDED",
              source: identity.source,
            },
          ),
        );
        continue;
      }

      const res = resolveIdentityPassthrough(identity);
      // Unresolved or non-identity target: ERR_UNRESOLVED_SUPER /
      // ERR_EXTENDS_TARGET_MISMATCH already reported by the deferred-super pass.
      if (res === undefined) continue;

      if (res.missing.length > 0) {
        const missingRefs = res.missing
          .map((f) => `'${res.entity.name}.${f}'`)
          .join(", ");
        errors.push(
          new ParseError(
            `identity '${identity.name}' on projection '${obj.name}' does not correspond to its ` +
              `extended identity: no local field extends ${missingRefs} — every field of the ` +
              `extended identity needs a pass-through field on the projection (FR-024)`,
            { code: "ERR_IDENTITY_KEY_MISMATCH", source: identity.source },
          ),
        );
        continue;
      }

      const explicit = identityOwnFields(identity);
      if (explicit !== undefined && !arraysEqual(explicit, res.computedFields)) {
        errors.push(
          new ParseError(
            `identity '${identity.name}' on projection '${obj.name}' declares @fields ` +
              `[${explicit.join(", ")}] but the computed pass-through key is ` +
              `[${res.computedFields.join(", ")}] — omit @fields (it is derived) or make them agree (FR-024)`,
            { code: "ERR_IDENTITY_KEY_MISMATCH", source: identity.source },
          ),
        );
      }
    }
  }

  return errors;
}
