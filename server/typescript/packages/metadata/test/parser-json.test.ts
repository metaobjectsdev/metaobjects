import { describe, it, expect, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseJson } from "../src/parser-json.js";
import { ParseError } from "../src/errors.js";
import { TypeRegistry } from "../src/registry.js";
import { registerCoreTypes } from "../src/core-types.js";
import {
  TYPE_METADATA,
  TYPE_OBJECT,
  TYPE_FIELD,
  TYPE_ATTR,
  TYPE_IDENTITY,
  TYPE_SOURCE,
  SUBTYPE_ROOT,
  OBJECT_SUBTYPE_ENTITY,
  FIELD_SUBTYPE_LONG,
  ATTR_SUBTYPE_BOOLEAN,
  IDENTITY_SUBTYPE_PRIMARY,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURES_DIR = join(import.meta.dir, "fixtures");

function loadFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), "utf-8");
}

function makeRegistry(): TypeRegistry {
  const r = new TypeRegistry();
  registerCoreTypes(r);
  return r;
}

// ---------------------------------------------------------------------------
// 1. Minimal root parses
// ---------------------------------------------------------------------------

describe("parseJson — minimal root", () => {
  it('{"metadata.root": {}} parses to a root MetaData node of type metadata.root', () => {
    const registry = makeRegistry();
    const { root, warnings } = parseJson('{"metadata.root": {}}', { registry });
    expect(root.type).toBe(TYPE_METADATA);
    expect(root.subType).toBe(SUBTYPE_ROOT);
    expect(root.name).toBe("");
    expect(warnings.length).toBe(0);
  });

  it('{"metadata.root": {"package": "demo"}} sets package on root', () => {
    const registry = makeRegistry();
    const { root } = parseJson('{"metadata.root": {"package": "demo"}}', { registry });
    expect(root.package).toBe("demo");
    expect(root.type).toBe(TYPE_METADATA);
  });

  it("root with name sets name on root model", () => {
    const registry = makeRegistry();
    const { root } = parseJson('{"metadata.root": {"name": "myRoot"}}', { registry });
    expect(root.name).toBe("myRoot");
  });

  it("$schema key at top level is ignored", () => {
    const registry = makeRegistry();
    const { root, warnings } = parseJson(
      '{"$schema": "simple-model.schema.json", "metadata.root": {"package": "demo"}}',
      { registry },
    );
    expect(root.type).toBe(TYPE_METADATA);
    expect(root.package).toBe("demo");
    expect(warnings.length).toBe(0);
  });

  it("root has no children when children array is absent", () => {
    const registry = makeRegistry();
    const { root } = parseJson('{"metadata.root": {"package": "demo"}}', { registry });
    expect(root.ownChildren().length).toBe(0);
  });

  it("returns empty warnings array for valid minimal input", () => {
    const registry = makeRegistry();
    const { warnings } = parseJson('{"metadata.root": {}}', { registry });
    expect(Array.isArray(warnings)).toBe(true);
    expect(warnings.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Single object child
// ---------------------------------------------------------------------------

describe("parseJson — single object child", () => {
  it("parses one object child with name and subType", () => {
    const registry = makeRegistry();
    const input = JSON.stringify({
      "metadata.root": {
        children: [{ "object.entity": { name: "Store" } }],
      },
    });
    const { root } = parseJson(input, { registry });
    expect(root.ownChildren().length).toBe(1);
    const child = root.ownChildren()[0]!;
    expect(child.type).toBe(TYPE_OBJECT);
    expect(child.subType).toBe(OBJECT_SUBTYPE_ENTITY);
    expect(child.name).toBe("Store");
  });

  it("parses a field child with subType long", () => {
    const registry = makeRegistry();
    const input = JSON.stringify({
      "metadata.root": {
        children: [{ "field.long": { name: "id" } }],
      },
    });
    const { root } = parseJson(input, { registry });
    const child = root.ownChildren()[0]!;
    expect(child.type).toBe(TYPE_FIELD);
    expect(child.subType).toBe(FIELD_SUBTYPE_LONG);
    expect(child.name).toBe("id");
  });

  it("parses multiple sibling children preserving insertion order", () => {
    const registry = makeRegistry();
    const input = JSON.stringify({
      "metadata.root": {
        children: [
          { "object.entity": { name: "Alpha" } },
          { "object.entity": { name: "Beta" } },
          { "field.string": { name: "gamma" } },
        ],
      },
    });
    const { root } = parseJson(input, { registry });
    const kids = root.ownChildren();
    expect(kids.length).toBe(3);
    expect(kids[0]!.name).toBe("Alpha");
    expect(kids[1]!.name).toBe("Beta");
    expect(kids[2]!.name).toBe("gamma");
  });

  it("defaults subType to first registered subType when the wrapper key omits it", () => {
    const registry = makeRegistry();
    // A bare "metadata" wrapper key (no fused .subType) resolves to the
    // registry default — metadata's only registered subType is "root".
    const { root } = parseJson('{"metadata": {}}', { registry });
    expect(root.subType).toBe(SUBTYPE_ROOT);
  });
});

// ---------------------------------------------------------------------------
// 3. Inline @-attrs
// ---------------------------------------------------------------------------

describe("parseJson — inline @-attrs", () => {
  it('@dbTable string attr is set correctly', () => {
    const registry = makeRegistry();
    const input = JSON.stringify({
      "metadata.root": {
        children: [{ "object.entity": { name: "X", "@dbTable": "x_table" } }],
      },
    });
    const { root } = parseJson(input, { registry });
    const child = root.ownChildren()[0]!;
    expect(child.ownAttr("dbTable")).toBe("x_table");
  });

  // Regression guard: @dbTable is a plain attr — must NOT auto-synthesize a source child.
  // Earlier docs described an auto-promotion from a @dbTable string attr — that was
  // aspirational and was never implemented.  This test ensures it stays that way.
  it('@dbTable attr does NOT synthesize a source[dbTable] child', () => {
    const registry = makeRegistry();
    const input = JSON.stringify({
      "metadata.root": {
        children: [
          { "object.entity": { name: "Program", "@dbTable": "programs",
            children: [
              { "field.long": { name: "id" } },
              { "identity.primary": { "name": "id", "@fields": "id" } },
            ],
          }},
        ],
      },
    });
    const { root } = parseJson(input, { registry });
    const program = root.ownChildren().find((o) => o.name === "Program");
    const sources = program?.ownChildren().filter((c) => c.type === TYPE_SOURCE) ?? [];
    expect(sources.length).toBe(0); // NO source[dbTable] synthesized
  });

  it("@maxLength integer attr is coerced to a number", () => {
    const registry = makeRegistry();
    const input = JSON.stringify({
      "metadata.root": {
        children: [{ "field.string": { name: "title", "@maxLength": 100 } }],
      },
    });
    const { root } = parseJson(input, { registry });
    const child = root.ownChildren()[0]!;
    expect(child.ownAttr("maxLength")).toBe(100);
  });

  it("abstract reserved key (true) sets isAbstract to true and is not in attrs", () => {
    const registry = makeRegistry();
    const input = JSON.stringify({
      "metadata.root": {
        children: [{ "object.entity": { name: "Base", abstract: true } }],
      },
    });
    const { root } = parseJson(input, { registry });
    const child = root.ownChildren()[0]!;
    expect(child.isAbstract).toBe(true);
    // `abstract` is a reserved structural key — the parser routes it to
    // setIsAbstract(), never setAttr(). The attr map must not contain it.
    expect(child.ownHasAttr("abstract")).toBe(false);
  });

  it("multiple @-attrs of various types all coerced correctly", () => {
    const registry = makeRegistry();
    const input = JSON.stringify({
      "metadata.root": {
        children: [
          {
            "object.entity": {
              name: "X",
              "@stringAttr": "hello",
              "@intAttr": 42,
              "@boolAttr": true,
              "@longAttr": 3000000000,
            },
          },
        ],
      },
    });
    const { root } = parseJson(input, { registry });
    const child = root.ownChildren()[0]!;
    expect(child.ownAttr("stringAttr")).toBe("hello");
    expect(child.ownAttr("intAttr")).toBe(42);
    expect(child.ownAttr("boolAttr")).toBe(true);
    expect(child.ownAttr("longAttr")).toBe(3000000000);
  });

  it("@objectRef string attr set on field", () => {
    const registry = makeRegistry();
    const input = JSON.stringify({
      "metadata.root": {
        children: [
          { "field.object": { name: "apples", "@objectRef": "::Apple" } },
        ],
      },
    });
    const { root } = parseJson(input, { registry });
    const child = root.ownChildren()[0]!;
    expect(child.ownAttr("objectRef")).toBe("::Apple");
  });

  it("@object attr (class ref string) is stored as-is", () => {
    const registry = makeRegistry();
    const input = JSON.stringify({
      "metadata.root": {
        children: [
          {
            "object.entity": {
              name: "Store",
              "@object": "com.example.Store",
            },
          },
        ],
      },
    });
    const { root } = parseJson(input, { registry });
    const child = root.ownChildren()[0]!;
    expect(child.ownAttr("object")).toBe("com.example.Store");
  });
});

// ---------------------------------------------------------------------------
// 4. @isArray special handling
// ---------------------------------------------------------------------------

describe("parseJson — isArray reserved key handling", () => {
  it("isArray: true reserved key sets field.isArray to true", () => {
    const registry = makeRegistry();
    const input = JSON.stringify({
      "metadata.root": {
        children: [
          { "field.string": { name: "tags", isArray: true } },
        ],
      },
    });
    const { root } = parseJson(input, { registry });
    const field = root.ownChildren()[0]!;
    expect(field.isArray).toBe(true);
  });

  it("isArray: true reserved key does NOT appear in the attr map", () => {
    const registry = makeRegistry();
    const input = JSON.stringify({
      "metadata.root": {
        children: [
          { "field.string": { name: "tags", isArray: true } },
        ],
      },
    });
    const { root } = parseJson(input, { registry });
    const field = root.ownChildren()[0]!;
    expect(field.ownHasAttr("isArray")).toBe(false);
  });

  it("isArray: false reserved key sets field.isArray to false", () => {
    const registry = makeRegistry();
    const input = JSON.stringify({
      "metadata.root": {
        children: [
          { "field.string": { name: "tags", isArray: false } },
        ],
      },
    });
    const { root } = parseJson(input, { registry });
    const field = root.ownChildren()[0]!;
    expect(field.isArray).toBe(false);
  });

  it("field without isArray key has isArray false by default", () => {
    const registry = makeRegistry();
    const input = JSON.stringify({
      "metadata.root": {
        children: [{ "field.string": { name: "name" } }],
      },
    });
    const { root } = parseJson(input, { registry });
    const field = root.ownChildren()[0]!;
    expect(field.isArray).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Reserved keys handled correctly
// ---------------------------------------------------------------------------

describe("parseJson — reserved keys", () => {
  it("subType sets typeId.subType, not an attr", () => {
    const registry = makeRegistry();
    const input = JSON.stringify({
      "metadata.root": {
        children: [{ "object.entity": { name: "X" } }],
      },
    });
    const { root } = parseJson(input, { registry });
    const child = root.ownChildren()[0]!;
    expect(child.subType).toBe(OBJECT_SUBTYPE_ENTITY);
    expect(child.ownHasAttr("subType")).toBe(false);
  });

  it("name sets model.name, not an attr", () => {
    const registry = makeRegistry();
    const input = JSON.stringify({
      "metadata.root": {
        children: [{ "field.string": { name: "myField" } }],
      },
    });
    const { root } = parseJson(input, { registry });
    const child = root.ownChildren()[0]!;
    expect(child.name).toBe("myField");
    expect(child.ownHasAttr("name")).toBe(false);
  });

  it("package sets model.package, not an attr", () => {
    const registry = makeRegistry();
    const input = JSON.stringify({
      "metadata.root": {
        children: [{ "field.long": { name: "id", package: "demo::common" } }],
      },
    });
    const { root } = parseJson(input, { registry });
    const child = root.ownChildren()[0]!;
    expect(child.package).toBe("demo::common");
    expect(child.ownHasAttr("package")).toBe(false);
  });

  it("super sets model.superRef and is resolved immediately if target exists in tree", () => {
    const registry = makeRegistry();
    // To have a resolvable super, we need the target to exist in the same parse.
    // field "base" is defined first, then "derived" extends it.
    const input = JSON.stringify({
      "metadata.root": {
        children: [
          { "field.string": { name: "base" } },
          { "field.string": { name: "derived", extends: "base" } },
        ],
      },
    });
    const { root } = parseJson(input, { registry });
    const derived = root.ownChildByTypeAndName("field", "derived")!;
    expect(derived.superRef).toBe("base");
    expect(derived.superResolved).toBeDefined(); // IS resolved by parser immediately
    expect(derived.superResolved!.name).toBe("base");
    expect(derived.ownHasAttr("super")).toBe(false);
  });

  it("super with unresolvable ref throws ParseError (Java: missing super = hard error)", () => {
    const registry = makeRegistry();
    const input = JSON.stringify({
      "metadata.root": {
        children: [{ "field.string": { name: "id", extends: "..::common::id" } }],
      },
    });
    // No common::id in the tree — parser throws immediately
    expect(() => parseJson(input, { registry })).toThrow(ParseError);
  });

  it("abstract reserved key sets model.isAbstract flag", () => {
    const registry = makeRegistry();
    // Note: abstract as a plain reserved key (not @-prefixed)
    const input = JSON.stringify({
      "metadata.root": {
        children: [{ "object.entity": { name: "Base", abstract: true } }],
      },
    });
    const { root } = parseJson(input, { registry });
    const child = root.ownChildren()[0]!;
    expect(child.isAbstract).toBe(true);
    expect(child.ownHasAttr("abstract")).toBe(false);
  });

  it("overlay: true at the root is ignored — no error, no warning", () => {
    const registry = makeRegistry();
    const input = JSON.stringify({ "metadata.root": { overlay: true } });
    const { root, warnings } = parseJson(input, { registry });
    expect(root.type).toBe(TYPE_METADATA);
    expect(warnings.length).toBe(0);
    expect(root.isMerge).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Child {"attr": {...}} nodes — materialized into MetaAttr instances
// ---------------------------------------------------------------------------

describe("parseJson — attr child nodes (materialized instances)", () => {
  it("attr child materializes a MetaAttr instance (not a structural child)", () => {
    const registry = makeRegistry();
    const input = JSON.stringify({
      "metadata.root": {
        children: [
          {
            "object.entity": {
              name: "Store",
              children: [
                { "attr.boolean": { name: "isKey", value: true } },
              ],
            },
          },
        ],
      },
    });
    const { root } = parseJson(input, { registry });
    const obj = root.ownChildren()[0]!;
    // Attrs are no longer structural children — they live on the instance map.
    expect(obj.ownChildrenOfType("attr").length).toBe(0);
    const inst = obj.ownMetaAttr("isKey");
    expect(inst).toBeDefined();
    expect(inst!.name).toBe("isKey");
    expect(inst!.type).toBe(TYPE_ATTR);
  });

  it("attr child's value is also set on the parent via setAttr", () => {
    const registry = makeRegistry();
    const input = JSON.stringify({
      "metadata.root": {
        children: [
          {
            "object.entity": {
              name: "Store",
              children: [
                { "attr.boolean": { name: "isKey", value: true } },
              ],
            },
          },
        ],
      },
    });
    const { root } = parseJson(input, { registry });
    const obj = root.ownChildren()[0]!;
    // Parent can access attr("isKey") directly
    expect(obj.ownAttr("isKey")).toBe(true);
  });

  it("attr child instance has subType matching declared subType", () => {
    const registry = makeRegistry();
    const input = JSON.stringify({
      "field.long": {
        name: "id",
        children: [
          { "attr.boolean": { name: "isKey", value: true } },
        ],
      },
    });
    const { root } = parseJson(input, { registry });
    const attrInst = root.ownMetaAttr("isKey")!;
    expect(attrInst.subType).toBe(ATTR_SUBTYPE_BOOLEAN);
  });

  it("attr child instance stores the desugared value", () => {
    const registry = makeRegistry();
    const input = JSON.stringify({
      "field.long": {
        name: "id",
        children: [
          { "attr.boolean": { name: "isKey", value: true } },
        ],
      },
    });
    const { root } = parseJson(input, { registry });
    const attrInst = root.ownMetaAttr("isKey")!;
    // The instance itself holds the value.
    expect(attrInst.value).toBe(true);
  });

  it("multiple attr children are all stored correctly", () => {
    const registry = makeRegistry();
    const input = JSON.stringify({
      "field.long": {
        name: "id",
        children: [
          { "attr.boolean": { name: "isKey", value: true } },
          { "attr.long": { name: "maxValue", value: 9999 } },
        ],
      },
    });
    const { root } = parseJson(input, { registry });
    expect(root.ownAttr("isKey")).toBe(true);
    expect(root.ownAttr("maxValue")).toBe(9999);
    expect(root.ownMetaAttrs().length).toBe(2);
  });

  it("integer attr child value is coerced to number on parent", () => {
    const registry = makeRegistry();
    const input = JSON.stringify({
      "object.entity": {
        name: "Store",
        children: [
          { "attr.int": { name: "sortOrder", value: 42 } },
        ],
      },
    });
    const { root } = parseJson(input, { registry });
    expect(root.ownAttr("sortOrder")).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// 7. Unknown key (non-strict)
// ---------------------------------------------------------------------------

describe("parseJson — unknown key, non-strict mode", () => {
  it("unknown non-@-prefixed key emits a warning and parsing continues", () => {
    const registry = makeRegistry();
    const input = JSON.stringify({
      "metadata.root": {
        children: [{ "object.entity": { name: "X", weirdKey: "x" } }],
      },
    });
    const { root, warnings } = parseJson(input, { registry });
    expect(root.ownChildren().length).toBe(1);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("weirdKey");
  });

  it("unknown key warning message references the key name", () => {
    const registry = makeRegistry();
    const input = JSON.stringify({
      "metadata.root": {
        children: [{ "object.entity": { name: "X", dbColumn: "x_col" } }],
      },
    });
    const { warnings } = parseJson(input, { registry });
    expect(warnings.some((w) => w.includes("dbColumn"))).toBe(true);
  });

  it("model remains unaffected by unknown key (no attr set)", () => {
    const registry = makeRegistry();
    const input = JSON.stringify({
      "metadata.root": {
        children: [{ "object.entity": { name: "X", weirdKey: "x" } }],
      },
    });
    const { root } = parseJson(input, { registry });
    const child = root.ownChildren()[0]!;
    expect(child.ownHasAttr("weirdKey")).toBe(false);
    expect(child.name).toBe("X");
  });

  it("multiple unknown keys all emit warnings", () => {
    const registry = makeRegistry();
    const input = JSON.stringify({
      "metadata.root": {
        children: [{ "object.entity": { name: "X", key1: "a", key2: "b" } }],
      },
    });
    const { warnings } = parseJson(input, { registry });
    expect(warnings.some((w) => w.includes("key1"))).toBe(true);
    expect(warnings.some((w) => w.includes("key2"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. Unknown key (strict mode)
// ---------------------------------------------------------------------------

describe("parseJson — unknown key, strict mode", () => {
  it("unknown non-@-prefixed key in strict mode throws ParseError", () => {
    const registry = makeRegistry();
    const input = JSON.stringify({
      "metadata.root": {
        children: [{ "object.entity": { name: "X", weirdKey: "x" } }],
      },
    });
    expect(() => parseJson(input, { registry, strict: true })).toThrow(ParseError);
  });

  it("ParseError from unknown key contains the key name in message", () => {
    const registry = makeRegistry();
    const input = JSON.stringify({
      "metadata.root": {
        children: [{ "object.entity": { name: "X", dbColumn: "col" } }],
      },
    });
    let caught: unknown;
    try {
      parseJson(input, { registry, strict: true });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ParseError);
    expect((caught as ParseError).message).toContain("dbColumn");
  });
});

// ---------------------------------------------------------------------------
// 9. Missing @-prefix on what looks like an attribute
// ---------------------------------------------------------------------------

describe("parseJson — missing @-prefix on attribute-like key", () => {
  it("non-reserved non-@-prefixed key in strict mode throws ParseError", () => {
    const registry = makeRegistry();
    const input = JSON.stringify({
      "metadata.root": {
        children: [{ "field.string": { name: "x", dbColumn: "y" } }],
      },
    });
    expect(() => parseJson(input, { registry, strict: true })).toThrow(ParseError);
  });

  it("non-reserved non-@-prefixed key in non-strict mode emits a warning", () => {
    const registry = makeRegistry();
    const input = JSON.stringify({
      "metadata.root": {
        children: [{ "field.string": { name: "x", dbColumn: "y" } }],
      },
    });
    const { warnings } = parseJson(input, { registry });
    expect(warnings.some((w) => w.includes("dbColumn"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. Unknown type in registry
// ---------------------------------------------------------------------------

describe("parseJson — unknown child type", () => {
  it("unknown child type collects a ParseError in errors[]", () => {
    const registry = makeRegistry();
    const input = JSON.stringify({
      "metadata.root": {
        children: [{ frobnicate: { name: "x" } }],
      },
    });
    // Unknown CHILD type is collected as an error (parity with unknown subtype),
    // not thrown — strict mode escalates problems but unknown types are always errors.
    const { errors } = parseJson(input, { registry, strict: true });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toBeInstanceOf(ParseError);
  });

  it("unknown child type collects an error and skips the child", () => {
    const registry = makeRegistry();
    const input = JSON.stringify({
      "metadata.root": {
        children: [{ frobnicate: { name: "x" } }],
      },
    });
    const { root, errors } = parseJson(input, { registry });
    expect(root.ownChildren().length).toBe(0); // child was skipped
    expect(errors.some((e) => e.message.includes("frobnicate"))).toBe(true);
  });

  it("unknown root type throws ParseError", () => {
    const registry = makeRegistry();
    const input = JSON.stringify({ unknownRoot: { name: "x" } });
    // The root type "unknownRoot" is not registered — should throw
    expect(() => parseJson(input, { registry })).toThrow(ParseError);
  });

  it("siblings after unknown child type are still parsed (non-strict)", () => {
    const registry = makeRegistry();
    const input = JSON.stringify({
      "metadata.root": {
        children: [
          { frobnicate: { name: "x" } },
          { "object.entity": { name: "Store" } },
        ],
      },
    });
    const { root, errors } = parseJson(input, { registry });
    // The unknown child is skipped; "Store" is still parsed
    expect(root.ownChildren().length).toBe(1);
    expect(root.ownChildren()[0]!.name).toBe("Store");
    expect(errors.some((e) => e.message.includes("frobnicate"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10b. Unknown subtype — escalated to error (not warning)
// ---------------------------------------------------------------------------

describe("parseJson — unknown subtype is an error", () => {
  it("parser collects error when subtype is unknown (relationship.oneToMany)", () => {
    const registry = makeRegistry();
    const json = JSON.stringify({
      "metadata.root": {
        package: "acme",
        children: [{
          "relationship.oneToMany": {
            name: "weeks",     // unregistered — only association/aggregation/composition exist
            "@objectRef": "Week",
          },
        }],
      },
    });
    const result = parseJson(json, { registry, strict: false });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.message.includes(`Unknown type "relationship.oneToMany"`))).toBe(true);
  });

  it("empty model is still returned for the bad node so parsing continues", () => {
    const registry = makeRegistry();
    const json = JSON.stringify({
      "metadata.root": {
        package: "acme",
        children: [
          {
            "relationship.oneToMany": {
              name: "weeks",
              "@objectRef": "Week",
            },
          },
          { "object.entity": { name: "Week" } },
        ],
      },
    });
    const result = parseJson(json, { registry, strict: false });
    // Bad node emits an error but sibling (Week) is still parsed
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.root.ownChildByTypeAndName("object", "Week")).toBeDefined();
  });

  it("unknown subtype does NOT appear in warnings — it is an error", () => {
    const registry = makeRegistry();
    const json = JSON.stringify({
      "metadata.root": {
        children: [{
          "relationship.oneToMany": { name: "r" },
        }],
      },
    });
    const result = parseJson(json, { registry, strict: false });
    expect(result.warnings.some((w) => w.includes("oneToMany"))).toBe(false);
    expect(result.errors.some((e) => e.message.includes("oneToMany"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 11. Invalid JSON syntax
// ---------------------------------------------------------------------------

describe("parseJson — invalid JSON", () => {
  it("invalid JSON syntax throws ParseError", () => {
    const registry = makeRegistry();
    expect(() => parseJson("{invalid", { registry })).toThrow(ParseError);
  });

  it("ParseError from invalid JSON has a message containing the parse error", () => {
    const registry = makeRegistry();
    let caught: unknown;
    try {
      parseJson("{bad json}", { registry });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ParseError);
    expect((caught as ParseError).message).toContain("Invalid JSON");
  });

  it("top-level array throws ParseError", () => {
    const registry = makeRegistry();
    expect(() => parseJson("[]", { registry })).toThrow(ParseError);
  });

  it("top-level string throws ParseError", () => {
    const registry = makeRegistry();
    expect(() => parseJson('"hello"', { registry })).toThrow(ParseError);
  });

  it("empty string throws ParseError", () => {
    const registry = makeRegistry();
    expect(() => parseJson("", { registry })).toThrow(ParseError);
  });
});

// ---------------------------------------------------------------------------
// 12. Round-trip with fruitbasket fixture
// ---------------------------------------------------------------------------

describe("parseJson — fruitbasket fixture round-trip", () => {
  let registry: TypeRegistry;
  let result: ReturnType<typeof parseJson>;

  beforeEach(() => {
    registry = makeRegistry();
    const content = loadFixture("fruitbasket-metadata.json");
    result = parseJson(content, { registry });
  });

  it("parses without throwing", () => {
    // Verified by beforeEach not throwing
    expect(result.root).toBeDefined();
  });

  it("root is metadata.root", () => {
    expect(result.root.type).toBe(TYPE_METADATA);
    expect(result.root.subType).toBe(SUBTYPE_ROOT);
  });

  it("root package is simple::fruitbasket", () => {
    expect(result.root.package).toBe("simple::fruitbasket");
  });

  it("root has 7 direct children (2 common fields + 5 objects)", () => {
    // fruitbasket has: id field, name field, Basket, Fruit, Apple, Macintosh, Orange
    expect(result.root.ownChildren().length).toBe(7);
  });

  it("first child is a field named 'id' with subType long", () => {
    const idField = result.root.ownChildren()[0]!;
    expect(idField.type).toBe(TYPE_FIELD);
    expect(idField.subType).toBe(FIELD_SUBTYPE_LONG);
    expect(idField.name).toBe("id");
  });

  it("id field has package simple::common", () => {
    const idField = result.root.ownChildren()[0]!;
    expect(idField.package).toBe("simple::common");
  });

  it("id field has the abstract flag set", () => {
    const idField = result.root.ownChildren()[0]!;
    // 'abstract' is a reserved structural key — routes to setIsAbstract()
    expect(idField.isAbstract).toBe(true);
  });

  it("id field has an 'isKey' attr child that sets parent.ownAttr('isKey') = true", () => {
    const idField = result.root.ownChildren()[0]!;
    // attr child materializes into a MetaAttr instance on the field.
    expect(idField.ownAttr("isKey")).toBe(true);
    const inst = idField.ownMetaAttr("isKey");
    expect(inst).toBeDefined();
    expect(inst!.name).toBe("isKey");
  });

  it("Basket object has subType entity", () => {
    const basket = result.root.ownChildByTypeAndName("object", "Basket");
    expect(basket).toBeDefined();
    expect(basket!.subType).toBe(OBJECT_SUBTYPE_ENTITY);
  });

  it("Basket object has @object attr", () => {
    const basket = result.root.ownChildByTypeAndName("object", "Basket");
    expect(basket!.ownAttr("object")).toBe("com.metaobjects.loader.simple.fruitbasket.Basket");
  });

  it("Basket has 6 field children", () => {
    const basket = result.root.ownChildByTypeAndName("object", "Basket");
    expect(basket!.ownChildrenOfType("field").length).toBe(6);
  });

  it("Basket.apples field has isArray=true", () => {
    const basket = result.root.ownChildByTypeAndName("object", "Basket");
    const apples = basket!.ownChildByTypeAndName("field", "apples");
    expect(apples).toBeDefined();
    expect(apples!.isArray).toBe(true);
  });

  it("Basket.apples field has @objectRef attr", () => {
    const basket = result.root.ownChildByTypeAndName("object", "Basket");
    const apples = basket!.ownChildByTypeAndName("field", "apples");
    expect(apples!.ownAttr("objectRef")).toBe("simple::fruitbasket::Apple"); // FR-032: canonical refs are FQN
  });

  it("Apple object has super set to 'Fruit' and is immediately resolved", () => {
    const apple = result.root.ownChildByTypeAndName("object", "Apple");
    expect(apple).toBeDefined();
    expect(apple!.superRef).toBe("Fruit");
    // Fruit is defined before Apple in the file → resolved immediately during parse
    expect(apple!.superResolved).toBeDefined();
    expect(apple!.superResolved!.name).toBe("Fruit");
  });

  it("Fruit object has isAbstract=true", () => {
    const fruit = result.root.ownChildByTypeAndName("object", "Fruit");
    expect(fruit).toBeDefined();
    expect(fruit!.isAbstract).toBe(true);
  });

  it("name field has validator children (required + length)", () => {
    const nameField = result.root.ownChildren()[1]!; // second top-level child
    expect(nameField.name).toBe("name");
    const validators = nameField.ownChildrenOfType("validator");
    expect(validators.length).toBe(2);
  });

  it("length validator on name field has @min and @max attrs", () => {
    const nameField = result.root.ownChildren()[1]!;
    const lengthValidator = nameField.ownChildrenOfSubType("validator", "length")[0]!;
    expect(lengthValidator.ownAttr("min")).toBe(1);
    expect(lengthValidator.ownAttr("max")).toBe(50);
  });

  it("produces no warnings for valid fixture", () => {
    expect(result.warnings.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 13. Errors include source envelope (FR5a / ADR-0009)
// ---------------------------------------------------------------------------

describe("parseJson — ParseError source envelope (FR5a)", () => {
  it("source.files[0] matches the sourceName option (malformed JSON)", () => {
    const registry = makeRegistry();
    let caught: unknown;
    try {
      parseJson("{bad json}", { registry, sourceName: "test.json" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ParseError);
    const pe = caught as ParseError;
    expect(pe.source.format).toBe("json");
    if (pe.source.format === "json") expect(pe.source.files).toEqual(["test.json"]);
  });

  it("ParseError from unknown root type carries the source envelope", () => {
    const registry = makeRegistry();
    let caught: unknown;
    try {
      parseJson('{"unknownRoot": {}}', { registry, sourceName: "fishstore.json" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ParseError);
    const pe = caught as ParseError;
    expect(pe.source.format).toBe("json");
    if (pe.source.format === "json") expect(pe.source.files).toEqual(["fishstore.json"]);
  });

  it("ParseError from strict unknown key includes a jsonPath", () => {
    const registry = makeRegistry();
    const input = JSON.stringify({
      "metadata.root": {
        children: [{ "object.entity": { name: "X", weirdKey: "x" } }],
      },
    });
    let caught: unknown;
    try {
      parseJson(input, { registry, strict: true, sourceName: "test.json" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ParseError);
    const pe = caught as ParseError;
    expect(pe.source.format).toBe("json");
    if (pe.source.format === "json") {
      expect(pe.source.files).toEqual(["test.json"]);
      expect(pe.source.jsonPath.length).toBeGreaterThan(0);
    }
  });

  it("ParseError from an unknown child type carries a jsonPath with the children index", () => {
    const registry = makeRegistry();
    const input = JSON.stringify({
      "metadata.root": {
        children: [
          { "object.entity": { name: "X" } },
          { "object.entity": { name: "Y" } },
          { frobnicate: { name: "z" } },
        ],
      },
    });
    // Unknown child type is collected in errors[] (not thrown).
    const { errors } = parseJson(input, { registry, strict: true, sourceName: "test.json" });
    expect(errors.length).toBeGreaterThan(0);
    const pe = errors[0]!;
    expect(pe).toBeInstanceOf(ParseError);
    expect(pe.source.format).toBe("json");
    if (pe.source.format === "json") {
      // jsonPath should reference the third child (index 2)
      expect(pe.source.jsonPath).toContain("[2]");
    }
  });

  it("ParseError name is 'ParseError'", () => {
    const registry = makeRegistry();
    let caught: unknown;
    try {
      parseJson("{bad}", { registry });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ParseError);
    expect((caught as ParseError).name).toBe("ParseError");
  });

  it("sourceName undefined falls back to '<unknown>' in the envelope files[]", () => {
    const registry = makeRegistry();
    let caught: unknown;
    try {
      parseJson("{bad}", { registry });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ParseError);
    const pe = caught as ParseError;
    expect(pe.source.format).toBe("json");
    if (pe.source.format === "json") expect(pe.source.files).toEqual(["<unknown>"]);
  });
});

// ---------------------------------------------------------------------------
// Additional: deeply nested children
// ---------------------------------------------------------------------------

describe("parseJson — deeply nested children", () => {
  it("parses object > field > validator nesting", () => {
    const registry = makeRegistry();
    const input = JSON.stringify({
      "metadata.root": {
        children: [
          {
            "object.entity": {
              name: "Store",
              children: [
                {
                  "field.string": {
                    name: "name",
                    children: [
                      { "validator.required": { name: "required" } },
                      {
                        "validator.length": {
                          name: "length",
                          "@min": 1,
                          "@max": 50,
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    });
    const { root } = parseJson(input, { registry });
    const obj = root.ownChildren()[0]!;
    const field = obj.ownChildrenOfType("field")[0]!;
    expect(field.name).toBe("name");
    const validators = field.ownChildrenOfType("validator");
    expect(validators.length).toBe(2);
    const lengthV = field.ownChildrenOfSubType("validator", "length")[0]!;
    expect(lengthV.ownAttr("min")).toBe(1);
    expect(lengthV.ownAttr("max")).toBe(50);
  });

  it("identity child with @-attrs parses correctly", () => {
    const registry = makeRegistry();
    const input = JSON.stringify({
      "metadata.root": {
        children: [
          {
            "object.entity": {
              name: "Store",
              children: [
                {
                  "identity.primary": {
                    name: "primary",
                    "@fields": ["id"],
                    "@generation": "increment",
                  },
                },
              ],
            },
          },
        ],
      },
    });
    const { root } = parseJson(input, { registry });
    const obj = root.ownChildren()[0]!;
    const identity = obj.ownChildrenOfType("identity")[0]!;
    expect(identity.name).toBe("primary");
    expect(identity.subType).toBe(IDENTITY_SUBTYPE_PRIMARY);
    expect(identity.ownAttr("generation")).toBe("increment");
    // @fields is an array
    expect(Array.isArray(identity.ownAttr("fields"))).toBe(true);
  });

  it("declared array attr desugars consistently: parent map and MetaAttr node both carry the array", () => {
    // Regression test for the dual-storage bug: when @fields (a declared array
    // attr — `string` + isArray, the retired `stringarray` subtype) is authored
    // as a bare string, both the parent identity's attr map AND the materialized
    // MetaAttr node's value must carry the desugared ["id"] array — not a mix of
    // array + bare string. The `attr.stringarray` child-node WRAPPER form is
    // retired; the canonical authoring is the inline declared-attr form.
    const registry = makeRegistry();
    const input = JSON.stringify({
      "metadata.root": {
        children: [
          {
            "object.entity": {
              name: "Store",
              children: [
                {
                  "identity.primary": {
                    name: "primary",
                    // Inline declared-attr form: bare string "id" for the
                    // array-flagged @fields attr (coerces to ["id"]).
                    "@fields": "id",
                  },
                },
              ],
            },
          },
        ],
      },
    });
    const { root } = parseJson(input, { registry });
    const obj = root.ownChildren()[0]!;
    const identity = obj.ownChildrenOfType(TYPE_IDENTITY)[0]!;

    // Parent attr map must carry the desugared array.
    const parentValue = identity.ownAttr("fields");
    expect(Array.isArray(parentValue)).toBe(true);
    expect(parentValue).toEqual(["id"]);

    // The materialized MetaAttr instance carries the same desugared array.
    const attrInst = identity.ownMetaAttr("fields");
    expect(attrInst).toBeDefined();
    expect(Array.isArray(attrInst!.value)).toBe(true);
    expect(attrInst!.value).toEqual(["id"]);
  });

  it("stringArray attr with numeric-looking string value is NOT coerced to number — yields ['123']", () => {
    // Regression test for Fix 2: a declared stringArray attr like @fields whose
    // authored value is "123" must end up as ["123"], not the number 123.
    // Previously coerceAttrValue ran first and turned "123" → 123 (int), then
    // normalizeStringArrayAttr's `typeof value !== "string"` guard skipped it,
    // leaving the attr as the number 123 — a type mismatch caught (wrongly) by A3.
    const registry = makeRegistry();
    const input = JSON.stringify({
      "metadata.root": {
        children: [
          {
            "object.entity": {
              name: "Widget",
              children: [
                {
                  "identity.primary": {
                    name: "primary",
                    "@fields": "123",
                  },
                },
              ],
            },
          },
        ],
      },
    });
    const { root, errors } = parseJson(input, { registry });
    const obj = root.ownChildren()[0]!;
    const identity = obj.ownChildrenOfType(TYPE_IDENTITY)[0]!;
    const fieldsValue = identity.ownAttr("fields");
    // Must be an array of strings, not a number.
    expect(Array.isArray(fieldsValue)).toBe(true);
    expect(fieldsValue).toEqual(["123"]);
    // Must produce no A3 validation errors.
    expect(errors).toHaveLength(0);
  });

  it("stringArray attr with boolean-looking string value is NOT coerced to boolean — yields ['true']", () => {
    // Similar regression: @fields: "true" must yield ["true"], not boolean true.
    const registry = makeRegistry();
    const input = JSON.stringify({
      "metadata.root": {
        children: [
          {
            "object.entity": {
              name: "Widget",
              children: [
                {
                  "identity.primary": {
                    name: "primary",
                    "@fields": "true",
                  },
                },
              ],
            },
          },
        ],
      },
    });
    const { root, errors } = parseJson(input, { registry });
    const obj = root.ownChildren()[0]!;
    const identity = obj.ownChildrenOfType(TYPE_IDENTITY)[0]!;
    const fieldsValue = identity.ownAttr("fields");
    expect(Array.isArray(fieldsValue)).toBe(true);
    expect(fieldsValue).toEqual(["true"]);
    expect(errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Per-node overlay: true semantics
// ---------------------------------------------------------------------------

describe("parseJson — per-node overlay: true", () => {
  it("merges attrs into the existing same-(type,name) child", () => {
    const registry = makeRegistry();
    const baseJson = JSON.stringify({
      "metadata.root": {
        children: [{ "object.entity": { name: "Store", "@dbTable": "t" } }],
      },
    });
    const overlayJson = JSON.stringify({
      "metadata.root": {
        children: [{ "object.entity": { name: "Store", overlay: true, "@dbTable": "t2" } }],
      },
    });
    const { root: base } = parseJson(baseJson, { registry });
    const { root, warnings } = parseJson(overlayJson, { registry, intoRoot: base });
    const store = root.ownChildByTypeAndName("object", "Store")!;
    expect(store).toBeDefined();
    expect(store.ownAttr("dbTable")).toBe("t2");
    expect(root.ownChildren().filter((c) => c.name === "Store").length).toBe(1);
    expect(warnings.length).toBe(0);
  });

  it("sets isMerge on the existing child", () => {
    const registry = makeRegistry();
    const baseJson = JSON.stringify({
      "metadata.root": {
        children: [{ "object.entity": { name: "Store" } }],
      },
    });
    const overlayJson = JSON.stringify({
      "metadata.root": {
        children: [{ "object.entity": { name: "Store", overlay: true } }],
      },
    });
    const { root: base } = parseJson(baseJson, { registry });
    const { root } = parseJson(overlayJson, { registry, intoRoot: base });
    const store = root.ownChildByTypeAndName("object", "Store")!;
    expect(store.isMerge).toBe(true);
  });

  it("throws ParseError when no existing same-(type,name) child is found", () => {
    const registry = makeRegistry();
    const baseJson = JSON.stringify({
      "metadata.root": {
        children: [{ "object.entity": { name: "Alpha" } }],
      },
    });
    const overlayJson = JSON.stringify({
      "metadata.root": {
        children: [{ "object.entity": { name: "Missing", overlay: true } }],
      },
    });
    const { root: base } = parseJson(baseJson, { registry });
    expect(() => parseJson(overlayJson, { registry, intoRoot: base })).toThrow(ParseError);
  });
});

describe("parseJson — default (no flag) merge semantics (Java default behavior)", () => {
  it("same-named existing child is silently reused (no error, no warning)", () => {
    const registry = makeRegistry();
    const baseJson = JSON.stringify({
      "metadata.root": {
        children: [{ "object.entity": { name: "Store", "@dbTable": "t_old" } }],
      },
    });
    const secondJson = JSON.stringify({
      "metadata.root": {
        children: [{ "object.entity": { name: "Store", "@dbTable": "t_new" } }],
      },
    });
    const { root: base } = parseJson(baseJson, { registry });
    const { root, warnings } = parseJson(secondJson, { registry, intoRoot: base });
    // Silently merged — only one Store, attr updated
    expect(root.ownChildren().filter((c) => c.name === "Store").length).toBe(1);
    expect(root.ownChildByTypeAndName("object", "Store")!.ownAttr("dbTable")).toBe("t_new");
    expect(warnings.length).toBe(0);
  });

  it("new child (no existing match) → created and added", () => {
    const registry = makeRegistry();
    const baseJson = JSON.stringify({
      "metadata.root": {
        children: [{ "object.entity": { name: "Alpha" } }],
      },
    });
    const secondJson = JSON.stringify({
      "metadata.root": {
        children: [{ "object.entity": { name: "Beta" } }],
      },
    });
    const { root: base } = parseJson(baseJson, { registry });
    const { root, warnings } = parseJson(secondJson, { registry, intoRoot: base });
    expect(root.ownChildByTypeAndName("object", "Alpha")).toBeDefined();
    expect(root.ownChildByTypeAndName("object", "Beta")).toBeDefined();
    expect(warnings.length).toBe(0);
  });
});

describe("parseJson — intoRoot (accumulating root) parameter", () => {
  it("intoRoot returns the same root instance", () => {
    const registry = makeRegistry();
    const { root: base } = parseJson('{"metadata.root": {"package": "demo"}}', { registry });
    const { root: result } = parseJson(
      '{"metadata.root": {"children": [{"object.entity": {"name": "A"}}]}}',
      { registry, intoRoot: base },
    );
    // Same object reference
    expect(result).toBe(base);
  });

  it("intoRoot: new children from second parse are added to existing root", () => {
    const registry = makeRegistry();
    const { root: base } = parseJson(
      '{"metadata.root": {"children": [{"object.entity": {"name": "A"}}]}}',
      { registry },
    );
    parseJson(
      '{"metadata.root": {"children": [{"object.entity": {"name": "B"}}]}}',
      { registry, intoRoot: base },
    );
    expect(base.ownChildByTypeAndName("object", "A")).toBeDefined();
    expect(base.ownChildByTypeAndName("object", "B")).toBeDefined();
  });

  it("immediate super resolution resolves against accumulating intoRoot", () => {
    const registry = makeRegistry();
    // Parse base file with abstract Vehicle
    const { root: base } = parseJson(
      JSON.stringify({
        "metadata.root": {
          package: "demo",
          children: [{ "object.entity": { name: "Vehicle", abstract: true } }],
        },
      }),
      { registry },
    );
    // Parse second file with Car extending Vehicle — Vehicle is already in root
    const { root, warnings } = parseJson(
      JSON.stringify({
        "metadata.root": {
          package: "demo",
          children: [{ "object.entity": { name: "Car", extends: "Vehicle" } }],
        },
      }),
      { registry, intoRoot: base },
    );
    const car = root.ownChildByTypeAndName("object", "Car")!;
    expect(car).toBeDefined();
    expect(car.superResolved).toBeDefined();
    expect(car.superResolved!.name).toBe("Vehicle");
    expect(warnings.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: acme-vehicle base + overlay using intoRoot
// ---------------------------------------------------------------------------

describe("parseJson — round-trip acme-vehicle base + overlay with intoRoot", () => {
  let registry: TypeRegistry;
  let mergedRoot: ReturnType<typeof parseJson>["root"];

  beforeEach(() => {
    registry = makeRegistry();
    // Load in dependency order: common → vehicle → overlay
    const commonContent = loadFixture("acme-common-metadata.json");
    const baseContent = loadFixture("acme-vehicle-metadata.json");
    const overlayContent = loadFixture("acme-vehicle-overlay-metadata.json");
    const { root: common } = parseJson(commonContent, { registry });
    const { root: base } = parseJson(baseContent, { registry, intoRoot: common });
    const { root } = parseJson(overlayContent, { registry, intoRoot: base });
    mergedRoot = root;
  });

  it("base entities (Car, Truck) are present after overlay merge", () => {
    expect(mergedRoot.ownChildByTypeAndName("object", "Car")).toBeDefined();
    expect(mergedRoot.ownChildByTypeAndName("object", "Truck")).toBeDefined();
  });

  it("overlay adds new field (premiumLocation) to Garage", () => {
    const garage = mergedRoot.ownChildByTypeAndName("object", "Garage")!;
    expect(garage.ownChildByTypeAndName("field", "premiumLocation")).toBeDefined();
  });

  it("overlay adds new field (warranty) to Vehicle", () => {
    const vehicle = mergedRoot.ownChildByTypeAndName("object", "Vehicle")!;
    expect(vehicle.ownChildByTypeAndName("field", "warranty")).toBeDefined();
  });

  it("overlay adds new field (certifiedPreOwned) to Porsche", () => {
    const porsche = mergedRoot.ownChildByTypeAndName("object", "Porsche")!;
    expect(porsche.ownChildByTypeAndName("field", "certifiedPreOwned")).toBeDefined();
  });

  it("overlay adds new field (customPaint) to Motorcycle", () => {
    const moto = mergedRoot.ownChildByTypeAndName("object", "Motorcycle")!;
    expect(moto.ownChildByTypeAndName("field", "customPaint")).toBeDefined();
  });

  it("overlay entities with overlay: true have isMerge set", () => {
    const garage = mergedRoot.ownChildByTypeAndName("object", "Garage")!;
    expect(garage.isMerge).toBe(true);
    const vehicle = mergedRoot.ownChildByTypeAndName("object", "Vehicle")!;
    expect(vehicle.isMerge).toBe(true);
  });

  it("Car.superResolved points to Vehicle (same-file super resolved during base parse)", () => {
    const car = mergedRoot.ownChildByTypeAndName("object", "Car")!;
    expect(car.superResolved).toBeDefined();
    expect(car.superResolved!.name).toBe("Vehicle");
  });

  it("Porsche.superResolved points to Car", () => {
    const porsche = mergedRoot.ownChildByTypeAndName("object", "Porsche")!;
    expect(porsche.superResolved).toBeDefined();
    expect(porsche.superResolved!.name).toBe("Car");
  });
});

// ---------------------------------------------------------------------------
// Root-level super: warns rather than silently swallowing
// ---------------------------------------------------------------------------

describe("parseJson — root-level super (silent-swallow guard)", () => {
  it("emits warning when root has a super ref (non-strict)", () => {
    const registry = new TypeRegistry();
    registerCoreTypes(registry);
    const result = parseJson(
      JSON.stringify({ "metadata.root": { extends: "Whatever" } }),
      { registry, strict: false },
    );
    expect(result.warnings.some((w) => w.includes("super on root node"))).toBe(true);
    expect(result.root.superResolved).toBeUndefined();
  });

  it("throws in strict mode when root has a super ref", () => {
    const registry = new TypeRegistry();
    registerCoreTypes(registry);
    expect(() =>
      parseJson(JSON.stringify({ "metadata.root": { extends: "X" } }), {
        registry,
        strict: true,
      }),
    ).toThrow(/super on root node/);
  });
});

// ---------------------------------------------------------------------------
// Polymorphic (SUBTYPE_BASE) attr value type-preservation
//
// @default is declared with valueType SUBTYPE_BASE — the "unconstrained /
// polymorphic" marker. The parser must NOT coerce its value toward
// DATA_TYPE_STRING; it must preserve whatever JSON type the author wrote.
// ---------------------------------------------------------------------------

describe("parseJson — @default (SUBTYPE_BASE / polymorphic) preserves value type", () => {
  it("@default: false (boolean) is stored as boolean false, not the string 'false'", () => {
    const registry = makeRegistry();
    const input = JSON.stringify({
      "metadata.root": {
        children: [
          {
            "object.entity": {
              name: "Order",
              children: [
                { "field.boolean": { name: "confirmed", "@default": false } },
              ],
            },
          },
        ],
      },
    });
    const { root } = parseJson(input, { registry });
    const entity = root.ownChildren()[0]!;
    const field = entity.ownChildren()[0]!;
    const v = field.ownAttr("default");
    expect(typeof v).toBe("boolean");
    expect(v).toBe(false);
  });

  it("@default: 0 (number) is stored as the number 0, not the string '0'", () => {
    const registry = makeRegistry();
    const input = JSON.stringify({
      "metadata.root": {
        children: [
          {
            "object.entity": {
              name: "Order",
              children: [
                { "field.long": { name: "quantity", "@default": 0 } },
              ],
            },
          },
        ],
      },
    });
    const { root } = parseJson(input, { registry });
    const entity = root.ownChildren()[0]!;
    const field = entity.ownChildren()[0]!;
    const v = field.ownAttr("default");
    expect(typeof v).toBe("number");
    expect(v).toBe(0);
  });

  it("@default: 'active' (string) is stored as the string 'active' (regression guard)", () => {
    const registry = makeRegistry();
    const input = JSON.stringify({
      "metadata.root": {
        children: [
          {
            "object.entity": {
              name: "Order",
              children: [
                { "field.string": { name: "status", "@default": "active" } },
              ],
            },
          },
        ],
      },
    });
    const { root } = parseJson(input, { registry });
    const entity = root.ownChildren()[0]!;
    const field = entity.ownChildren()[0]!;
    const v = field.ownAttr("default");
    expect(typeof v).toBe("string");
    expect(v).toBe("active");
  });

  it("attr.base child node with boolean value is stored type-preserved on parent", () => {
    const registry = makeRegistry();
    // Explicit attr child node with subtype "base" (the polymorphic subtype)
    // carrying a boolean value — must NOT be stringified.
    const input = JSON.stringify({
      "metadata.root": {
        children: [
          {
            "object.entity": {
              name: "Item",
              children: [
                {
                  "field.boolean": {
                    name: "enabled",
                    children: [
                      { "attr.base": { name: "default", value: false } },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    });
    const { root } = parseJson(input, { registry });
    const entity = root.ownChildren()[0]!;
    const field = entity.ownChildren()[0]!;
    const v = field.ownAttr("default");
    expect(typeof v).toBe("boolean");
    expect(v).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Additional: errors.ts exports
// ---------------------------------------------------------------------------

describe("errors.ts exports", () => {
  it("ParseError is an Error subclass", () => {
    const err = new ParseError("test", { code: "ERR_UNKNOWN", source: { format: "code" } });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ParseError);
  });

  it("ParseError.name is 'ParseError'", () => {
    expect(new ParseError("x", { code: "ERR_UNKNOWN", source: { format: "code" } }).name).toBe("ParseError");
  });

  it("ParseError stores the ErrorSource envelope (FR5a)", () => {
    const err = new ParseError("msg", {
      code: "ERR_MALFORMED_JSON",
      source: { format: "json", files: ["file.json"], jsonPath: "$.metadata.root.children[0]" },
    });
    expect(err.source.format).toBe("json");
    if (err.source.format === "json") {
      expect(err.source.files).toEqual(["file.json"]);
      expect(err.source.jsonPath).toBe("$.metadata.root.children[0]");
    }
    expect(err.code).toBe("ERR_MALFORMED_JSON");
  });

  it("ParseError accepts a code-source envelope for programmatic construction", () => {
    const err = new ParseError("bare message", {
      code: "ERR_UNKNOWN",
      source: { format: "code", caller: "test" },
    });
    expect(err.source.format).toBe("code");
    expect(err.message).toBe("bare message");
  });
});
