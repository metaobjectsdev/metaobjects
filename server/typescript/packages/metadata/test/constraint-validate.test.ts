// FR-033 — contradiction validator tests (Task 9). One failing-first test per
// check (spec §3.1), plus a fully-consistent registry that yields zero errors.
import { test, expect } from "bun:test";
import {
  defineProviderFromData,
  type ProviderDefinition,
} from "../src/provider-data.js";
import { TypeId, type TypeRegistry } from "../src/registry.js";
import { composeRegistry, type MetaDataTypeProvider } from "../src/provider.js";
import { mergeConstraints } from "../src/constraint-merge.js";
import { validateConstraints } from "../src/constraint-validate.js";
import type { MetaData } from "../src/shared/meta-data.js";
import { MetaField } from "../src/core/field/meta-field.js";

// MetaData is abstract; these synthetic registries never construct nodes, so any
// concrete factory satisfies the `(id, name) => MetaData` contract.
const NODE_FACTORY = (id: TypeId, name: string) => new MetaField(id, name);
const FIELD_FACTORY = (id: TypeId, name: string) => new MetaField(id, name);

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

function validate(reg: TypeRegistry) {
  return validateConstraints(mergeConstraints(reg), reg);
}

const CODE = "ERR_INVALID_METAMODEL_CONSTRAINT";

test("a fully-consistent registry yields zero errors", () => {
  const reg = composeRegistry([
    providerOf(
      {
        provider: "ok",
        types: [
          {
            type: "object",
            subType: "entity",
            description: "An entity.",
            children: [
              { type: "field", subType: "*", name: "*", min: 0, max: null },
              { type: "identity", subType: "primary", name: "*", min: 1, max: 1 },
            ],
          },
          { type: "field", subType: "base", description: "Base field." },
          { type: "identity", subType: "primary", description: "Primary key." },
        ],
      },
      {
        "object.entity": NODE_FACTORY,
        "field.base": FIELD_FACTORY,
        "identity.primary": NODE_FACTORY,
      },
    ),
  ]);
  expect(validate(reg)).toEqual([]);
});

test("#1 dangling ref — a child rule references an unregistered type.subType", () => {
  const reg = composeRegistry([
    providerOf(
      {
        provider: "dangling",
        types: [
          {
            type: "object",
            subType: "entity",
            description: "An entity.",
            children: [
              // ghost.thing is never registered.
              { type: "ghost", subType: "thing", name: "*", min: 0, max: null },
            ],
          },
        ],
      },
      { "object.entity": NODE_FACTORY },
    ),
  ]);
  const errs = validate(reg);
  expect(errs.length).toBeGreaterThanOrEqual(1);
  expect(errs.every((e) => e.code === CODE)).toBe(true);
  expect(errs.some((e) => e.message.includes("dangling") && e.message.includes("ghost.thing"))).toBe(
    true,
  );
});

test("#2 unsatisfiable required child — min>=1 but the type is not admitted under the parent", () => {
  const reg = composeRegistry([
    providerOf(
      {
        provider: "unsat",
        types: [
          {
            type: "object",
            subType: "entity",
            description: "An entity.",
            children: [
              // Requires an identity.primary, but the parent admits only field.* —
              // identity.primary is registered but NOT admitted here, and declares
              // no `parents` claim. (It IS a required rule that can never be met.)
              { type: "identity", subType: "primary", name: "*", min: 1, max: 1 },
              // The only OTHER admitting rule is for field.*, which does not cover identity.
              { type: "field", subType: "string", name: "*", min: 0, max: null },
            ],
          },
          { type: "identity", subType: "primary", description: "PK." },
          { type: "field", subType: "string", description: "String field." },
        ],
      },
      {
        "object.entity": NODE_FACTORY,
        "identity.primary": NODE_FACTORY,
        "field.string": FIELD_FACTORY,
      },
    ),
  ]);
  // Note: the required identity rule IS the admitting rule for itself, so this
  // particular shape is satisfiable. Build a genuinely unsatisfiable case: the
  // required rule names a subtype that no admitting rule (including itself) covers.
  // Reconstruct below.
  void reg;

  const bad = composeRegistry([
    providerOf(
      {
        provider: "unsat2",
        types: [
          {
            type: "object",
            subType: "entity",
            description: "An entity.",
            children: [
              // Required: at least one identity.primary — but expressed as a min>=1
              // rule whose subType is a LIST that does not include any registered
              // admitted child, making it unsatisfiable.
              {
                type: "identity",
                subType: ["secondary"],
                name: "*",
                min: 1,
                max: 1,
              },
            ],
          },
          // Only identity.primary exists — identity.secondary is unregistered, so
          // the required rule can never be satisfied (also dangling, but the
          // unsatisfiable-required check fires).
          { type: "identity", subType: "primary", description: "PK." },
        ],
      },
      { "object.entity": NODE_FACTORY, "identity.primary": NODE_FACTORY },
    ),
  ]);
  const errs = validate(bad);
  expect(errs.some((e) => e.code === CODE && e.message.includes("unsatisfiable"))).toBe(true);
});

