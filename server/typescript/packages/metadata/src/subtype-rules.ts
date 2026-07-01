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
import { IDENTITY_SUBTYPE_PRIMARY } from "./core/identity/identity-constants.js";
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
// carries NO identity of any subtype and NO source.
function validateValuePurity(model: MetaData, errors: ParseError[]): void {
  for (const child of model.children()) {
    if (child.type === TYPE_IDENTITY) {
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
