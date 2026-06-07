// Validation pass: TPH discriminator cross-attribute rules (FR-014).
//
// Codes (all errors):
//   ERR_DISCRIMINATOR_FIELD_NOT_FOUND      — @discriminator names a field that
//                                            does not exist on the entity (own
//                                            or via extends chain).
//   ERR_DISCRIMINATOR_VALUE_DUPLICATE      — two subtypes of the same
//                                            @discriminator-bearing root claim
//                                            the same @discriminatorValue.
//   ERR_DISCRIMINATOR_VALUE_MISSING        — a concrete (non-abstract) entity
//                                            extends a chain whose root carries
//                                            @discriminator but the subtype lacks
//                                            @discriminatorValue.
//   ERR_DISCRIMINATOR_VALUE_TYPE_MISMATCH  — @discriminatorValue cannot be
//                                            coerced to the discriminator field's
//                                            subtype (enum: not in @values;
//                                            int: not numeric; string: always OK).

import type { MetaData } from "../../shared/meta-data.js";
import { ParseError } from "../../errors.js";
import { TYPE_OBJECT, TYPE_FIELD } from "../../shared/base-types.js";
import {
  OBJECT_ATTR_DISCRIMINATOR,
  OBJECT_ATTR_DISCRIMINATOR_VALUE,
  OBJECT_SUBTYPE_ENTITY,
} from "./object-constants.js";
import {
  FIELD_SUBTYPE_ENUM,
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_LONG,
  FIELD_SUBTYPE_STRING,
  FIELD_ATTR_VALUES,
} from "../field/field-constants.js";

const NUMERIC_DISCRIMINATOR_SUBTYPES = new Set<string>([
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_LONG,
]);

