import { test, expect } from "bun:test";
import { TypeRegistry } from "../src/registry.js";
import { registerCoreTypes, coreProviders } from "../src/core-types.js";
import { composeRegistry } from "../src/provider.js";
import { desugar } from "../src/core/yaml-desugar.js";

function coreRegistry(): TypeRegistry {
  const registry = new TypeRegistry();
  registerCoreTypes(registry);
  return registry;
}

/** A registry with the full default-provider bundle (core + db), so attrs
 *  registered by dbProvider (e.g. `@column`) are in scope for D2 tests. */
function fullRegistry(): TypeRegistry {
  return composeRegistry(coreProviders);
}

test("rule 1: a bare type key resolves to the registry default subType", () => {
  const { canonical, errors } = desugar({ object: { name: "Product" } }, coreRegistry());
  expect(errors).toEqual([]);
  expect(canonical).toEqual({ "object.entity": { name: "Product" } });
});

test("rule 1: a fused type.subType key is left untouched", () => {
  const { canonical, errors } = desugar({ "object.value": { name: "Money" } }, coreRegistry());
  expect(errors).toEqual([]);
  expect(canonical).toEqual({ "object.value": { name: "Money" } });
});

test("rule 1: a bare key for a type with no default subType is a collected error", () => {
  const { errors } = desugar({ field: { name: "sku" } }, coreRegistry());
  expect(errors.length).toBeGreaterThan(0);
});

test("rule 2: a scalar body becomes { name: <scalar> }", () => {
  const { canonical, errors } = desugar({ "field.string": "sku" }, coreRegistry());
  expect(errors).toEqual([]);
  expect(canonical).toEqual({ "field.string": { name: "sku" } });
});

test("rule 2: a mapping body keeps reserved + already-@-prefixed keys as-authored", () => {
  const { canonical } = desugar(
    { "field.string": { name: "sku", "@column": "sku_code" } },
    coreRegistry(),
  );
  expect(canonical).toEqual({ "field.string": { name: "sku", "@column": "sku_code" } });
});

test("rule 5: bare body keys not in RESERVED_KEYS are @-prefixed (sigil-free authoring)", () => {
  const { canonical, errors } = desugar(
    { "field.string": { name: "sku", column: "sku_code" } },
    coreRegistry(),
  );
  expect(errors).toEqual([]);
  expect(canonical).toEqual({ "field.string": { name: "sku", "@column": "sku_code" } });
});

test("rule 5: reserved structural keywords stay bare (not @-prefixed)", () => {
  const { canonical, errors } = desugar(
    {
      "object.entity": {
        name: "Program",
        extends: "BaseEntity",
        abstract: false,
        overlay: false,
        isArray: false,
        children: [],
      },
    },
    coreRegistry(),
  );
  expect(errors).toEqual([]);
  expect(canonical).toEqual({
    "object.entity": {
      name: "Program",
      extends: "BaseEntity",
      abstract: false,
      overlay: false,
      isArray: false,
      children: [],
    },
  });
});

test("rule 5: a mix of bare and already-@-prefixed attrs both flow through (backward compat)", () => {
  const { canonical, errors } = desugar(
    { "field.object": { name: "address", "@objectRef": "Address", storage: "flattened" } },
    coreRegistry(),
  );
  expect(errors).toEqual([]);
  expect(canonical).toEqual({
    "field.object": {
      name: "address",
      "@objectRef": "Address",
      "@storage": "flattened",
    },
  });
});

test("rule 5: bare attrs in nested children are also @-prefixed", () => {
  const { canonical, errors } = desugar(
    {
      "object.entity": {
        name: "Product",
        children: [{ "field.string": { name: "sku", column: "sku_code" } }],
      },
    },
    coreRegistry(),
  );
  expect(errors).toEqual([]);
  expect(canonical).toEqual({
    "object.entity": {
      name: "Product",
      children: [{ "field.string": { name: "sku", "@column": "sku_code" } }],
    },
  });
});