test("#3 bad cardinality — min > max", () => {
  // defineProviderFromData rejects min>max at build time, so construct the bad
  // rule directly on the registry to reach the validator.
  const reg = composeRegistry([
    providerOf(
      {
        provider: "card",
        types: [{ type: "object", subType: "entity", description: "An entity." }],
      },
      { "object.entity": NODE_FACTORY },
    ),
  ]);
  reg.find("object", "entity")!.childRules.push({
    childType: "field",
    childSubType: "*",
    childName: "*",
    min: 3,
    max: 1,
  });
  const errs = validate(reg);
  expect(errs.some((e) => e.code === CODE && e.message.includes("cardinality"))).toBe(true);
});

test("#4 closed-set clash — child claims a parent whose closed children set excludes it", () => {
  const reg = composeRegistry([
    providerOf(
      {
        provider: "closed",
        types: [
          {
            type: "object",
            subType: "entity",
            description: "An entity.",
            // CLOSED set (no `*` rule): admits only field.* — no extension hook.
            children: [{ type: "field", subType: "*", name: "*", min: 0, max: null }],
          },
          { type: "field", subType: "base", description: "Base field." },
        ],
      },
      { "object.entity": NODE_FACTORY, "field.base": FIELD_FACTORY },
    ),
    providerOf(
      {
        provider: "intruder",
        types: [
          {
            type: "policy",
            subType: "retention",
            description: "A policy.",
            // Claims object.entity as a parent, but entity's set is closed + excludes policy.
            parents: ["object.entity"],
          },
        ],
      },
      { "policy.retention": NODE_FACTORY },
    ),
  ]);
  const errs = validate(reg);
  expect(
    errs.some((e) => e.code === CODE && e.message.includes("closed") && e.message.includes("policy.retention")),
  ).toBe(true);
});

test("#4 NO clash when parent is OPEN (has a * rule)", () => {
  const reg = composeRegistry([
    providerOf(
      {
        provider: "open",
        types: [
          {
            type: "object",
            subType: "entity",
            description: "An entity.",
            // OPEN: a wildcard rule admits anything.
            children: [{ type: "*", subType: "*", name: "*", min: 0, max: null }],
          },
        ],
      },
      { "object.entity": NODE_FACTORY },
    ),
    providerOf(
      {
        provider: "guest",
        types: [
          {
            type: "policy",
            subType: "retention",
            description: "A policy.",
            parents: ["object.entity"],
          },
        ],
      },
      { "policy.retention": NODE_FACTORY },
    ),
  ]);
  expect(validate(reg).filter((e) => e.message.includes("closed"))).toEqual([]);
});

test("#5 required-child cycle — A requires B requires A with no escape", () => {
  const reg = composeRegistry([
    providerOf(
      {
        provider: "cycle",
        types: [
          {
            type: "node",
            subType: "a",
            description: "A.",
            children: [{ type: "node", subType: "b", name: "*", min: 1, max: 1 }],
          },
          {
            type: "node",
            subType: "b",
            description: "B.",
            children: [{ type: "node", subType: "a", name: "*", min: 1, max: 1 }],
          },
        ],
      },
      { "node.a": NODE_FACTORY, "node.b": NODE_FACTORY },
    ),
  ]);
  const errs = validate(reg);
  expect(errs.some((e) => e.code === CODE && e.message.includes("cycle"))).toBe(true);
});

test("#6 conflicting attr redefinition — same name, conflicting required across the extends chain", () => {
  const reg = composeRegistry([
    providerOf(
      {
        provider: "attrs",
        types: [
          {
            type: "field",
            subType: "base",
            description: "Base field.",
            children: [
              {
                type: "attr",
                subType: "string",
                name: "label",
                min: 0, // optional on base
                max: 1,
                description: "A label.",
              },
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
                name: "label",
                min: 1, // CONFLICT: required on the subtype (narrowing the inherited optional)
                max: 1,
                description: "A label.",
              },
            ],
          },
        ],
      },
      { "field.base": FIELD_FACTORY, "field.currency": FIELD_FACTORY },
    ),
  ]);
  const errs = validate(reg);
  expect(
    errs.some((e) => e.code === CODE && e.message.includes("attr") && e.message.includes("label")),
  ).toBe(true);
});
