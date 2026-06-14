// FR-033 S0 — structural-child placement enforcement (Check 0b in
// attr-schema-validate.ts). A STRUCTURAL child (field/identity/source/validator/…
// — not an attr) must be admitted by the parent's registered childRules under the
// shared wildcard match semantics; a child the rules do not admit →
// ERR_CHILD_NOT_ALLOWED (strict load only). Today every parent carries wildcard
// childRules so the check is a NO-OP — these tests prove BOTH that the wildcard
// case stays clean AND that the mechanism fires for a genuinely-closed parent (the
// rail strict per-subtype rules will use in S1).

import { describe, it, expect } from "bun:test";
import { TypeRegistry, TypeId, type TypeDefinition } from "../src/registry.js";
import { validateAttrSchema } from "../src/attr-schema-validate.js";
import { MetaObject } from "../src/core/object/meta-object.js";
import { MetaField } from "../src/core/field/meta-field.js";
import { MetaValidator } from "../src/core/validator/meta-validator.js";
import {
  TYPE_OBJECT,
  TYPE_FIELD,
  TYPE_VALIDATOR,
} from "../src/shared/base-types.js";
import { CHILD_RULE_WILDCARD } from "../src/shared/structural.js";

const OBJECT_ENTITY = "entity";
const FIELD_STRING = "string";
const VALIDATOR_REQUIRED = "required";

/** Minimal TypeDefinition with the given childRules (and no attrs). */
function typeDef(
  type: string,
  subType: string,
  childRules: TypeDefinition["childRules"],
): TypeDefinition {
  return {
    typeId: new TypeId(type, subType),
    description: "",
    factory: (id, name) => new MetaField(id, name),
    childRules,
    attributes: [],
  };
}

/** An entity holding one string field that itself holds one validator child. */
function buildTree(): MetaObject {
  const entity = new MetaObject(new TypeId(TYPE_OBJECT, OBJECT_ENTITY), "Account");
  const field = new MetaField(new TypeId(TYPE_FIELD, FIELD_STRING), "name");
  const validator = new MetaValidator(
    new TypeId(TYPE_VALIDATOR, VALIDATOR_REQUIRED),
    "req",
  );
  field.addChild(validator);
  entity.addChild(field);
  return entity;
}

describe("FR-033 — structural-child placement (Check 0b)", () => {
  it("admits a child when the parent carries a wildcard childRule (NO-OP)", () => {
    const registry = new TypeRegistry();
    registry.register(
      typeDef(TYPE_OBJECT, OBJECT_ENTITY, [
        { childType: TYPE_FIELD, childSubType: CHILD_RULE_WILDCARD, childName: CHILD_RULE_WILDCARD },
      ]),
    );
    registry.register(
      typeDef(TYPE_FIELD, FIELD_STRING, [
        { childType: TYPE_VALIDATOR, childSubType: CHILD_RULE_WILDCARD, childName: CHILD_RULE_WILDCARD },
      ]),
    );

    const { errors } = validateAttrSchema(buildTree(), registry, /* strict */ true);
    expect(errors).toHaveLength(0);
  });

  it("fires ERR_CHILD_NOT_ALLOWED when a CLOSED parent does not admit the child", () => {
    const registry = new TypeRegistry();
    registry.register(
      typeDef(TYPE_OBJECT, OBJECT_ENTITY, [
        { childType: TYPE_FIELD, childSubType: CHILD_RULE_WILDCARD, childName: CHILD_RULE_WILDCARD },
      ]),
    );
    // field.string admits NO validators (closed set) — the validator child is rejected.
    registry.register(typeDef(TYPE_FIELD, FIELD_STRING, []));

    const { errors } = validateAttrSchema(buildTree(), registry, /* strict */ true);
    const childErrors = errors.filter((e) => e.code === "ERR_CHILD_NOT_ALLOWED");
    expect(childErrors).toHaveLength(1);
    expect(childErrors[0]!.message).toContain("validator.required");
    expect(childErrors[0]!.message).toContain("field.string");
  });

  it("is a no-op in LAX mode even for a closed parent (legacy open policy)", () => {
    const registry = new TypeRegistry();
    registry.register(
      typeDef(TYPE_OBJECT, OBJECT_ENTITY, [
        { childType: TYPE_FIELD, childSubType: CHILD_RULE_WILDCARD, childName: CHILD_RULE_WILDCARD },
      ]),
    );
    registry.register(typeDef(TYPE_FIELD, FIELD_STRING, []));

    const { errors } = validateAttrSchema(buildTree(), registry, /* strict */ false);
    expect(errors.filter((e) => e.code === "ERR_CHILD_NOT_ALLOWED")).toHaveLength(0);
  });

  it("admits a child via a subtype LIST rule", () => {
    const registry = new TypeRegistry();
    registry.register(
      typeDef(TYPE_OBJECT, OBJECT_ENTITY, [
        { childType: TYPE_FIELD, childSubType: CHILD_RULE_WILDCARD, childName: CHILD_RULE_WILDCARD },
      ]),
    );
    registry.register(
      typeDef(TYPE_FIELD, FIELD_STRING, [
        { childType: TYPE_VALIDATOR, childSubType: [VALIDATOR_REQUIRED, "length"], childName: CHILD_RULE_WILDCARD },
      ]),
    );

    const { errors } = validateAttrSchema(buildTree(), registry, /* strict */ true);
    expect(errors.filter((e) => e.code === "ERR_CHILD_NOT_ALLOWED")).toHaveLength(0);
  });

  it("does not judge an UNREGISTERED parent (skips — reported elsewhere)", () => {
    const registry = new TypeRegistry();
    // Only the field is registered; the entity parent is NOT — its children can't
    // be judged, so no ERR_CHILD_NOT_ALLOWED for the field placed under it.
    registry.register(typeDef(TYPE_FIELD, FIELD_STRING, []));

    const { errors } = validateAttrSchema(buildTree(), registry, /* strict */ true);
    // The field-under-unregistered-entity placement is NOT flagged; only the
    // validator-under-closed-field placement is.
    const childErrors = errors.filter((e) => e.code === "ERR_CHILD_NOT_ALLOWED");
    expect(childErrors).toHaveLength(1);
    expect(childErrors[0]!.message).toContain("validator.required");
  });
});
