// object-definition-completeness — proves the FR-033 S1-object strict re-scope of
// the object provider (spec/metamodel/object.json, read via defineProviderFromData)
// is FAITHFUL and STRICT. Object is the last core provider made strict: object.base
// holds the INTERSECTION of every subtype's structural children
// (field/identity/validator/layout/source/index); each concrete subtype sets
// extendsBase:true and adds ONLY its own children — value adds relationship; entity
// adds relationship + template + the FR-014 TPH attrs @discriminator/
// @discriminatorValue (an entity-inheritance concept); projection inherits the base
// intersection ONLY (no relationship, no template). The "any attr" wildcard child
// rule is GONE from all four. This test pins the EXACT composed per-subtype
// childRules (base=6 / value=7 / entity=8 / projection=6, none with an attr
// wildcard) AND the attr scoping (@discriminator/@discriminatorValue ONLY on
// entity), with explicit negatives. expected-registry.json (children byte-identical)
// is the second gate; enforcement (ERR_UNKNOWN_ATTR / ERR_CHILD_NOT_ALLOWED) is the
// runtime backstop.

import { describe, test, expect } from "bun:test";
import { composeRegistry } from "../src/provider.js";
import { coreProviders } from "../src/core-types.js";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";
import {
  TYPE_OBJECT,
  TYPE_TEMPLATE,
  TYPE_RELATIONSHIP,
} from "../src/shared/base-types.js";
import {
  OBJECT_SUBTYPES,
  OBJECT_SUBTYPE_ENTITY,
  OBJECT_SUBTYPE_VALUE,
  OBJECT_SUBTYPE_PROJECTION,
} from "../src/core/object/object-constants.js";
import { SUBTYPE_BASE } from "../src/shared/base-types.js";

// FR-033 S1-field-A re-homed the object.value @normalize default out of the core
// object definition into metaobjects-prompt, so this gate composes the WHOLE
// coreProviders bundle (not coreTypesProvider alone) to see the full composed
// object attr set. The concern providers add no attrs to the object subtypes
// EXCEPT promptProvider's @normalize on object.value (their field attrs land on
// field subtypes, not object subtypes); doc commonAttrs are registry-level, not
// per-type — so the object-subtype attr sets below are exactly as expected.
const registry = composeRegistry([...coreProviders]);

interface ExpectedAttr {
  valueType: string | null;
  required: boolean;
  default?: string;
  allowedValues?: readonly string[];
}

// FR-014 TPH discriminator attrs — entity-inheritance only ⇒ object.entity ONLY.
const DISCRIMINATOR: Record<string, ExpectedAttr> = {
  discriminator: { valueType: "string", required: false },
  discriminatorValue: { valueType: "string", required: false },
};

// object.value carries @normalize (the object-level default normalization mode,
// contributed by metaobjects-prompt).
const NORMALIZE: Record<string, ExpectedAttr> = {
  normalize: {
    valueType: "string",
    required: false,
    default: "strip",
    allowedValues: ["none", "collapse", "strip"],
  },
};

// #207 — object.projection carries a row-scope @filter (an attr.filter object lowered
// to a view-level WHERE); mirrors origin.aggregate's filter-attr placement.
const PROJECTION_FILTER: Record<string, ExpectedAttr> = {
  filter: { valueType: "filter", required: false },
};

function expectedAttrsFor(subType: string): Record<string, ExpectedAttr> {
  if (subType === OBJECT_SUBTYPE_ENTITY) return { ...DISCRIMINATOR };
  if (subType === OBJECT_SUBTYPE_VALUE) return { ...NORMALIZE };
  if (subType === OBJECT_SUBTYPE_PROJECTION) return { ...PROJECTION_FILTER };
  // base carries NO attrs (discriminator moved to entity only).
  return {};
}

// The EXACT composed structural childRule childType set per subtype (the critical
// safety net). Base is the intersection of all subtypes (6 rules); value adds
// relationship (7); entity adds relationship + template (8); projection inherits
// base only (6). NO subtype carries an `attr` wildcard rule (strict/fail-closed —
// attrs enforce via the named AttrSchema set, ERR_UNKNOWN_ATTR).
const BASE_RULE_TYPES = ["field", "identity", "validator", "layout", "source", "index"];
const VALUE_RULE_TYPES = [...BASE_RULE_TYPES, TYPE_RELATIONSHIP];
const ENTITY_RULE_TYPES = [...BASE_RULE_TYPES, TYPE_RELATIONSHIP, TYPE_TEMPLATE];
const PROJECTION_RULE_TYPES = [...BASE_RULE_TYPES];

function expectedChildTypesFor(subType: string): string[] {
  if (subType === OBJECT_SUBTYPE_ENTITY) return ENTITY_RULE_TYPES;
  if (subType === OBJECT_SUBTYPE_VALUE) return VALUE_RULE_TYPES;
  if (subType === OBJECT_SUBTYPE_PROJECTION) return PROJECTION_RULE_TYPES;
  return BASE_RULE_TYPES; // base
}

