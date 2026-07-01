import {
  ON_DELETE_DEFAULT_BY_SUBTYPE,
  ON_UPDATE_DEFAULT,
  FIELD_ATTR_REQUIRED,
  IDENTITY_ATTR_FIELDS,
  TYPE_VALIDATOR,
  VALIDATOR_SUBTYPE_REQUIRED,
  type MetaObject,
  type MetaReferenceIdentity,
  type MetaData,
} from "@metaobjectsdev/metadata";
import type { FkAction } from "./types.js";
import { SetNullNotNullableError } from "./errors.js";

// ---------------------------------------------------------------------------
// Shared field helpers — exported for use by expected-schema.ts
// ---------------------------------------------------------------------------

export function readIdentityFields(identity: MetaData): string[] {
  const raw = identity.ownAttr(IDENTITY_ATTR_FIELDS);
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
 *   2. A correlated sibling relationship on the same entity (matched on
 *      target-entity name): its explicit @onDelete, else its subtype default
 *      (composition→cascade, aggregation→set-null, association→restrict);
 *      onUpdate defaults to "cascade".
 *   3. Neither → undefined (no ON DELETE / ON UPDATE clause).
 *
 * - "setnull" is accepted as an alias for the canonical "set-null".
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

  // Correlation is by exact-string match. Every fixture in the corpus uses
  // bare entity names for @objectRef and @references (no `::`-FQN form), so
  // bare-vs-bare matching is sufficient today. If a future author writes an
  // FQN value on either side, this find returns undefined and both actions
  // resolve to undefined (no clause emitted) — surfacing the mismatch as a
  // silent loss of intent rather than a wrong action. Cross-language ports
  // should match the same correlation rule.
  // (1) Actions declared directly on the FK-defining reference win.
  const refOnDelete = ref.onDelete;
  const refOnUpdate = ref.onUpdate;

  // (2) Otherwise correlate with a sibling relationship and use its action /
  //     subtype default. onUpdate's "cascade" default only applies when a
  //     relationship is present, so a reference-only FK with no explicit
  //     @onUpdate emits no ON UPDATE clause.
  const rel = entity.relationships().find((r) => r.objectRef === target);

  const onDeleteRaw =
    refOnDelete ??
    (rel ? (rel.onDelete ?? ON_DELETE_DEFAULT_BY_SUBTYPE[rel.subType]) : undefined);
  const onUpdateRaw =
    refOnUpdate ??
    (rel ? (rel.onUpdate ?? ON_UPDATE_DEFAULT) : undefined);

  return {
    onDelete: normalize(onDeleteRaw),
    onUpdate: normalize(onUpdateRaw),
  };
}

function normalize(a: string | undefined): FkAction | undefined {
  if (a === undefined) return undefined;
  // Accept the hyphen-less spelling as an alias for the canonical kebab-case form.
  const canonical = a === "setnull" ? "set-null" : a;
  if (canonical === "no-action") return undefined;
  return canonical as FkAction;
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
