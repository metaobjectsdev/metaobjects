import { describe, it, expect } from "bun:test";
import { composeRegistry, coreProviders, TYPE_FIELD, FIELD_SUBTYPE_STRING } from "../src/index.js";
import { TypeId, type TypeDefinition } from "../src/registry.js";

/**
 * ADR-0023 Decision 2 — the sealed registry (TS edition).
 *
 * TS already composes its registry from an explicit immutable provider set
 * (`composeRegistry(coreProviders)`), so there is no polluted global singleton
 * to pivot off — sealing here is the guard + negative test that codegen cannot
 * register a made-up metamodel attribute/type post-bootstrap. After `seal()`,
 * every mutating registration throws `ERR_REGISTRY_SEALED`.
 */
describe("ADR-0023 sealed TypeRegistry", () => {
  function sealed() {
    const r = composeRegistry(coreProviders);
    r.seal();
    return r;
  }

  function expectSealed(fn: () => void) {
    expect(fn).toThrow(/sealed/i);
    try {
      fn();
    } catch (e) {
      expect((e as { code?: string }).code).toBe("ERR_REGISTRY_SEALED");
    }
  }

  it("seal() is idempotent and queryable", () => {
    const r = composeRegistry(coreProviders);
    expect(r.isSealed()).toBe(false);
    r.seal();
    expect(r.isSealed()).toBe(true);
    r.seal();
    expect(r.isSealed()).toBe(true);
  });

  it("register() after seal throws ERR_REGISTRY_SEALED", () => {
    const r = sealed();
    const def: TypeDefinition = {
      typeId: new TypeId("widget", "madeUp"),
      description: "a subtype no provider agreed on",
      attributes: [],
      childRules: [],
      factory: () => ({}) as never,
    };
    expectSealed(() => r.register(def));
  });

  it("extend() after seal throws (the codegen self-registration case)", () => {
    const r = sealed();
    expectSealed(() =>
      r.extend(TYPE_FIELD, FIELD_SUBTYPE_STRING, {
        attributes: [{ name: "aiMadeUpAttr", valueType: "string", required: false, description: "" }],
      }),
    );
  });

  it("registerCommonAttrs() after seal throws", () => {
    const r = sealed();
    expectSealed(() => r.registerCommonAttrs([{ name: "madeUpCommonAttr", valueType: "string", required: false, description: "" }]));
  });

  it("setDefaultSubType() after seal throws", () => {
    const r = sealed();
    expectSealed(() => r.setDefaultSubType(TYPE_FIELD, "madeUpDefault"));
  });

  it("reads still work after seal", () => {
    const r = sealed();
    expect(r.allTypes().length).toBeGreaterThan(0);
    expect(r.has(TYPE_FIELD, FIELD_SUBTYPE_STRING)).toBe(true);
  });
});
