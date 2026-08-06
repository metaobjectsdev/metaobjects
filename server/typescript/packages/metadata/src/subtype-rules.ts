// Cross-language subtype rules for object subtypes.
//
//   - value objects MUST NOT have ANY identity (primary, secondary,
//     reference) — values are pure data shapes (error, FR-024/ADR-0028)
//   - value objects MUST NOT have a source.* child — values are not
//     persisted shapes (error, FR-024/ADR-0028)
//   - entity objects SHOULD have a primary identity, unless @isAbstract (warning)
//   - projection objects may only extend other projections (error,
//     FR-024/ADR-0028); identity on a projection is OPTIONAL (no warning)
//   - projection sources must have a read-only @kind — view,
//     materializedView, storedProc, tableFunction (ERR_PROJECTION_SOURCE_WRITABLE)
//   - base objects have no rule (template, may or may not have identity)
//   - every identity.* node MUST have a name (FR-024 D2: identities are named,
//     author-chosen, so the dotted by-name extends form can address them)
//
// The entity-primary-source-readonly hard cutover (an entity whose PRIMARY
// source is a read-only kind must become a projection) is deferred to
// FR-024 Phase E (B4b) — view-primary entities still load today.

import type { MetaData } from "./shared/meta-data.js";
import { ParseError } from "./errors.js";
import {
  TYPE_OBJECT,
  TYPE_IDENTITY,
  TYPE_SOURCE,
} from "./shared/base-types.js";
import {
  IDENTITY_SUBTYPE_PRIMARY,
  IDENTITY_SUBTYPE_REFERENCE,
  IDENTITY_REFERENCE_ATTR_ENFORCE,
} from "./core/identity/identity-constants.js";
import {
  OBJECT_SUBTYPE_ENTITY,
  OBJECT_SUBTYPE_VALUE,
  OBJECT_SUBTYPE_PROJECTION,
} from "./core/object/object-constants.js";
import { MetaSource } from "./persistence/source/meta-source.js";
import { SOURCE_READ_ONLY_KINDS } from "./persistence/source/source-constants.js";

export interface SubtypeRuleResult {
  errors: ParseError[];
  warnings: string[];
}

export function validateSubtypeRules(root: MetaData): SubtypeRuleResult {
  const errors: ParseError[] = [];
  const warnings: string[] = [];
  walk(root, errors, warnings);
  return { errors, warnings };
}

function walk(model: MetaData, errors: ParseError[], warnings: string[]): void {
  // FR-024 D2 — identity nodes require an author-chosen name (any nesting:
  // object children AND field-nested identities). A nameless node parses
  // with name === "".
  if (model.type === TYPE_IDENTITY && model.name === "") {
    const owner = model.parent?.fqn();
    errors.push(
      new ParseError(
        `identity.${model.subType}${owner !== undefined && owner !== "" ? ` under '${owner}'` : ""} has no name — ` +
          `identity nodes require an author-chosen name (e.g. "id") so dotted ` +
          `extends refs can address them (FR-024)`,
        { code: "ERR_IDENTITY_NAME_REQUIRED", source: model.source },
      ),
    );
  }

  if (model.type === TYPE_OBJECT) {
    switch (model.subType) {
      case OBJECT_SUBTYPE_VALUE:
        validateValuePurity(model, errors);
        break;
      case OBJECT_SUBTYPE_ENTITY:
        validateEntityIdentity(model, warnings);
        break;
      case OBJECT_SUBTYPE_PROJECTION:
        validateProjectionLicensing(model, errors);
        break;
      default:
        // object.base is a template — no rule.
        break;
    }
  }

  // ADR-0039: own — structural walk visiting every physical node once at its site.
  for (const child of model.ownChildren()) {
    walk(child, errors, warnings);
  }
}

// FR-024 value purity (ADR-0028): a value object is a pure data shape — it
// owns NO identity and NO source. ADR-0046 admits ONE exception: a
// navigation-only `identity.reference` with explicit `@enforce: false` — an
// outbound pointer to an entity (a DTO/message referencing X by id) is not
// persistence. Its target still resolves (dangling → ERR_INVALID_REFERENCE via
// the registry-derived pass) and codegen emits no FK/DDL. The value's OWN
// identity (primary/secondary) and any enforced reference (a physical FK it has
// no table to hold) stay banned.
function validateValuePurity(model: MetaData, errors: ParseError[]): void {
  for (const child of model.children()) {
    if (child.type === TYPE_IDENTITY) {
      if (child.subType === IDENTITY_SUBTYPE_REFERENCE) {
        // ADR-0046: navigation-only reference is the sanctioned exception.
        if (child.attr(IDENTITY_REFERENCE_ATTR_ENFORCE) === false) continue;
        errors.push(
          new ParseError(
            `value object '${model.fqn()}' has an enforced reference ` +
              `(${TYPE_IDENTITY}.${child.subType} '${child.name}') — a value is not ` +
              `persisted and has no table to hold a physical FK; declare a ` +
              `navigation-only reference with @enforce: false (FR-024, ADR-0028, ADR-0046)`,
            { code: "ERR_SUBTYPE_RULE_VIOLATION", source: child.source },
          ),
        );
        continue;
      }
      errors.push(
        new ParseError(
          `value object '${model.fqn()}' must not have an identity ` +
            `(${TYPE_IDENTITY}.${child.subType} '${child.name}') — value objects are ` +
            `pure data shapes; use subType: "entity" for records with identity ` +
            `(FR-024, ADR-0028)`,
          { code: "ERR_SUBTYPE_RULE_VIOLATION", source: child.source },
        ),
      );
    } else if (child.type === TYPE_SOURCE) {
      errors.push(
        new ParseError(
          `value object '${model.fqn()}' must not have a source ` +
            `(${TYPE_SOURCE}.${child.subType}) — value objects are not persisted ` +
            `shapes; use subType: "entity" or "projection" for stored objects ` +
            `(FR-024, ADR-0028)`,
          { code: "ERR_SUBTYPE_RULE_VIOLATION", source: child.source },
        ),
      );
    }
  }
}