describe("object provider — strict per-subtype completeness (FR-033 S1-object)", () => {
  test("registers all 4 object subtypes", () => {
    const registered = registry.allSubTypesOf(TYPE_OBJECT).sort();
    expect(registered).toEqual([...OBJECT_SUBTYPES].sort());
  });

  for (const subType of OBJECT_SUBTYPES) {
    test(`object.${subType} — attr name-set, valueType, required, default, allowedValues match the strict per-subtype schema`, () => {
      const def = registry.find(TYPE_OBJECT, subType);
      expect(def).toBeDefined();
      const expected = expectedAttrsFor(subType);

      // Attr name-set is exactly the expected set.
      const actualNames = def!.attributes.map((a) => a.name).sort();
      expect(actualNames).toEqual(Object.keys(expected).sort());

      // Each attr's valueType + required (+ default + allowedValues) match.
      for (const attr of def!.attributes) {
        const exp = expected[attr.name];
        expect(exp).toBeDefined();
        expect((attr.valueType ?? null) as string | null).toBe(exp!.valueType);
        expect(attr.required).toBe(exp!.required);
        expect(attr.default ?? undefined).toEqual(exp!.default);
        expect(attr.allowedValues).toEqual(exp!.allowedValues);
      }
    });

    test(`object.${subType} — structural childRules match the EXACT composed per-subtype set (no attr wildcard)`, () => {
      const def = registry.find(TYPE_OBJECT, subType)!;
      const actualTypes = def.childRules.map((r) => r.childType).sort();
      expect(actualTypes).toEqual([...expectedChildTypesFor(subType)].sort());

      // The "any attr" wildcard child rule is GONE from every subtype.
      expect(def.childRules.some((r) => r.childType === "attr")).toBe(false);

      // All structural rules are wildcard (subType/name = "*").
      for (const rule of def.childRules) {
        expect(rule.childSubType).toBe("*");
        expect(rule.childName).toBe("*");
      }
    });
  }

  test("composed childRule counts: base=6, value=7, entity=8, projection=6", () => {
    expect(registry.find(TYPE_OBJECT, SUBTYPE_BASE)!.childRules.length).toBe(6);
    expect(registry.find(TYPE_OBJECT, OBJECT_SUBTYPE_VALUE)!.childRules.length).toBe(7);
    expect(registry.find(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY)!.childRules.length).toBe(8);
    expect(registry.find(TYPE_OBJECT, OBJECT_SUBTYPE_PROJECTION)!.childRules.length).toBe(6);
  });

  test("only object.entity carries the template childRule", () => {
    for (const subType of OBJECT_SUBTYPES) {
      const def = registry.find(TYPE_OBJECT, subType)!;
      const hasTemplate = def.childRules.some((r) => r.childType === TYPE_TEMPLATE);
      expect(hasTemplate).toBe(subType === OBJECT_SUBTYPE_ENTITY);
    }
  });

  test("relationship childRule is on object.value + object.entity ONLY (base = intersection, projection forbids it)", () => {
    const withRelationship = new Set<string>([OBJECT_SUBTYPE_VALUE, OBJECT_SUBTYPE_ENTITY]);
    for (const subType of OBJECT_SUBTYPES) {
      const def = registry.find(TYPE_OBJECT, subType)!;
      const hasRelationship = def.childRules.some((r) => r.childType === TYPE_RELATIONSHIP);
      expect(hasRelationship).toBe(withRelationship.has(subType));
    }
  });

  test("@discriminator / @discriminatorValue are scoped to object.entity ONLY", () => {
    for (const subType of OBJECT_SUBTYPES) {
      const def = registry.find(TYPE_OBJECT, subType)!;
      const names = def.attributes.map((a) => a.name);
      const hasDiscriminator = names.includes("discriminator") || names.includes("discriminatorValue");
      expect(hasDiscriminator).toBe(subType === OBJECT_SUBTYPE_ENTITY);
    }
  });

  // --- explicit enforcement negatives (strict fail-closed bites now) ---

  // Strict load is what bites: the S0 placement + attr-schema checks run in
  // strict mode (library boots strict; ERR_UNKNOWN_ATTR / ERR_CHILD_NOT_ALLOWED).
  async function load(doc: unknown) {
    return new MetaDataLoader({ strict: true }).load([
      new InMemoryStringSource(JSON.stringify(doc), { id: "test.json" }),
    ]);
  }

  test("@discriminator on object.value → ERR_UNKNOWN_ATTR (entity-only attr)", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "test::strict",
        children: [
          {
            "object.value": {
              name: "Money",
              "@discriminator": "kind",
              children: [{ "field.int": { name: "amount" } }],
            },
          },
        ],
      },
    });
    expect(errors.some((e) => (e as { code?: string }).code === "ERR_UNKNOWN_ATTR")).toBe(true);
  });

  test("a relationship child under object.projection → ERR_CHILD_NOT_ALLOWED", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "test::strict",
        children: [
          {
            "object.projection": {
              name: "OrderView",
              children: [
                { "field.int": { name: "id" } },
                {
                  "relationship.association": {
                    name: "customer",
                    "@objectRef": "Customer",
                    "@cardinality": "one",
                  },
                },
              ],
            },
          },
        ],
      },
    });
    expect(errors.some((e) => (e as { code?: string }).code === "ERR_CHILD_NOT_ALLOWED")).toBe(true);
  });
});
