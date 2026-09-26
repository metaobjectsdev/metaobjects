import {
  ON_DELETE_DEFAULT_BY_SUBTYPE,
  ON_UPDATE_DEFAULT,
  FIELD_ATTR_REQUIRED,
  IDENTITY_ATTR_FIELDS,
  TYPE_VALIDATOR,
  VALIDATOR_SUBTYPE_REQUIRED,
  refMatchesObject,
  resolveObjectRef,
  resolveRelationshipReference,
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
 * When more than one relationship targets the same entity (Match.homeTeam /
 * awayTeam both -> Team), each is correlated to its OWN identity.reference via
 * the shared relationship<->reference ladder (#368 round 2) — never the first
 * match. When the correlation is genuinely ambiguous, it contributes nothing
 * rather than an arbitrary — possibly wrong — action (see the tier-2/tier-3
 * bodies below for the exact rules).
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
  const targetObj = resolveReferenceTarget(entity, ref, target);

  // (2) Otherwise correlate with a sibling relationship and use its action /
  //     subtype default. onUpdate's "cascade" default only applies when a
  //     relationship is present, so a reference-only FK with no explicit
  //     @onUpdate emits no ON UPDATE clause. An M:N relationship (@through)
  //     never correlates — it describes the junction path, not this direct FK.
  //     When the target does not resolve (dangling @references — normally a
  //     load error), fall back to the legacy exact-string match so behavior on
  //     partially-valid trees is unchanged.
  //
  //     #368 (round 2): `entity` may declare MORE THAN ONE identity.reference
  //     onto this same target (Match.homeTeamRef / awayTeamRef both -> Team).
  //     Matching `r` on the target alone can't say which of those references
  //     `r` supplies actions FOR — every FK past the first silently inherited
  //     the first relationship's actions. Resolve it with the INVERSE of the
  //     relationship->reference ladder (resolveRelationshipReference): `r`
  //     belongs to `ref` iff the ladder, applied to `r`, resolves back to
  //     `ref` itself — not merely "resolves to *some* reference on this
  //     target". `r` and `ref` are always declared on the same `entity`, the
  //     exact shape the ladder is built for, so this is a direct inversion,
  //     not a second parallel rule.
  // (3) Failing that, correlate the REVERSE relationship declared on the
  //     TARGET entity (the documented parent-side authoring shape).
  let rel = findSiblingRelationship(entity, ref, target, targetObj);
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
 * The reference's target entity, resolved package-aware (ADR-0042: a bare @references
 * resolves in the DECLARING owner's package). Undefined for a dangling @references.
 */
function resolveReferenceTarget(
  entity: MetaObject,
  ref: MetaReferenceIdentity,
  target: string,
): MetaObject | undefined {
  const root = entity.parent;
  if (root === undefined) return undefined;
  const refOwner = ref.parent ?? entity;
  const refOwnerPkg = refOwner.package ?? refOwner.fileDefaultPackage ?? "";
  return resolveObjectRef(root, target, refOwnerPkg).node as MetaObject | undefined;
}

/**
 * Tier-2 correlation: the relationship declared on the FK-owning entity itself that
 * navigates THIS reference (see resolveReferentialActions for the #368 inversion).
 */
function findSiblingRelationship(
  entity: MetaObject,
  ref: MetaReferenceIdentity,
  target: string,
  targetObj: MetaObject | undefined,
): MetaRelationship | undefined {
  return entity.relationships().find((r) => {
    if (r.through !== undefined) return false;
    const objectRef = r.objectRef;
    if (objectRef === undefined) return false;
    if (targetObj === undefined) return objectRef === target;
    const relOwner = r.parent ?? entity;
    const relOwnerPkg = relOwner.package ?? relOwner.fileDefaultPackage ?? "";
    if (!refMatchesObject(targetObj, objectRef, relOwnerPkg)) return false;
    return resolveRelationshipReference(entity, r.name, objectRef, r.sourceRefField) === ref;
  });
}

/**
 * Both sides of one foreign key declare a relationship, and they disagree on its
 * referential action. The FK-owning side governs (tier 2 beats tier 3), so the parent's
 * relationship — typically a `composition` the author meant to CASCADE — has no effect
 * on the constraint, and nothing else says so.
 */
export interface ReferentialActionConflict {
  /** The FK-owning entity and its identity.reference (the FK). */
  entity: MetaObject;
  ref: MetaReferenceIdentity;
  /** The relationship on the FK-owning entity — the one that governs. */
  governing: MetaRelationship;
  /** The relationship on the referenced (parent) entity — the one overridden. */
  overridden: MetaRelationship;
  /** The referenced entity, which declares `overridden`. */
  parent: MetaObject;
  /** Each action the two relationships disagree on: [governing value, overridden value]. */
  onDelete?: [string, string];
  onUpdate?: [string, string];
}

/**
 * The tier-2 / tier-3 disagreement for one FK, or undefined when there is none.
 *
 * Reported only when both relationships would correlate with this FK and neither is
 * settled by an action declared on the reference itself (tier 1 overrides both, which
 * is the author saying which one they mean). The reverse relationship is found with
 * tier 3's own guards, so a relationship tier 3 would never have used (a second FK to
 * the same parent, an ambiguous set of reverse relationships, an M:N) never reports; and
 * an INFERRED set-null that tier 3 would have dropped anyway (NOT NULL FK) is not a
 * disagreement worth reporting.
 */
export function findReferentialActionConflict(
  entity: MetaObject,
  ref: MetaReferenceIdentity,
): ReferentialActionConflict | undefined {
  const target = ref.targetEntity;
  if (target === undefined) return undefined;
  const targetObj = resolveReferenceTarget(entity, ref, target);
  if (targetObj === undefined) return undefined;
  const governing = findSiblingRelationship(entity, ref, target, targetObj);
  if (governing === undefined) return undefined;
  const overridden = findReverseRelationship(entity, ref, targetObj);
  if (overridden === undefined) return undefined;

  const conflict: ReferentialActionConflict = { entity, ref, governing, overridden, parent: targetObj };
  if (ref.onDelete === undefined) {
    const g = governing.onDelete ?? ON_DELETE_DEFAULT_BY_SUBTYPE[governing.subType];
    const inferredSetNull = overridden.onDelete === undefined
      && ON_DELETE_DEFAULT_BY_SUBTYPE[overridden.subType] === "set-null";
    const unsatisfiable = inferredSetNull && readIdentityFields(ref).some((jsName) => {
      const field = findField(entity, jsName);
      return field !== undefined && isRequired(field);
    });
    const o = overridden.onDelete ?? ON_DELETE_DEFAULT_BY_SUBTYPE[overridden.subType];
    if (!unsatisfiable && g !== undefined && o !== undefined && g !== o) conflict.onDelete = [g, o];
  }
  if (ref.onUpdate === undefined) {
    const g = governing.onUpdate ?? ON_UPDATE_DEFAULT;
    const o = overridden.onUpdate ?? ON_UPDATE_DEFAULT;
    if (g !== o) conflict.onUpdate = [g, o];
  }
  return conflict.onDelete !== undefined || conflict.onUpdate !== undefined ? conflict : undefined;
}

/**
 * The advisory sentence for a conflict, in the author's terms: which relationship wins,
 * what that does to the FK, and the two ways to say what they meant.
 */
export function describeReferentialActionConflict(c: ReferentialActionConflict): string {
  const node = (r: MetaRelationship): string => `${r.type}.${r.subType} "${r.name}"`;
  const parts: string[] = [];
  if (c.onDelete !== undefined) parts.push(`ON DELETE ${c.onDelete[0]} (not ${c.onDelete[1]})`);
  if (c.onUpdate !== undefined) parts.push(`ON UPDATE ${c.onUpdate[0]} (not ${c.onUpdate[1]})`);
  const [attr, pair] = c.onDelete !== undefined ? ["onDelete", c.onDelete] : ["onUpdate", c.onUpdate!];
  return `${c.entity.name}.${c.ref.name}: ${c.parent.name}'s ${node(c.overridden)} and ` +
    `${c.entity.name}'s ${node(c.governing)} are two relationships over this one foreign key, and ` +
    `they disagree. The FK-owning side governs, so the constraint is ${parts.join(", ")}: ` +
    `${c.parent.name}'s relationship does not reach it. Say which you mean on the foreign key ` +
    `itself: \`${attr}: ${pair[1]}\` on ${c.entity.name}'s identity.reference "${c.ref.name}" ` +
    `takes ${c.parent.name}'s, \`${attr}: ${pair[0]}\` keeps the current one.`;
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
 * - When the TARGET entity declares more than one non-@through relationship
 *   back at `entity` (rare — e.g. a "posts" composition and a separate
 *   "latestPost" association both @objectRef-ing Post), no candidate is
 *   preferred: this is the tier-2 ambiguity's mirror image (multiple
 *   RELATIONSHIPS rather than multiple REFERENCES), and it cannot be
 *   resolved by the relationship->reference ladder — that ladder picks among
 *   references declared on the SAME object as the relationship, whereas here
 *   the candidate relationships live on `targetObj` while `ref` lives on
 *   `entity`, a different object, so the ladder has no candidates to apply
 *   to. Previously this used the FIRST match (the same silently-wrong-schema
 *   defect as tier 2); it now fails closed like the guard above, once the
 *   ambiguity guard above has already established `ref` is the entity's only
 *   candidate reference to this target.
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
  //
  // Fail closed on ambiguity rather than taking the first match: if more than
  // one non-@through relationship on targetObj resolves back to `entity`,
  // none of them is preferred (see the class doc above).
  const reverseCandidates = targetObj.relationships().filter((r) => {
    if (r.through !== undefined) return false; // M:N — junction path, not this FK
    const objectRef = r.objectRef;
    if (objectRef === undefined) return false;
    const relOwner = r.parent ?? targetObj;
    const relOwnerPkg = relOwner.package ?? relOwner.fileDefaultPackage ?? "";
    return refMatchesObject(entity, objectRef, relOwnerPkg);
  });
  return reverseCandidates.length === 1 ? reverseCandidates[0] : undefined;
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