export function validateDiscriminator(root: MetaData): ParseError[] {
  const errors: ParseError[] = [];

  const entities = root
    .ownChildren()
    .filter((c) => c.type === TYPE_OBJECT && c.subType === OBJECT_SUBTYPE_ENTITY);

  // Pass 1: @discriminator on bases — name resolution (own + inherited fields).
  for (const obj of entities) {
    const disc = obj.ownAttr(OBJECT_ATTR_DISCRIMINATOR);
    if (typeof disc !== "string" || disc === "") continue;

    const field = findFieldOnEntity(obj, disc);
    if (field === undefined) {
      errors.push(
        new ParseError(
          `object.entity "${obj.name}" @discriminator: "${disc}" does not name a field on this entity ` +
            `(checked own children and the extends chain)`,
          { code: "ERR_DISCRIMINATOR_FIELD_NOT_FOUND", source: obj.source },
        ),
      );
    }
  }

  // Pass 2: @discriminatorValue validation — for every entity that declares it,
  // walk up to find the @discriminator-bearing root, then check field membership
  // and uniqueness within that root's subtype set.
  type SubtypeBinding = {
    subtype: MetaData;
    value: string;
    discField: MetaData;
  };
  const bindingsByRoot = new Map<MetaData, SubtypeBinding[]>();

  for (const obj of entities) {
    const value = obj.ownAttr(OBJECT_ATTR_DISCRIMINATOR_VALUE);
    if (typeof value !== "string" || value === "") continue;

    const { root: discRoot, fieldName } = findDiscriminatorRoot(obj);
    if (discRoot === undefined || fieldName === undefined) continue;

    const field = findFieldOnEntity(discRoot, fieldName);
    if (field === undefined) continue; // root's own ERR_DISCRIMINATOR_FIELD_NOT_FOUND already fires

    // Type-match check.
    if (field.subType === FIELD_SUBTYPE_ENUM) {
      const enumValues = field.ownAttr(FIELD_ATTR_VALUES);
      const list = Array.isArray(enumValues) ? enumValues.map(String) : [];
      if (!list.includes(value)) {
        errors.push(
          new ParseError(
            `object.entity "${obj.name}" @discriminatorValue: "${value}" is not a member of the ` +
              `discriminator enum field "${fieldName}" @values [${list.join(", ")}]`,
            { code: "ERR_DISCRIMINATOR_VALUE_TYPE_MISMATCH", source: obj.source },
          ),
        );
      }
    } else if (NUMERIC_DISCRIMINATOR_SUBTYPES.has(field.subType)) {
      if (!/^-?\d+$/.test(value)) {
        errors.push(
          new ParseError(
            `object.entity "${obj.name}" @discriminatorValue: "${value}" does not coerce to ` +
              `numeric discriminator field "${fieldName}" (field.${field.subType})`,
            { code: "ERR_DISCRIMINATOR_VALUE_TYPE_MISMATCH", source: obj.source },
          ),
        );
      }
    } else if (field.subType !== FIELD_SUBTYPE_STRING) {
      // Discriminator fields outside {enum, integer-family, string} are
      // unusual; accept silently (a future refinement may add a warning).
    }

    let list = bindingsByRoot.get(discRoot);
    if (list === undefined) {
      list = [];
      bindingsByRoot.set(discRoot, list);
    }
    list.push({ subtype: obj, value, discField: field });
  }

  // Pass 3: ERR_DISCRIMINATOR_VALUE_DUPLICATE within each root's subtypes.
  for (const [, bindings] of bindingsByRoot) {
    const seen = new Map<string, MetaData>();
    for (const b of bindings) {
      const prev = seen.get(b.value);
      if (prev !== undefined) {
        errors.push(
          new ParseError(
            `object.entity "${b.subtype.name}" @discriminatorValue: "${b.value}" ` +
              `duplicates the value already claimed by "${prev.name}"`,
            { code: "ERR_DISCRIMINATOR_VALUE_DUPLICATE", source: b.subtype.source },
          ),
        );
      } else {
        seen.set(b.value, b.subtype);
      }
    }
  }

  // Pass 4: ERR_DISCRIMINATOR_VALUE_MISSING — every concrete (non-abstract)
  // entity that extends a @discriminator-bearing root must declare a value.
  for (const obj of entities) {
    if (obj.isAbstract === true) continue;
    if (typeof obj.ownAttr(OBJECT_ATTR_DISCRIMINATOR_VALUE) === "string") continue;
    if (typeof obj.ownAttr(OBJECT_ATTR_DISCRIMINATOR) === "string") continue; // a root, not a subtype
    const { root: discRoot } = findDiscriminatorRoot(obj);
    if (discRoot === undefined) continue;
    if (discRoot === obj) continue; // safety: same node, shouldn't happen
    errors.push(
      new ParseError(
        `object.entity "${obj.name}" extends the @discriminator-bearing root "${discRoot.name}" ` +
          `but is missing @discriminatorValue (required on every concrete subtype)`,
        { code: "ERR_DISCRIMINATOR_VALUE_MISSING", source: obj.source },
      ),
    );
  }

  return errors;
}

/** Find a field with the given name on `entity` — own first, then via the
 *  resolved extends chain. Returns the declaring field node (own attrs intact). */
function findFieldOnEntity(entity: MetaData, name: string): MetaData | undefined {
  for (const child of entity.ownChildren()) {
    if (child.type === TYPE_FIELD && child.name === name) return child;
  }
  let cursor = entity.superResolved;
  while (cursor !== undefined) {
    for (const child of cursor.ownChildren()) {
      if (child.type === TYPE_FIELD && child.name === name) return child;
    }
    cursor = cursor.superResolved;
  }
  return undefined;
}

/** Walk the extends chain to find the first ancestor (or self) carrying
 *  @discriminator. Returns {root, fieldName} when found; both undefined
 *  otherwise. */
function findDiscriminatorRoot(
  entity: MetaData,
): { root: MetaData | undefined; fieldName: string | undefined } {
  let cursor: MetaData | undefined = entity;
  while (cursor !== undefined) {
    const v = cursor.ownAttr(OBJECT_ATTR_DISCRIMINATOR);
    if (typeof v === "string" && v !== "") {
      return { root: cursor, fieldName: v };
    }
    cursor = cursor.superResolved;
  }
  return { root: undefined, fieldName: undefined };
}
