import {
  ON_DELETE_DEFAULT_BY_SUBTYPE,
  ON_UPDATE_DEFAULT,
  FIELD_ATTR_REQUIRED,
  IDENTITY_ATTR_FIELDS,
  TYPE_VALIDATOR,
  VALIDATOR_SUBTYPE_REQUIRED,
  refMatchesObject,
  resolveObjectRef,
  type MetaObject,
  type MetaRelationship,
  type MetaReferenceIdentity,
  type MetaData,
} from "@metaobjectsdev/metadata";
import type { FkAction } from "./types.js";
import { SetNullNotNullableError } from "./errors.js";

// ---------------------------------------------------------------------------
// Shared field helpers — exported for use by expected-schema.ts
// ---------------------------------------------------------------------------

export function readIdentityFields(identity: MetaData): string[] {
  // ADR-0039: effective attr — @fields may be inherited via the identity's extends.
  const raw = identity.attr(IDENTITY_ATTR_FIELDS);
  if (Array.isArray(raw)) return raw.map(String).filter((s) => s.length > 0);
  // Fallback: comma-separated string form (defensive; canonical form is array)
  if (typeof raw === "string") return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  return [];
}

export function findField(entity: MetaObject, name: string): MetaData | undefined {
  for (const field of entity.fields()) {
    if (field.name === name) return field;
  }
  return undefined;
}

export function isRequired(field: MetaData): boolean {
  // ADR-0039: resolving — @required and validator.required may be inherited via extends.
  const attr = field.attr(FIELD_ATTR_REQUIRED);
  if (attr === true || attr === "true") return true;
  return field.children().some(
    (c) => c.type === TYPE_VALIDATOR && c.subType === VALIDATOR_SUBTYPE_REQUIRED,
  );
}

/**
 * Resolve the referential actions for a foreign key inferred from an
 * identity.reference.
 *
 * Precedence (highest first):
 *   1. @onDelete / @onUpdate declared DIRECTLY on the identity.reference — the
 *      reference IS the FK, so the action may be declared right where the FK is.
 *   2. A correlated sibling relationship on the same entity — matched
 *      package-aware against the resolved @references target (refMatchesObject
 *      / ADR-0042, so bare and FQN forms pair correctly); an M:N relationship
 *      (@through) never correlates with a direct FK. Its explicit @onDelete,
 *      else its subtype default (composition→cascade, aggregation→set-null,
 *      association→restrict); onUpdate defaults to "cascade".
 *   3. A correlated REVERSE relationship on the TARGET entity — the documented
 *      parent-side authoring shape ("Program owns weeks": composition declared
 *      on the parent with @objectRef back at this FK-owning entity). Same
 *      explicit-action-else-subtype-default resolution as tier 2. Guards:
 *      an M:N relationship (@through) never correlates (it describes the
 *      junction path, not this direct FK); when the FK-owning entity holds
 *      MORE THAN ONE enforced reference to the same target the reverse
 *      relationship contributes nothing (it cannot say which FK carries the
 *      ownership edge — arming all of them could cascade through an edge the
 *      author never designated; fail closed); and an INFERRED set-null default
 *      (parent-side aggregation, no explicit @onDelete) on a NOT NULL FK drops
 *      the INFERRED contributions only — an authored @onUpdate on that same
 *      relationship still applies (see the in-body guard comment).
 *   4. None → undefined (no ON DELETE / ON UPDATE clause).
 *
 * - Resolved "no-action" → undefined: introspection in introspect/{postgres,sqlite}.ts
 *   omits actions when the DB value is "no-action", so the expected side does the same
 *   to keep round-trip diffs clean.
 *
 * If multiple relationships target the same entity (rare), the first one is used.
 *
 * The single `as FkAction` cast in normalize() is safe because REFERENTIAL_ACTIONS
 * (metadata package) and FkAction (migrate-ts/src/types.ts) are the same four-value
 * set: "cascade" | "set-null" | "restrict" | "no-action". The invariant is
 * documented in relationship-constants.ts and enforced by both the type system
 * (FkAction is the union literal) and a runtime-set-equality test in
 * referential-actions.test.ts.
 */
