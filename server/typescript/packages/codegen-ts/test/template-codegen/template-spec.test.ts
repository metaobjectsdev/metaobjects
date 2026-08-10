import { describe, test, expect } from "bun:test";
import { parseTemplateSpec, templateSpecToGenerators } from "../../src/template-codegen/template-spec.js";
import schema from "../../src/template-codegen/template-spec.schema.json" with { type: "json" };

const VALID = {
  generators: [
    { name: "svc", template: "service/entity", scope: "perEntity", outputPattern: "{name}.service.ts" },
    { name: "reg", template: "app/registry", scope: "perModel", outputPattern: "registry.ts", format: "text" },
  ],
};

describe("parseTemplateSpec", () => {
  test("accepts a valid spec", () => {
    const spec = parseTemplateSpec(VALID);
    expect(spec.generators.length).toBe(2);
    expect(spec.generators[0]!.scope).toBe("perEntity");
    expect(spec.generators[1]!.format).toBe("text");
  });
  test("rejects an unknown scope", () => {
    expect(() => parseTemplateSpec({ generators: [{ name: "x", template: "t", scope: "perThing", outputPattern: "x" }] }))
      .toThrow(/scope/i);
  });
  test("rejects a missing required field", () => {
    expect(() => parseTemplateSpec({ generators: [{ name: "x", template: "t", scope: "perModel" }] }))
      .toThrow(/outputPattern/i);
  });
  test("rejects a non-object", () => {
    expect(() => parseTemplateSpec(null)).toThrow(/expected an object with a `generators` array/);
  });
  test("rejects an unknown format", () => {
    expect(() => parseTemplateSpec({
      generators: [{ name: "x", template: "t", scope: "perModel", outputPattern: "x", format: "xml-typo" }],
    })).toThrow(/format/i);
  });
  test("accepts every schema-enumerated format", () => {
    for (const fmt of ["text", "html", "xml", "csv", "json", "markdown", "spreadsheet"] as const) {
      const spec = parseTemplateSpec({
        generators: [{ name: "x", template: "t", scope: "perModel", outputPattern: "x", format: fmt }],
      });
      expect(spec.generators[0]!.format).toBe(fmt);
    }
  });
});

describe("templateSpecToGenerators", () => {
  test("maps each entry to a Generator with the entry name", () => {
    const gens = templateSpecToGenerators(parseTemplateSpec(VALID));
    expect(gens.map((g) => g.name)).toEqual(["svc", "reg"]);
  });
});

describe("schema ↔ parser drift", () => {
  test("schema enumerates the same scopes the parser accepts", () => {
    const scopeEnum = (schema as { properties: { generators: { items: { properties: { scope: { enum: string[] } } } } } })
      .properties.generators.items.properties.scope.enum;
    expect(scopeEnum).toEqual(["perEntity", "perPackage", "perModel"]);
  });
  test("schema enumerates the same formats the parser accepts", () => {
    const formatEnum = (schema as { properties: { generators: { items: { properties: { format: { enum: string[] } } } } } })
      .properties.generators.items.properties.format.enum;
    for (const fmt of formatEnum) {
      expect(() => parseTemplateSpec({
        generators: [{ name: "x", template: "t", scope: "perModel", outputPattern: "x", format: fmt }],
      })).not.toThrow();
    }
  });
});
