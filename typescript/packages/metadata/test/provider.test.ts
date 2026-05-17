import { describe, it, expect } from "bun:test";
import { composeRegistry, type MetaDataTypeProvider } from "../src/provider.js";
import { coreTypesProvider, coreProviders, registerCoreTypes } from "../src/core-types.js";
import { TypeRegistry, TypeId } from "../src/registry.js";
import { MetaField } from "../src/meta/meta-field.js";
import {
  TYPE_FIELD,
  TYPE_OBJECT,
  TYPE_METADATA,
  SUBTYPE_ROOT,
  OBJECT_SUBTYPE_ENTITY,
  FIELD_SUBTYPE_STRING,
  ATTR_SUBTYPE_STRING,
} from "../src/constants.js";

function recordingProvider(
  id: string,
  dependencies: string[],
  log: string[],
): MetaDataTypeProvider {
  return {
    id,
    dependencies,
    registerTypes() {
      log.push(id);
    },
  };
}

describe("composeRegistry — provider composition", () => {
  it("registers providers in dependency order", () => {
    const log: string[] = [];
    composeRegistry([
      recordingProvider("c", ["a", "b"], log),
      recordingProvider("a", [], log),
      recordingProvider("b", ["a"], log),
    ]);
    expect(log).toEqual(["a", "b", "c"]);
  });

  it("keeps input order for independent providers", () => {
    const log: string[] = [];
    composeRegistry([
      recordingProvider("x", [], log),
      recordingProvider("y", [], log),
      recordingProvider("z", [], log),
    ]);
    expect(log).toEqual(["x", "y", "z"]);
  });

  it("throws on a dependency cycle", () => {
    const log: string[] = [];
    expect(() =>
      composeRegistry([
        recordingProvider("p", ["q"], log),
        recordingProvider("q", ["p"], log),
      ]),
    ).toThrow(/cycle/);
  });

  it("throws on a missing dependency", () => {
    const log: string[] = [];
    expect(() =>
      composeRegistry([recordingProvider("p", ["nonexistent"], log)]),
    ).toThrow(/nonexistent/);
  });

  it("throws on a duplicate provider id", () => {
    const log: string[] = [];
    expect(() =>
      composeRegistry([
        recordingProvider("dup", [], log),
        recordingProvider("dup", [], log),
      ]),
    ).toThrow(/duplicate/);
  });

  it("returns a populated TypeRegistry", () => {
    const registry = composeRegistry([
      { id: "noop", registerTypes() {} },
    ]);
    expect(typeof registry.has).toBe("function");
  });
});

describe("coreTypesProvider", () => {
  it("composeRegistry(coreProviders) registers the core metamodel", () => {
    const registry = composeRegistry(coreProviders);
    expect(registry.has(TYPE_FIELD, FIELD_SUBTYPE_STRING)).toBe(true);
    expect(registry.has(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY)).toBe(true);
    expect(registry.has(TYPE_METADATA, SUBTYPE_ROOT)).toBe(true);
    expect(registry.defaultSubTypeOf(TYPE_METADATA)).toBe(SUBTYPE_ROOT);
  });

  it("coreProviders is a single-provider bundle", () => {
    expect(coreProviders).toHaveLength(1);
    expect(coreProviders[0]).toBe(coreTypesProvider);
  });

  it("the registerCoreTypes wrapper registers the same types as the provider", () => {
    const viaWrapper = new TypeRegistry();
    registerCoreTypes(viaWrapper);
    const viaProvider = composeRegistry(coreProviders);
    expect(viaWrapper.allTypes().map(String).sort()).toEqual(
      viaProvider.allTypes().map(String).sort(),
    );
  });
});

describe("composeRegistry — third-party provider integration", () => {
  it("a third-party provider can add a new subtype and extend a core type", () => {
    const geoProvider: MetaDataTypeProvider = {
      id: "geo-types",
      dependencies: ["metaobjects-core-types"],
      registerTypes(registry: TypeRegistry): void {
        // adds a brand-new field subtype
        registry.register({
          typeId: new TypeId(TYPE_FIELD, "geopoint"),
          description: "A geographic point field",
          factory: (typeId, name) => new MetaField(typeId, name),
          childRules: [],
          attributes: [],
        });
        // extends an existing core type
        registry.extend(TYPE_FIELD, FIELD_SUBTYPE_STRING, {
          attributes: [
            { name: "geoSrid", valueType: ATTR_SUBTYPE_STRING, required: false, description: "spatial ref id" },
          ],
        });
      },
    };

    const registry = composeRegistry([...coreProviders, geoProvider]);

    // the new subtype is registered
    expect(registry.has(TYPE_FIELD, "geopoint")).toBe(true);
    // the core type still works AND carries the third-party extension
    expect(registry.has(TYPE_FIELD, FIELD_SUBTYPE_STRING)).toBe(true);
    expect(
      registry.attrsOf(TYPE_FIELD, FIELD_SUBTYPE_STRING).some((a) => a.name === "geoSrid"),
    ).toBe(true);
  });
});