export function resolveReferentialActions(
  entity: MetaObject,
  ref: MetaReferenceIdentity,
): { onDelete: FkAction | undefined; onUpdate: FkAction | undefined } {
  const target = ref.targetEntity;
  if (target === undefined) return { onDelete: undefined, onUpdate: undefined };

  // (1) Actions declared directly on the FK-defining reference win.
  const refOnDelete = ref.onDelete;
  const refOnUpdate = ref.onUpdate;

  // Resolve the reference's target ONCE, package-aware (ADR-0042: a bare
  // @references resolves in the DECLARING owner's package). Both relationship
  // tiers then correlate against the resolved node with refMatchesObject, so a
  // bare @references pairs correctly with an FQN @objectRef (and vice versa) —
  // an exact-string tier 2 used to miss the FQN form, letting the parent-side
  // tier override a child-side declaration.
  const root = entity.parent;
  const refOwner = ref.parent ?? entity;
  const refOwnerPkg = refOwner.package ?? refOwner.fileDefaultPackage ?? "";
  const targetObj =
    root !== undefined ? (resolveObjectRef(root, target, refOwnerPkg).node as MetaObject | undefined) : undefined;

  // (2) Otherwise correlate with a sibling relationship and use its action /
  //     subtype default. onUpdate's "cascade" default only applies when a
  //     relationship is present, so a reference-only FK with no explicit
  //     @onUpdate emits no ON UPDATE clause. An M:N relationship (@through)
  //     never correlates — it describes the junction path, not this direct FK.
  //     When the target does not resolve (dangling @references — normally a
  //     load error), fall back to the legacy exact-string match so behavior on
  //     partially-valid trees is unchanged.
  // (3) Failing that, correlate the REVERSE relationship declared on the
  //     TARGET entity (the documented parent-side authoring shape).
  let rel = entity.relationships().find((r) => {
    if (r.through !== undefined) return false;
    const objectRef = r.objectRef;
    if (objectRef === undefined) return false;
    if (targetObj === undefined) return objectRef === target;
    const relOwner = r.parent ?? entity;
    const relOwnerPkg = relOwner.package ?? relOwner.fileDefaultPackage ?? "";
    return refMatchesObject(targetObj, objectRef, relOwnerPkg);
  });
  // When the tier-3 satisfiability guard fires, the reverse relationship's
  // AUTHORED @onUpdate still applies (only the inferred contributions drop).
  let suppressedReverseOnUpdate: string | undefined;
  if (rel === undefined && targetObj !== undefined) {
    const reverse = findReverseRelationship(entity, ref, targetObj);
    // Tier-3 satisfiability guard: an INFERRED set-null default (a parent-side
    // aggregation with no explicit @onDelete) is unsatisfiable when any FK
    // column is NOT NULL — SET NULL cannot fire there, and letting it through
    // would turn a previously-valid model into a hard SetNullNotNullableError
    // purely because the correlation got smarter. An inferred default never
    // breaks a model: the INFERRED contributions drop (today's bare FK), while
    // anything the author explicitly wrote survives — an EXPLICIT @onDelete:
    // "set-null" flows through and hits the loud validateSetNullNullability
    // error (the author asked for it), and an EXPLICIT @onUpdate is honored
    // (silently dropping it would be the original bug again).
    if (reverse !== undefined) {
      const unsatisfiableInferredSetNull =
        reverse.onDelete === undefined &&
        ON_DELETE_DEFAULT_BY_SUBTYPE[reverse.subType] === "set-null" &&
        readIdentityFields(ref).some((jsName) => {
          const field = findField(entity, jsName);
          return field !== undefined && isRequired(field);
        });
      if (unsatisfiableInferredSetNull) {
        suppressedReverseOnUpdate = reverse.onUpdate;
      } else {
        rel = reverse;
      }
    }
  }

  const onDeleteRaw =
    refOnDelete ??
    (rel ? (rel.onDelete ?? ON_DELETE_DEFAULT_BY_SUBTYPE[rel.subType]) : undefined);
  const onUpdateRaw =
    refOnUpdate ??
    (rel ? (rel.onUpdate ?? ON_UPDATE_DEFAULT) : suppressedReverseOnUpdate);

  return {
    onDelete: normalize(onDeleteRaw),
    onUpdate: normalize(onUpdateRaw),
  };
}