// Entities SHOULD have a primary identity unless abstract (warning).
function validateEntityIdentity(model: MetaData, warnings: string[]): void {
  const hasPrimary = model
    .children()
    .some(
      (c) => c.type === TYPE_IDENTITY && c.subType === IDENTITY_SUBTYPE_PRIMARY,
    );
  if (!hasPrimary && !model.isAbstract) {
    warnings.push(
      `entity object '${model.fqn()}' has no primary identity ` +
        `(add an identity child or mark @isAbstract: true)`,
    );
  }
}

// FR-024 projection licensing (ADR-0028):
//   - a projection's object-level extends may only target another
//     object.projection (ERR_SUBTYPE_RULE_VIOLATION);
//   - every source.* on a projection must have a read-only @kind
//     (ERR_PROJECTION_SOURCE_WRITABLE);
//   - identity is OPTIONAL on a projection — no warning when absent.
function validateProjectionLicensing(
  model: MetaData,
  errors: ParseError[],
): void {
  const sup = model.superResolved;
  if (
    sup !== undefined &&
    (sup.type !== TYPE_OBJECT || sup.subType !== OBJECT_SUBTYPE_PROJECTION)
  ) {
    errors.push(
      new ParseError(
        `projection '${model.fqn()}' extends '${sup.fqn()}' which is ` +
          `${sup.type}.${sup.subType} — a projection may only extend another ` +
          `projection (FR-024, ADR-0028)`,
        { code: "ERR_SUBTYPE_RULE_VIOLATION", source: model.source },
      ),
    );
  }

  // A projection's `extends` is SHAPE lineage, not a shared-storage hierarchy, so a
  // concrete projection must declare its own source rather than inherit one.
  //
  // Inheriting it is incoherent by construction: `extends` only ADDS members, so the
  // child's extra fields have no provider in the parent's view, and both objects
  // would claim one physical view while declaring different exposures (the declared
  // field set IS the exposure, fail-closed — ADR-0028). It is also the shape that
  // made two source predicates disagree: "which source am I bound to" resolves
  // through the super chain while "what KIND of source am I" is own-only, so an
  // inheriting projection read as bound-but-not-a-projection and TS mounted writable
  // CRUD over a read-only view. Guarding the shape makes the predicates agree instead
  // of flipping either one (own-only classification is the deliberate cross-port
  // contract — see projection-detector.ts).
  //
  // Prior art agrees on the split: shared-storage inheritance (JPA @Inheritance,
  // EF Core TPH, SQLAlchemy single-table) inherits binding AND writability together,
  // while shape-reuse inheritance (JPA @MappedSuperclass, Django abstract bases) does
  // not inherit the binding at all — Django documents inheriting `db_table` as a trap
  // for exactly this reason. A projection is the second kind.
  //
  // Enforced at the CONCRETE level (mirrors #236): an abstract projection base may
  // carry shared shape, and a source on an abstract base is inert until something
  // extends it — at which point this fires on the concrete child.
  //
  // Only checked when the super is a legal projection: a non-projection super trips
  // the extends rule above and inherits its source too, and one defect should yield
  // one error, reported at its root cause.
  const superIsLegalProjection =
    sup === undefined ||
    (sup.type === TYPE_OBJECT && sup.subType === OBJECT_SUBTYPE_PROJECTION);
  if (!model.isAbstract && superIsLegalProjection) {
    const ownSourceCount = model.ownChildren().filter((c) => c.type === TYPE_SOURCE).length;
    const inherited = model
      .children()
      .filter((c) => c.type === TYPE_SOURCE)
      .slice(ownSourceCount);
    if (model.children().filter((c) => c.type === TYPE_SOURCE).length > ownSourceCount) {
      const src = inherited[0] ?? model;
      errors.push(
        new ParseError(
          `projection '${model.fqn()}' inherits a source (${TYPE_SOURCE}.${src.subType}) ` +
            `through extends instead of declaring its own — a projection's extends is ` +
            `shape lineage, not a shared-storage hierarchy. Declare the source on this ` +
            `projection; an abstract projection base carries shape only (FR-024, ADR-0028)`,
          { code: "ERR_PROJECTION_INHERITED_SOURCE", source: model.source },
        ),
      );
    }
  }

  // ADR-0039: own — OWN sources only: an inherited source is validated on the
  // (projection) object that declares it; an inherited source from a non-projection
  // super is unreachable without first tripping the extends rule above.
  for (const child of model.ownChildren()) {
    if (child.type !== TYPE_SOURCE) continue;
    const kind =
      child instanceof MetaSource ? child.effectiveKind : child.subType;
    if (!SOURCE_READ_ONLY_KINDS.has(kind)) {
      errors.push(
        new ParseError(
          `projection '${model.fqn()}' has a writable source (@kind "${kind}") — ` +
            `a projection is a derived read-only representation; its sources must ` +
            `be read-only kinds (view, materializedView, storedProc, ` +
            `tableFunction) (FR-024, ADR-0028)`,
          { code: "ERR_PROJECTION_SOURCE_WRITABLE", source: child.source },
        ),
      );
    }
  }
}
