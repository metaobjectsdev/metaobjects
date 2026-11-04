// ADR-0062 — the registry records which provider registered each attribute and refuses a
// second provider's claim on the same name. The cross-port scenarios live in
// fixtures/provider-composition-conformance/; this file pins the TS-specific details the
// shared corpus cannot (error text, no-trace-on-refusal, unowned registrations).

import { describe, expect, test } from "bun:test";
import { composeRegistry, type MetaDataTypeProvider } from "../src/provider.js";
import { TypeId, TypeRegistry, type TypeDefinition } from "../src/registry.js";
import { MetaTemplate } from "../src/template/meta-template.js";
import { TYPE_TEMPLATE, SUBTYPE_BASE } from "../src/shared/base-types.js";
import { ATTR_SUBTYPE_STRING } from "../src/core/attr/attr-constants.js";
import { coreProviders } from "../src/core-types.js";
import { MetaModelError } from "../src/errors.js";

function def(subType: string, ...attrNames: string[]): TypeDefinition {
  return {
    typeId: new TypeId(TYPE_TEMPLATE, subType),
    description: "test",
    factory: (typeId, name) => new MetaTemplate(typeId, name),
    childRules: [],
    attributes: attrNames.map((name) => ({
      name,
      valueType: ATTR_SUBTYPE_STRING,
      required: false,
      description: name,
    })),
  };
}

function provider(
  id: string,
  registerTypes: MetaDataTypeProvider["registerTypes"],
  dependencies: string[] = [],
): MetaDataTypeProvider {
  return { id, dependencies, registerTypes };
}

function codeOf(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (err) {
    const e = err as MetaModelError;
    return { code: e.code ?? "", message: e.message };
  }
  throw new Error("expected the call to throw");
}

describe("attribute ownership (ADR-0062)", () => {
  test("a shadowing registration names both providers and the attribute", () => {
    const { code, message } = codeOf(() =>
      composeRegistry([
        provider("owner-a", (r) => r.register(def(SUBTYPE_BASE, "physicalName"))),
        provider("owner-b", (r) => r.register(def("probe", "physicalName")), ["owner-a"]),
      ]),
    );
    expect(code).toBe("ERR_PROVIDER_ATTR_SHADOW");
    expect(message).toContain("owner-a");
    expect(message).toContain("owner-b");
    expect(message).toContain("physicalName");
  });

  test("a same-slot extend by another provider keeps ERR_PROVIDER_ATTR_CONFLICT and names the owner", () => {
    const { code, message } = codeOf(() =>
      composeRegistry([
        provider("owner-a", (r) => r.register(def("probe", "physicalName"))),
        provider("owner-b", (r) => r.extend(TYPE_TEMPLATE, "probe", { attributes: def("probe", "physicalName").attributes }), ["owner-a"]),
      ]),
    );
    expect(code).toBe("ERR_PROVIDER_ATTR_CONFLICT");
    expect(message).toContain("owner-a");
    expect(message).toContain("owner-b");
  });

  test("an extend onto the shared root collides with a subtype's name", () => {
    const { code } = codeOf(() =>
      composeRegistry([
        provider("owner-a", (r) => {
          r.register(def(SUBTYPE_BASE, "other"));
          r.register(def("probe", "physicalName"));
        }),
        provider("owner-b", (r) => r.extend(TYPE_TEMPLATE, SUBTYPE_BASE, { attributes: def("x", "physicalName").attributes }), ["owner-a"]),
      ]),
    );
    expect(code).toBe("ERR_PROVIDER_ATTR_SHADOW");
  });

  test("sibling subtypes may use one name: they are different slots", () => {
    const registry = composeRegistry([
      provider("owner-a", (r) => r.register(def("probe-a", "physicalName"))),
      provider("owner-b", (r) => r.register(def("probe-b", "physicalName")), ["owner-a"]),
    ]);
    expect(registry.attrOwner(TYPE_TEMPLATE, "probe-a", "physicalName")).toBe("owner-a");
    expect(registry.attrOwner(TYPE_TEMPLATE, "probe-b", "physicalName")).toBe("owner-b");
  });

  test("a refused registration leaves no trace in the registry", () => {
    const registry = new TypeRegistry();
    registry.runAsProvider("owner-a", () => registry.register(def(SUBTYPE_BASE, "physicalName")));
    expect(() => registry.runAsProvider("owner-b", () => registry.register(def("probe", "physicalName")))).toThrow();
    expect(registry.has(TYPE_TEMPLATE, "probe")).toBe(false);
    expect(registry.allSubTypesOf(TYPE_TEMPLATE)).toEqual([SUBTYPE_BASE]);
    expect(registry.attrOwner(TYPE_TEMPLATE, "probe", "physicalName")).toBeUndefined();
  });

  test("a registration outside any provider's turn claims nothing and collides with nothing", () => {
    const registry = new TypeRegistry();
    registry.register(def(SUBTYPE_BASE, "physicalName"));
    registry.runAsProvider("owner-b", () => registry.register(def("probe", "physicalName")));
    expect(registry.attrOwner(TYPE_TEMPLATE, SUBTYPE_BASE, "physicalName")).toBeUndefined();
    expect(registry.attrOwner(TYPE_TEMPLATE, "probe", "physicalName")).toBe("owner-b");
  });

  test("the shipped core providers compose with no collision and name an owner for every attribute", () => {
    const registry = composeRegistry([...coreProviders], { validate: true });
    const unowned: string[] = [];
    for (const id of registry.allTypes()) {
      for (const attr of registry.attrsOf(id.type, id.subType)) {
        if (registry.attrOwner(id.type, id.subType, attr.name) === undefined) {
          unowned.push(`${id.toString()}.${attr.name}`);
        }
      }
    }
    expect(unowned).toEqual([]);
  });
});