/**
 * Tier-3 correlation: the relationship declared on the TARGET (parent) entity
 * pointing back at the FK-owning entity — the shape the docs and the authoring
 * skill teach ("Author owns posts": `relationship.composition { @objectRef:
 * "Post", @cardinality: "many" }` on Author, while Post owns the FK).
 *
 * Guards (each fails closed to "no contribution"):
 * - An M:N relationship (`@through`) never correlates — it describes the
 *   junction path, not this direct FK (the junction's own FKs correlate via
 *   its own identity.reference children). The same guard applies at tier 2.
 * - When the FK-owning entity holds more than one enforced reference to the
 *   same target, the reverse relationship cannot say WHICH FK carries the
 *   ownership edge, so it contributes to none of them (arming every FK could
 *   cascade through an edge the author never designated).
 *
 * If multiple reverse relationships point back at the entity (rare), the first
 * one is used — mirroring the tier-2 sibling-relationship rule.
 */
function findReverseRelationship(
  entity: MetaObject,
  ref: MetaReferenceIdentity,
  targetObj: MetaObject,
): MetaRelationship | undefined {
  const root = entity.parent;
  if (root === undefined) return undefined;

  // Ambiguity guard: exactly one enforced reference from `entity` to this
  // target, and it must be `ref` itself.
  const refsToTarget = entity.referenceIdentities().filter((r) => {
    if (!r.enforce) return false;
    const t = r.targetEntity;
    if (t === undefined) return false;
    const owner = r.parent ?? entity;
    const ownerPkg = owner.package ?? owner.fileDefaultPackage ?? "";
    return resolveObjectRef(root, t, ownerPkg).node === targetObj;
  });
  if (refsToTarget.length !== 1 || refsToTarget[0] !== ref) return undefined;

  // The reverse relationship's bare @objectRef resolves in ITS declaring
  // owner's package (normally the target entity's own package).
  return targetObj.relationships().find((r) => {
    if (r.through !== undefined) return false; // M:N — junction path, not this FK
    const objectRef = r.objectRef;
    if (objectRef === undefined) return false;
    const relOwner = r.parent ?? targetObj;
    const relOwnerPkg = relOwner.package ?? relOwner.fileDefaultPackage ?? "";
    return refMatchesObject(entity, objectRef, relOwnerPkg);
  });
}

function normalize(a: string | undefined): FkAction | undefined {
  if (a === undefined) return undefined;
  // Values are load-validated against REFERENTIAL_ACTIONS (allowedValues on both
  // relationship.* and — since ADR-0047 — identity.reference), so only canonical
  // kebab-case spellings reach this point. The legacy "setnull" alias was retired
  // with the ADR-0047 registration: it now fails load with ERR_BAD_ATTR_VALUE.
  if (a === "no-action") return undefined;
  return a as FkAction;
}

// ---------------------------------------------------------------------------
// Set-null / NOT NULL guard
// ---------------------------------------------------------------------------

/**
 * Validate that a FK whose resolved ON DELETE action is "set-null" does not
 * contain any NOT NULL column.
 *
 * ON DELETE SET NULL requires all FK columns to be nullable. Postgres and
 * SQLite both reject the combination at DDL execution time.
 *
 * Call this from buildExpectedSchema AFTER resolving the referential action
 * (i.e. after resolveReferentialActions) so that explicit overrides such as
 * @onDelete: "restrict" are already applied before the check.
 *
 * @param entity          The owning entity.
 * @param ref             The identity.reference node being processed.
 * @param onDelete        The resolved onDelete action (undefined = no-action).
 * @param constraintName  The FK constraint name as it will appear in the DDL.
 */
export function validateSetNullNullability(
  entity: MetaObject,
  ref: MetaReferenceIdentity,
  onDelete: FkAction | undefined,
  constraintName: string,
): void {
  if (onDelete !== "set-null") return;

  const fkFieldJsNames = readIdentityFields(ref);
  const offending: string[] = [];
  for (const jsName of fkFieldJsNames) {
    const field = findField(entity, jsName);
    if (field !== undefined && isRequired(field)) {
      offending.push(jsName);
    }
  }

  if (offending.length > 0) {
    throw new SetNullNotNullableError(entity.name, constraintName, offending);
  }
}
