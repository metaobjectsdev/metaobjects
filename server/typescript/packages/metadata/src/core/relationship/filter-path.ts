// G7 (joined half) and entity-derived — a projection @filter key may be a PATH: to-one hops
// from the base entity, then a field of the entity they reach (`caseId.status`,
// `caseId.patientId.hasActiveHipaaConsent`). A hop is an identity.reference (a forward FK) or
// a relationship with @cardinality one, named as an origin @via names its hops. A to-many hop
// would multiply the base rows, so it is refused. One resolver for the loaders and the view
// lowering.

import type { MetaData } from "../../shared/meta-data.js";
import type { MetaObject } from "../object/meta-object.js";
import { TYPE_FIELD, TYPE_IDENTITY, TYPE_RELATIONSHIP } from "../../shared/base-types.js";
import { refTarget } from "../../naming-refs.js";
import { isMetaObject } from "../../shared/node-guards.js";
import { IDENTITY_REFERENCE_ATTR_REFERENCES, IDENTITY_SUBTYPE_REFERENCE } from "../identity/identity-constants.js";
import {
  RELATIONSHIP_ATTR_CARDINALITY, RELATIONSHIP_ATTR_OBJECT_REF, CARDINALITY_ONE,
} from "./relationship-constants.js";

/** A resolved filter path: the hop names walked, the entity reached, and its field. */
export interface FilterPath {
  readonly hops: readonly string[];
  readonly entity: MetaObject;
  readonly field: MetaData;
}

/** The target of one to-one hop from `obj`, or why there is none. */
function toOneHop(obj: MetaObject, hop: string): MetaObject | string {
  // ADR-0039: resolving — a hop may be inherited through extends.
  const ref = obj.children().find(
    (c) => c.type === TYPE_IDENTITY && c.subType === IDENTITY_SUBTYPE_REFERENCE && c.name === hop,
  );
  if (ref !== undefined) {
    const target = refTarget(ref, IDENTITY_REFERENCE_ATTR_REFERENCES);
    return isMetaObject(target) ? target : `reference "${obj.name}.${hop}" does not resolve`;
  }
  const rel = obj.children().find((c) => c.type === TYPE_RELATIONSHIP && c.name === hop);
  if (rel !== undefined) {
    if (rel.attr(RELATIONSHIP_ATTR_CARDINALITY) !== CARDINALITY_ONE) {
      return `"${obj.name}.${hop}" is to-many; a filter path may only walk to-one hops`;
    }
    const target = refTarget(rel, RELATIONSHIP_ATTR_OBJECT_REF);
    return isMetaObject(target) ? target : `relationship "${obj.name}.${hop}" does not resolve`;
  }
  return `"${obj.name}" declares no identity.reference or to-one relationship named "${hop}"`;
}

/**
 * Resolve a dotted filter key against `base`. Undefined when `key` has no dot (a plain field
 * name, resolved by the caller); a string naming the failure when a hop or the field does not
 * resolve.
 */
export function resolveFilterPath(base: MetaObject, key: string): FilterPath | string | undefined {
  const segments = key.split(".");
  if (segments.length < 2) return undefined;
  const hops = segments.slice(0, -1);
  const fieldName = segments[segments.length - 1]!;
  let current = base;
  for (const hop of hops) {
    const next = toOneHop(current, hop);
    if (typeof next === "string") return next;
    current = next;
  }
  // ADR-0039: resolving — the reached field may be inherited.
  const field = current.children().find((c) => c.type === TYPE_FIELD && c.name === fieldName);
  if (field === undefined) return `"${current.name}" declares no field "${fieldName}"`;
  return { hops, entity: current, field };
}
