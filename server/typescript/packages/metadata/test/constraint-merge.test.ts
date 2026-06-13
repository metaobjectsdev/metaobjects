// FR-033 — additive constraint merge tests (Task 8).
//
// `mergeConstraints(registry)` folds:
//   (a) horizontal — a child-side `parents` claim ADDS placement to the named
//       parent's effective children (the extensibility point);
//   (b) vertical — a subtype inherits its super's children + attrs additively;
// and never removes anything.
import { test, expect } from "bun:test";
import {
  defineProviderFromData,
  type ProviderDefinition,
} from "../src/provider-data.js";
import { TypeId } from "../src/registry.js";
import { composeRegistry, type MetaDataTypeProvider } from "../src/provider.js";
import { mergeConstraints } from "../src/constraint-merge.js";
import { MetaField } from "../src/core/field/meta-field.js";
import type { MetaData } from "../src/shared/meta-data.js";

// MetaData is abstract; these synthetic registries never construct nodes (the merge
// only reads childRules/attributes), so any concrete factory satisfies the contract.
const NODE_FACTORY = (id: TypeId, name: string) => new MetaField(id, name);
const FIELD_FACTORY = (id: TypeId, name: string) => new MetaField(id, name);

/** Wrap a ProviderDefinition + factory map into a MetaDataTypeProvider. */
function providerOf(
  data: ProviderDefinition,
  factories: Record<string, (id: TypeId, name: string) => MetaData>,
): MetaDataTypeProvider {
  return {
    id: data.provider,
    registerTypes(reg) {
      for (const def of defineProviderFromData(data, factories)) {
        reg.register(def);
      }
    },
  };
}

test("(a) a child-side `parents` claim adds the child to the parent's effective children", () => {
  const core = providerOf(
    {
      provider: "core",
      types: [
        {
          type: "object",
          subType: "entity",
          description: "An entity.",
          children: [
            { type: "field", subType: "*", name: "*", min: 0, max: null },
          ],
        },
        { type: "source", subType: "rdb", description: "An RDB source." },
        { type: "field", subType: "base", description: "Base field." },
      ],
    },
    {
      "object.entity": NODE_FACTORY,
      "source.rdb": NODE_FACTORY,
      "field.base": FIELD_FACTORY,
    },
  );

  // An extension provider adds a NEW child type that claims object.entity as a parent.
  const ext = providerOf(
    {
      provider: "ext",
      types: [
        {
          type: "policy",
          subType: "retention",
          description: "A retention policy.",
          parents: ["object.entity"],
        },
      ],
    },
    { "policy.retention": NODE_FACTORY },
  );

  const reg = composeRegistry([core, ext]);
  const eff = mergeConstraints(reg);

  const entity = eff.get("object.entity");
  expect(entity).toBeDefined();
  // The original field rule is still there (nothing removed)...
  expect(
    entity!.children.some((r) => r.childType === "field" && r.childSubType === "*"),
  ).toBe(true);
  // ...AND policy.retention is now admitted as a child of object.entity.
  expect(
    entity!.children.some(
      (r) => r.childType === "policy" && r.childSubType === "retention",
    ),
  ).toBe(true);
});

test("(b) a subtype inherits its super's children + attrs additively", () => {
  const prov = providerOf(
    {
      provider: "fields",
      types: [
        {
          type: "field",
          subType: "base",
          description: "Base field.",
          children: [
            // An attr every field carries.
            {
              type: "attr",
              subType: "boolean",
              name: "required",
              min: 0,
              max: 1,
              description: "Whether the field is required.",
            },
            // A structural child every field may carry.
            { type: "validator", subType: "*", name: "*", min: 0, max: null },
          ],
        },
        {
          type: "field",
          subType: "currency",
          description: "Money field.",
          children: [
            {
              type: "attr",
              subType: "string",
              name: "currency",
              min: 0,
              max: 1,
              default: "USD",
              description: "ISO 4217 code.",
            },
          ],
        },
      ],
    },
    { "field.base": FIELD_FACTORY, "field.currency": FIELD_FACTORY },
  );

  const reg = composeRegistry([prov]);
  const eff = mergeConstraints(reg);

  const currency = eff.get("field.currency");
  expect(currency).toBeDefined();
  // Own attr.
  expect(currency!.attributes.some((a) => a.name === "currency")).toBe(true);
  // Inherited attr from field.base.
  expect(currency!.attributes.some((a) => a.name === "required")).toBe(true);
  // Inherited structural child from field.base.
  expect(
    currency!.children.some((r) => r.childType === "validator"),
  ).toBe(true);
});

test("(c) nothing is ever removed — base children survive the merge", () => {
  const prov = providerOf(
    {
      provider: "fields",
      types: [
        {
          type: "field",
          subType: "base",
          description: "Base field.",
          children: [
            { type: "validator", subType: "*", name: "*", min: 0, max: null },
            { type: "view", subType: "*", name: "*", min: 0, max: null },
          ],
        },
      ],
    },
    { "field.base": FIELD_FACTORY },
  );
  const reg = composeRegistry([prov]);
  const eff = mergeConstraints(reg);
  const base = eff.get("field.base");
  expect(base!.children.some((r) => r.childType === "validator")).toBe(true);
  expect(base!.children.some((r) => r.childType === "view")).toBe(true);
});

test("determinism — merge output is stable across repeated runs", () => {
  const prov = providerOf(
    {
      provider: "fields",
      types: [
        {
          type: "field",
          subType: "base",
          description: "Base field.",
          children: [{ type: "validator", subType: "*", name: "*", min: 0, max: null }],
        },
        { type: "field", subType: "currency", description: "Money." },
        { type: "field", subType: "enum", description: "Enum." },
      ],
    },
    {
      "field.base": FIELD_FACTORY,
      "field.currency": FIELD_FACTORY,
      "field.enum": FIELD_FACTORY,
    },
  );
  const a = JSON.stringify([...mergeConstraints(composeRegistry([prov])).entries()]);
  const b = JSON.stringify([...mergeConstraints(composeRegistry([prov])).entries()]);
  expect(a).toBe(b);
});