test("rule 3: a node with no children gets no synthesized children key", () => {
  const { canonical } = desugar({ "object.entity": { name: "Product" } }, coreRegistry());
  const body = (canonical as Record<string, Record<string, unknown>>)["object.entity"]!;
  expect("children" in body).toBe(false);
});

test("rule 4: a trailing [] on the key strips to isArray: true on the body", () => {
  const { canonical, errors } = desugar({ "field.string[]": "tags" }, coreRegistry());
  expect(errors).toEqual([]);
  expect(canonical).toEqual({ "field.string": { name: "tags", isArray: true } });
});

test("recursion: children nodes are desugared", () => {
  const { canonical, errors } = desugar(
    {
      "object.entity": {
        name: "Product",
        children: [{ "field.string": "sku" }, { "field.long[]": "weekIds" }],
      },
    },
    coreRegistry(),
  );
  expect(errors).toEqual([]);
  expect(canonical).toEqual({
    "object.entity": {
      name: "Product",
      children: [
        { "field.string": { name: "sku" } },
        { "field.long": { name: "weekIds", isArray: true } },
      ],
    },
  });
});

test("malformed: a list body is a collected error", () => {
  const { errors } = desugar({ "field.string": ["a", "b"] }, coreRegistry());
  expect(errors.length).toBeGreaterThan(0);
});

test("malformed: a non-mapping document is a collected error with empty canonical", () => {
  const { canonical, errors } = desugar("just a string", coreRegistry());
  expect(errors.length).toBeGreaterThan(0);
  expect(Object.keys(canonical)).toEqual([]);
});

// ---------------------------------------------------------------------------
// D2 — YAML type-coercion guard (ADR-0006 D2)
// ---------------------------------------------------------------------------

test("D2: a boolean parsed for a string-typed attr is an ERR_YAML_COERCION", () => {
  // `column: TRUE` in YAML → JS true. The schema says @column on field.string
  // is a string-typed attr, so this is a silent coercion.
  const { errors } = desugar(
    { "field.string": { name: "active", column: true } },
    fullRegistry(),
  );
  const coercion = errors.find((e) => e.code === "ERR_YAML_COERCION");
  expect(coercion).toBeDefined();
  expect(coercion!.message).toContain("@column");
  expect(coercion!.message).toContain("expected string");
  expect(coercion!.message).toContain("boolean");
  expect(coercion!.message.toLowerCase()).toContain("quote");
});

test("D2: a string value for a string-typed attr is NOT an error", () => {
  const { errors } = desugar(
    { "field.string": { name: "active", column: "TRUE" } },
    fullRegistry(),
  );
  expect(errors.filter((e) => e.code === "ERR_YAML_COERCION")).toEqual([]);
});

test("D2: an unquoted number in a string-array attr triggers per-element coercion", () => {
  // field.enum.@values is a string-array attr. A YAML list with an unquoted
  // `42` becomes JS number 42 — silent coercion.
  const { errors } = desugar(
    {
      "field.enum": {
        name: "status",
        values: ["DRAFT", 42, "PUBLISHED"],
      },
    },
    fullRegistry(),
  );
  const coercion = errors.find((e) => e.code === "ERR_YAML_COERCION");
  expect(coercion).toBeDefined();
  expect(coercion!.message).toContain("@values[1]");
  expect(coercion!.message).toContain("number");
});

test("D2: a boolean for a boolean-typed attr is NOT an error (no coercion)", () => {
  // @filterable on a field is boolean-typed.
  const { errors } = desugar(
    { "field.string": { name: "sku", filterable: true } },
    fullRegistry(),
  );
  expect(errors.filter((e) => e.code === "ERR_YAML_COERCION")).toEqual([]);
});

test("D2: an awkward author form (@column: TRUE) is ALSO guarded", () => {
  const { errors } = desugar(
    { "field.string": { name: "active", "@column": true } },
    fullRegistry(),
  );
  const coercion = errors.find((e) => e.code === "ERR_YAML_COERCION");
  expect(coercion).toBeDefined();
});
