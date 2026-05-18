// Cross-language subtype rules for object subtypes.
//
//   - value objects MUST NOT have a primary identity (error)
//   - entity objects SHOULD have a primary identity, unless @isAbstract (warning)
//   - base objects have no rule (template, may or may not have identity)

import type { MetaData } from "./meta/meta-data.js";
import { ParseError } from "./errors.js";
import {
  TYPE_OBJECT,
  TYPE_IDENTITY,
  IDENTITY_SUBTYPE_PRIMARY,
  OBJECT_SUBTYPE_ENTITY,
  OBJECT_SUBTYPE_VALUE,
} from "./constants.js";

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
  if (model.type === TYPE_OBJECT) {
    const hasPrimary = model.effectiveChildren().some(
      (c) => c.type === TYPE_IDENTITY && c.subType === IDENTITY_SUBTYPE_PRIMARY,
    );
    if (model.subType === OBJECT_SUBTYPE_VALUE && hasPrimary) {
      errors.push(
        new ParseError(
          `value object '${model.fqn()}' must not have a primary identity ` +
            `(use subType: "entity" for records with identity)`,
        ),
      );
    } else if (
      model.subType === OBJECT_SUBTYPE_ENTITY &&
      !hasPrimary &&
      !model.isAbstract
    ) {
      warnings.push(
        `entity object '${model.fqn()}' has no primary identity ` +
          `(add an identity child or mark @isAbstract: true)`,
      );
    }
  }

  for (const child of model.ownChildren()) {
    walk(child, errors, warnings);
  }
}
