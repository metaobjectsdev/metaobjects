// Cross-language subtype rules for object subtypes.
//
//   - value objects MUST NOT have a primary identity (error)
//   - entity objects SHOULD have a primary identity, unless @isAbstract (warning)
//   - base objects have no rule (template, may or may not have identity)
//   - every identity.* node MUST have a name (FR-024 D2: identities are named,
//     author-chosen, so the dotted by-name extends form can address them)

import type { MetaData } from "./shared/meta-data.js";
import { ParseError } from "./errors.js";
import { TYPE_OBJECT, TYPE_IDENTITY } from "./shared/base-types.js";
import { IDENTITY_SUBTYPE_PRIMARY } from "./core/identity/identity-constants.js";
import {
  OBJECT_SUBTYPE_ENTITY,
  OBJECT_SUBTYPE_VALUE,
} from "./core/object/object-constants.js";

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
    const hasPrimary = model.children().some(
      (c) => c.type === TYPE_IDENTITY && c.subType === IDENTITY_SUBTYPE_PRIMARY,
    );
    if (model.subType === OBJECT_SUBTYPE_VALUE && hasPrimary) {
      errors.push(
        new ParseError(
          `value object '${model.fqn()}' must not have a primary identity ` +
            `(use subType: "entity" for records with identity)`,
          { code: "ERR_SUBTYPE_RULE_VIOLATION", source: model.source },
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
