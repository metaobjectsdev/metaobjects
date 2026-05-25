// Tests for serializeJson — classic-mo v6 JSON serializer

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { serializeJson, canonicalSerialize } from "../src/serializer-json.js";
import { parseJson } from "../src/parser-json.js";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";
import type { MetaData } from "../src/shared/meta-data.js";
import { MetaRoot } from "../src/shared/meta-root.js";
import { MetaObject } from "../src/core/object/meta-object.js";
import { MetaField } from "../src/core/field/meta-field.js";
import { MetaValidator } from "../src/core/validator/meta-validator.js";
import { MetaIdentity } from "../src/core/identity/meta-identity.js";
import { MetaAttr } from "../src/core/attr/meta-attr.js";
import { TypeId, TypeRegistry } from "../src/registry.js";
import { registerCoreTypes } from "../src/core-types.js";
import {
  TYPE_METADATA,
  TYPE_OBJECT,
  TYPE_FIELD,
  TYPE_ATTR,
  TYPE_IDENTITY,
  TYPE_VALIDATOR,
  SUBTYPE_ROOT,
  OBJECT_SUBTYPE_ENTITY,
  FIELD_SUBTYPE_STRING,
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_LONG,
  FIELD_SUBTYPE_BOOLEAN,
  IDENTITY_SUBTYPE_PRIMARY,
  VALIDATOR_SUBTYPE_REQUIRED,
  VALIDATOR_SUBTYPE_LENGTH,
  RESERVED_KEY_NAME,
  RESERVED_KEY_PACKAGE,
  RESERVED_KEY_EXTENDS,
  RESERVED_KEY_ABSTRACT,
  RESERVED_KEY_IS_ARRAY,
  RESERVED_KEY_CHILDREN,
  ATTR_PREFIX,
  TYPE_SUBTYPE_SEPARATOR,
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

/** Build a fused `type.subType` wrapper key — matches the canonical format. */
function fused(type: string, subType: string): string {
  return `${type}${TYPE_SUBTYPE_SEPARATOR}${subType}`;
}

/**
 * Create a typed node directly (without registry) for simple unit tests.
 * Dispatches to the right concrete class so instanceof / typed getters work.
 */
function makeModel(type: string, subType: string, name: string): MetaData {
  const id = new TypeId(type, subType);
  switch (type) {
    case TYPE_METADATA:
      return new MetaRoot(id, name);
    case TYPE_OBJECT:
      return new MetaObject(id, name);
    case TYPE_FIELD:
      return new MetaField(id, name);
    case TYPE_VALIDATOR:
      return new MetaValidator(id, name);
    case TYPE_IDENTITY:
      return new MetaIdentity(id, name);
    case TYPE_ATTR:
      return new MetaAttr(id, name);
    default:
      return new MetaObject(id, name);
  }
}

/**
 * Recursively assert two MetaData trees are structurally equivalent.
 * Compares: typeId, name, package, superRef, isAbstract, isArray, attrs, children (recursive).
 * Does NOT compare frozen state or superResolved (runtime, not wire-format).
 */
function assertModelsEqual(a: MetaData, b: MetaData, path = "root"): void {
  expect(a.type).toBe(b.type);
  expect(a.subType).toBe(b.subType);
  expect(a.name).toBe(b.name);
  expect(a.package).toBe(b.package);
  expect(a.superRef).toBe(b.superRef);
  expect(a.isAbstract).toBe(b.isAbstract);
  expect(a.isArray).toBe(b.isArray);

  // Compare attrs maps
  const aAttrs = a.ownAttrs();
  const bAttrs = b.ownAttrs();
  expect(aAttrs.size).toBe(bAttrs.size);
  for (const [k, v] of aAttrs) {
    expect(bAttrs.has(k)).toBe(true);
    const bVal = bAttrs.get(k);
    if (Array.isArray(v)) {
      expect(Array.isArray(bVal)).toBe(true);
      expect(bVal).toEqual(v);
    } else {
      expect(bVal).toBe(v);
    }
  }

  // Compare children recursively
  const aKids = a.ownChildren();
  const bKids = b.ownChildren();
  expect(aKids.length).toBe(bKids.length);
  for (let i = 0; i < aKids.length; i++) {
    assertModelsEqual(aKids[i]!, bKids[i]!, `${path}.children[${i}]`);
  }
}

// ---------------------------------------------------------------------------
// 1. Empty metadata root
// ---------------------------------------------------------------------------

describe("serializeJson — empty metadata root", () => {
  it('serializes {"metadata.root": {}} with default indent=2', () => {
    const model = makeModel(TYPE_METADATA, SUBTYPE_ROOT, "");
    const json = serializeJson(model);
    const parsed = JSON.parse(json);
    // Has the fused wrapper key "metadata.root" — type and subType fused
    const rootKey = fused(TYPE_METADATA, SUBTYPE_ROOT);
    expect(typeof parsed[rootKey]).toBe("object");
    // No bare "metadata" wrapper key in the redesigned format
    expect(parsed[TYPE_METADATA]).toBeUndefined();
    // No children key (empty)
    expect(parsed[rootKey][RESERVED_KEY_CHILDREN]).toBeUndefined();
    // No name key (empty string — omitted)
    expect(parsed[rootKey][RESERVED_KEY_NAME]).toBeUndefined();
    // No package
    expect(parsed[rootKey][RESERVED_KEY_PACKAGE]).toBeUndefined();
  });

  it("emitted JSON is parseable with indent=2 (default)", () => {
    const model = makeModel(TYPE_METADATA, SUBTYPE_ROOT, "");
    const json = serializeJson(model);
    // Indented — should contain newlines
    expect(json).toContain("\n");
  });
});

// ---------------------------------------------------------------------------
// Helpers for navigating the redesigned (fused-key) wire format
// ---------------------------------------------------------------------------

type JsonObj = Record<string, unknown>;

/** Pull the body of the single-key wrapper for a fused (type.subType) key. */
function bodyOf(parsed: JsonObj, type: string, subType: string): JsonObj {
  return parsed[fused(type, subType)] as JsonObj;
}

/** Pull the children array of a node body (undefined when none). */
function childrenOf(body: JsonObj): JsonObj[] | undefined {
  return body[RESERVED_KEY_CHILDREN] as JsonObj[] | undefined;
}

/** Unwrap the i-th child wrapper into its single (fusedKey, body) pair. */
function childAt(body: JsonObj, i: number): { key: string; body: JsonObj } {
  const kids = childrenOf(body)!;
  const wrapper = kids[i]!;
  const key = Object.keys(wrapper)[0]!;
  return { key, body: wrapper[key] as JsonObj };
}

// ---------------------------------------------------------------------------
// 2. Root with package
// ---------------------------------------------------------------------------

describe("serializeJson — root with package", () => {
  it('emits "package" reserved key when set', () => {
    const model = makeModel(TYPE_METADATA, SUBTYPE_ROOT, "");
    model.setPackage("demo");
    const json = serializeJson(model);
    const parsed = JSON.parse(json);
    expect(bodyOf(parsed, TYPE_METADATA, SUBTYPE_ROOT)[RESERVED_KEY_PACKAGE]).toBe("demo");
  });

  it("omits package key when package is empty string", () => {
    const model = makeModel(TYPE_METADATA, SUBTYPE_ROOT, "");
    model.setPackage("");
    const json = serializeJson(model);
    const parsed = JSON.parse(json);
    expect(bodyOf(parsed, TYPE_METADATA, SUBTYPE_ROOT)[RESERVED_KEY_PACKAGE]).toBeUndefined();
  });

  it("omits package key when package is not set", () => {
    const model = makeModel(TYPE_METADATA, SUBTYPE_ROOT, "");
    const json = serializeJson(model);
    const parsed = JSON.parse(json);
    expect(bodyOf(parsed, TYPE_METADATA, SUBTYPE_ROOT)[RESERVED_KEY_PACKAGE]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Single object child
// ---------------------------------------------------------------------------

describe("serializeJson — single object child", () => {
  it("emits object child wrapper in children array", () => {
    const root = makeModel(TYPE_METADATA, SUBTYPE_ROOT, "");
    const child = makeModel(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY, "Store");
    root.addChild(child);

    const json = serializeJson(root);
    const parsed = JSON.parse(json);

    const rootBody = bodyOf(parsed, TYPE_METADATA, SUBTYPE_ROOT);
    const children = childrenOf(rootBody);
    expect(Array.isArray(children)).toBe(true);
    expect(children!.length).toBe(1);

    // Child wrapper key fuses type and subType: "object.entity"
    const first = childAt(rootBody, 0);
    expect(first.key).toBe(fused(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY));
    expect(first.body[RESERVED_KEY_NAME]).toBe("Store");
  });

  it("omits children key when no children", () => {
    const root = makeModel(TYPE_METADATA, SUBTYPE_ROOT, "");
    const json = serializeJson(root);
    const parsed = JSON.parse(json);
    expect(childrenOf(bodyOf(parsed, TYPE_METADATA, SUBTYPE_ROOT))).toBeUndefined();
  });

  it("preserves multiple children in insertion order", () => {
    const root = makeModel(TYPE_METADATA, SUBTYPE_ROOT, "");
    root.addChild(makeModel(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY, "Alpha"));
    root.addChild(makeModel(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY, "Beta"));
    root.addChild(makeModel(TYPE_FIELD, FIELD_SUBTYPE_STRING, "gamma"));

    const json = serializeJson(root);
    const parsed = JSON.parse(json);
    const rootBody = bodyOf(parsed, TYPE_METADATA, SUBTYPE_ROOT);
    expect(childrenOf(rootBody)!.length).toBe(3);
    expect(childAt(rootBody, 0).body[RESERVED_KEY_NAME]).toBe("Alpha");
    expect(childAt(rootBody, 1).body[RESERVED_KEY_NAME]).toBe("Beta");
    expect(childAt(rootBody, 2).key).toBe(fused(TYPE_FIELD, FIELD_SUBTYPE_STRING));
    expect(childAt(rootBody, 2).body[RESERVED_KEY_NAME]).toBe("gamma");
  });
});

// ---------------------------------------------------------------------------
// 4. Inline @-attrs
// ---------------------------------------------------------------------------

describe("serializeJson — inline @-attrs", () => {
  it("emits string attr inline as @attrName", () => {
    const obj = makeModel(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY, "Store");
    obj.setAttr("dbTable", "store_t");

    const root = makeModel(TYPE_METADATA, SUBTYPE_ROOT, "");
    root.addChild(obj);

    const json = serializeJson(root);
    const parsed = JSON.parse(json);
    const storeObj = childAt(bodyOf(parsed, TYPE_METADATA, SUBTYPE_ROOT), 0).body;
    expect(storeObj[`${ATTR_PREFIX}dbTable`]).toBe("store_t");
  });

  it("emits boolean attr inline", () => {
    const field = makeModel(TYPE_FIELD, FIELD_SUBTYPE_INT, "count");
    field.setAttr("nullable", false);

    const root = makeModel(TYPE_METADATA, SUBTYPE_ROOT, "");
    root.addChild(field);

    const json = serializeJson(root);
    const parsed = JSON.parse(json);
    const fieldObj = childAt(bodyOf(parsed, TYPE_METADATA, SUBTYPE_ROOT), 0).body;
    expect(fieldObj[`${ATTR_PREFIX}nullable`]).toBe(false);
  });

  it("emits number attr inline", () => {
    const validator = makeModel(TYPE_VALIDATOR, VALIDATOR_SUBTYPE_LENGTH, "");
    validator.setAttr("min", 1);
    validator.setAttr("max", 50);

    const root = makeModel(TYPE_METADATA, SUBTYPE_ROOT, "");
    root.addChild(validator);

    const json = serializeJson(root);
    const parsed = JSON.parse(json);
    const validatorObj = childAt(bodyOf(parsed, TYPE_METADATA, SUBTYPE_ROOT), 0).body;
    expect(validatorObj[`${ATTR_PREFIX}min`]).toBe(1);
    expect(validatorObj[`${ATTR_PREFIX}max`]).toBe(50);
  });

  it("emits string[] attr inline as JSON array", () => {
    const field = makeModel(TYPE_FIELD, FIELD_SUBTYPE_STRING, "tags");
    field.setAttr("enumValues", ["red", "green", "blue"]);

    const root = makeModel(TYPE_METADATA, SUBTYPE_ROOT, "");
    root.addChild(field);

    const json = serializeJson(root);
    const parsed = JSON.parse(json);
    const fieldObj = childAt(bodyOf(parsed, TYPE_METADATA, SUBTYPE_ROOT), 0).body;
    expect(fieldObj[`${ATTR_PREFIX}enumValues`]).toEqual(["red", "green", "blue"]);
  });
});

// ---------------------------------------------------------------------------
// 5. isArray native handling — reserved structural key (NOT @isArray)
// ---------------------------------------------------------------------------

describe("serializeJson — isArray reserved key handling", () => {
  it('emits "isArray": true reserved key when isArray is true', () => {
    const field = makeModel(TYPE_FIELD, FIELD_SUBTYPE_STRING, "tags");
    field.setIsArray(true);

    const root = makeModel(TYPE_METADATA, SUBTYPE_ROOT, "");
    root.addChild(field);

    const json = serializeJson(root);
    const parsed = JSON.parse(json);
    const fieldObj = childAt(bodyOf(parsed, TYPE_METADATA, SUBTYPE_ROOT), 0).body;
    // Emitted as reserved structural key, NOT as @isArray
    expect(fieldObj[RESERVED_KEY_IS_ARRAY]).toBe(true);
    expect(fieldObj[`${ATTR_PREFIX}${RESERVED_KEY_IS_ARRAY}`]).toBeUndefined();
  });

  it("does NOT emit isArray when isArray is false (default)", () => {
    const field = makeModel(TYPE_FIELD, FIELD_SUBTYPE_STRING, "name");
    // isArray defaults to false

    const root = makeModel(TYPE_METADATA, SUBTYPE_ROOT, "");
    root.addChild(field);

    const json = serializeJson(root);
    const parsed = JSON.parse(json);
    const fieldObj = childAt(bodyOf(parsed, TYPE_METADATA, SUBTYPE_ROOT), 0).body;
    expect(fieldObj[RESERVED_KEY_IS_ARRAY]).toBeUndefined();
  });

  it("does NOT emit isArray when explicitly set to false", () => {
    const field = makeModel(TYPE_FIELD, FIELD_SUBTYPE_STRING, "name");
    field.setIsArray(false);

    const root = makeModel(TYPE_METADATA, SUBTYPE_ROOT, "");
    root.addChild(field);

    const json = serializeJson(root);
    const parsed = JSON.parse(json);
    const fieldObj = childAt(bodyOf(parsed, TYPE_METADATA, SUBTYPE_ROOT), 0).body;
    expect(fieldObj[RESERVED_KEY_IS_ARRAY]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. abstract reserved key
// ---------------------------------------------------------------------------

describe("serializeJson — abstract reserved key", () => {
  it('emits "abstract": true (reserved key, NOT @abstract) when isAbstract is true', () => {
    const obj = makeModel(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY, "BaseFruit");
    obj.setIsAbstract(true);

    const root = makeModel(TYPE_METADATA, SUBTYPE_ROOT, "");
    root.addChild(obj);

    const json = serializeJson(root);
    const parsed = JSON.parse(json);
    const objWrapper = childAt(bodyOf(parsed, TYPE_METADATA, SUBTYPE_ROOT), 0).body;

    // Emitted as reserved key (no @ prefix)
    expect(objWrapper[RESERVED_KEY_ABSTRACT]).toBe(true);
    // NOT as @abstract
    expect(objWrapper[`${ATTR_PREFIX}${RESERVED_KEY_ABSTRACT}`]).toBeUndefined();
  });

  it("does NOT emit abstract when false (default)", () => {
    const obj = makeModel(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY, "Store");

    const root = makeModel(TYPE_METADATA, SUBTYPE_ROOT, "");
    root.addChild(obj);

    const json = serializeJson(root);
    const parsed = JSON.parse(json);
    const objWrapper = childAt(bodyOf(parsed, TYPE_METADATA, SUBTYPE_ROOT), 0).body;
    expect(objWrapper[RESERVED_KEY_ABSTRACT]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 7. super reference (extends)
// ---------------------------------------------------------------------------

describe("serializeJson — extends reference", () => {
  it('emits "extends" reserved key when superRef is set', () => {
    const field = makeModel(TYPE_FIELD, FIELD_SUBTYPE_LONG, "id");
    field.setSuper("..::common::id");

    const root = makeModel(TYPE_METADATA, SUBTYPE_ROOT, "");
    root.addChild(field);

    const json = serializeJson(root);
    const parsed = JSON.parse(json);
    const fieldObj = childAt(bodyOf(parsed, TYPE_METADATA, SUBTYPE_ROOT), 0).body;
    expect(fieldObj[RESERVED_KEY_EXTENDS]).toBe("..::common::id");
  });

  it("omits extends key when superRef is not set", () => {
    const field = makeModel(TYPE_FIELD, FIELD_SUBTYPE_STRING, "name");

    const root = makeModel(TYPE_METADATA, SUBTYPE_ROOT, "");
    root.addChild(field);

    const json = serializeJson(root);
    const parsed = JSON.parse(json);
    const fieldObj = childAt(bodyOf(parsed, TYPE_METADATA, SUBTYPE_ROOT), 0).body;
    expect(fieldObj[RESERVED_KEY_EXTENDS]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 8. Reserved key order
// ---------------------------------------------------------------------------

describe("serializeJson — reserved key order", () => {
  it("emits keys in stable documented order: name, package, extends, abstract, @attrs, children", () => {
    const root = makeModel(TYPE_METADATA, SUBTYPE_ROOT, "");
    const obj = makeModel(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY, "Widget");
    obj.setPackage("demo::widgets");
    obj.setSuper("..::base::BaseWidget");
    obj.setIsAbstract(false); // false — should NOT appear in output
    obj.setAttr("dbTable", "widget_t");
    obj.setAttr("cacheKey", "widget");

    const child = makeModel(TYPE_FIELD, FIELD_SUBTYPE_STRING, "code");
    obj.addChild(child);

    root.addChild(obj);

    const json = serializeJson(root);
    const parsed = JSON.parse(json);
    const objData = childAt(bodyOf(parsed, TYPE_METADATA, SUBTYPE_ROOT), 0).body;

    const keys = Object.keys(objData);
    // canonical body-key order: name, package, extends, abstract, @attrs, children
    const nameIdx = keys.indexOf(RESERVED_KEY_NAME);
    const pkgIdx = keys.indexOf(RESERVED_KEY_PACKAGE);
    const extendsIdx = keys.indexOf(RESERVED_KEY_EXTENDS);
    const childrenIdx = keys.indexOf(RESERVED_KEY_CHILDREN);
    const attrIdx = keys.indexOf(`${ATTR_PREFIX}dbTable`);

    expect(nameIdx).toBeLessThan(pkgIdx);
    expect(pkgIdx).toBeLessThan(extendsIdx);
    expect(extendsIdx).toBeLessThan(attrIdx);
    expect(attrIdx).toBeLessThan(childrenIdx);
  });

  it("abstract appears before @-attrs when true", () => {
    const obj = makeModel(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY, "BaseFruit");
    obj.setIsAbstract(true);
    obj.setAttr("tag", "fruit");

    const root = makeModel(TYPE_METADATA, SUBTYPE_ROOT, "");
    root.addChild(obj);

    const json = serializeJson(root);
    const parsed = JSON.parse(json);
    const objData = childAt(bodyOf(parsed, TYPE_METADATA, SUBTYPE_ROOT), 0).body;

    const keys = Object.keys(objData);
    const abstractIdx = keys.indexOf(RESERVED_KEY_ABSTRACT);
    const attrIdx = keys.indexOf(`${ATTR_PREFIX}tag`);

    expect(abstractIdx).toBeLessThan(attrIdx);
  });
});

// ---------------------------------------------------------------------------
// 9. Attrs always emit inline (D5)
// ---------------------------------------------------------------------------

describe("serializeJson — attrs always emit inline (D5)", () => {
  it("an attr set via setAttr emits as inline @name, never a child node", () => {
    const obj = makeModel(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY, "Item");
    obj.setAttr("dbTable", "item_t");
    const root = makeModel(TYPE_METADATA, SUBTYPE_ROOT, "");
    root.addChild(obj);

    const json = serializeJson(root);
    const parsed = JSON.parse(json);
    const objData = childAt(bodyOf(parsed, TYPE_METADATA, SUBTYPE_ROOT), 0).body;

    expect(objData[`${ATTR_PREFIX}dbTable`]).toBe("item_t");
    expect(childrenOf(objData)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 11. Round-trip semantic equality (built model)
// ---------------------------------------------------------------------------

describe("serializeJson — round-trip semantic equality (built model)", () => {
  it("round-trips a non-trivial model through serialize → parse → compare", () => {
    const registry = makeRegistry();

    // Build a non-trivial tree
    const root = makeModel(TYPE_METADATA, SUBTYPE_ROOT, "");
    root.setPackage("test::roundtrip");

    // Common abstract field. Attrs are stored on the node (D5: never a child),
    // so set isKey via setAttr — it canonicalizes to inline @isKey.
    const idField = makeModel(TYPE_FIELD, FIELD_SUBTYPE_LONG, "id");
    idField.setPackage("test::common");
    idField.setIsAbstract(true);
    idField.setAttr("isKey", true);
    root.addChild(idField);

    // Object with fields
    const obj = makeModel(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY, "Product");
    obj.setAttr("dbTable", "product_t");
    obj.setAttr("cacheEnabled", true);

    const nameField = makeModel(TYPE_FIELD, FIELD_SUBTYPE_STRING, "name");
    nameField.setIsArray(false);
    const reqValidator = makeModel(TYPE_VALIDATOR, VALIDATOR_SUBTYPE_REQUIRED, "");
    nameField.addChild(reqValidator);
    obj.addChild(nameField);

    const tagsField = makeModel(TYPE_FIELD, FIELD_SUBTYPE_STRING, "tags");
    tagsField.setIsArray(true);
    tagsField.setAttr("objectRef", "::Tag");
    obj.addChild(tagsField);

    const identity = makeModel(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY, "pk");
    obj.addChild(identity);

    root.addChild(obj);

    // Serialize
    const json = serializeJson(root);

    // Parse back
    const { root: reparsed } = parseJson(json, { registry });

    // Compare
    assertModelsEqual(root, reparsed);
  });
});

// ---------------------------------------------------------------------------
// 12. Round-trip on real fixture (fruitbasket-metadata.json)
// ---------------------------------------------------------------------------

describe("serializeJson — round-trip on real fixture", () => {
  it("fruitbasket-metadata.json: parse → serialize → parse → structurally equivalent", () => {
    const registry = makeRegistry();

    const raw = loadFixture("fruitbasket-metadata.json");
    const { root: first } = parseJson(raw, { registry });

    const serialized = serializeJson(first);

    const { root: second } = parseJson(serialized, { registry });

    assertModelsEqual(first, second);
  });
});

// ---------------------------------------------------------------------------
// 13. indent: 0 option produces minified JSON
// ---------------------------------------------------------------------------

describe("serializeJson — indent: 0 option", () => {
  it("produces minified JSON with no whitespace between tokens", () => {
    const root = makeModel(TYPE_METADATA, SUBTYPE_ROOT, "");
    root.setPackage("mini");
    const child = makeModel(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY, "Foo");
    child.setAttr("bar", "baz");
    root.addChild(child);

    const json = serializeJson(root, { indent: 0 });

    // No newlines, no leading spaces
    expect(json).not.toContain("\n");
    // Still valid JSON
    const parsed = JSON.parse(json);
    expect(bodyOf(parsed, TYPE_METADATA, SUBTYPE_ROOT)[RESERVED_KEY_PACKAGE]).toBe("mini");
  });

  it("default indent=2 produces multi-line output", () => {
    const root = makeModel(TYPE_METADATA, SUBTYPE_ROOT, "");
    root.addChild(makeModel(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY, "Foo"));

    const json = serializeJson(root);
    expect(json).toContain("\n");
    expect(json).toContain("  ");
  });

  it("explicit indent=4 uses 4-space indentation", () => {
    const root = makeModel(TYPE_METADATA, SUBTYPE_ROOT, "");
    const json = serializeJson(root, { indent: 4 });
    // Contains 4-space indentation
    expect(json).toContain("    ");
  });
});

// ---------------------------------------------------------------------------
// Additional edge cases
// ---------------------------------------------------------------------------

describe("serializeJson — edge cases", () => {
  it("does NOT emit $schema key", () => {
    const root = makeModel(TYPE_METADATA, SUBTYPE_ROOT, "");
    const json = serializeJson(root);
    expect(json).not.toContain("$schema");
  });

  it("emits name key when model has a non-empty name", () => {
    const root = makeModel(TYPE_METADATA, SUBTYPE_ROOT, "myRoot");
    const json = serializeJson(root);
    const parsed = JSON.parse(json);
    expect(bodyOf(parsed, TYPE_METADATA, SUBTYPE_ROOT)[RESERVED_KEY_NAME]).toBe("myRoot");
  });

  it("does not emit abstract key when isAbstract is false", () => {
    const obj = makeModel(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY, "Foo");
    obj.setIsAbstract(false);
    const root = makeModel(TYPE_METADATA, SUBTYPE_ROOT, "");
    root.addChild(obj);
    const json = serializeJson(root);
    const parsed = JSON.parse(json);
    const objData = childAt(bodyOf(parsed, TYPE_METADATA, SUBTYPE_ROOT), 0).body;
    expect(objData[RESERVED_KEY_ABSTRACT]).toBeUndefined();
  });

  it("handles deeply nested children", () => {
    const registry = makeRegistry();
    const root = makeModel(TYPE_METADATA, SUBTYPE_ROOT, "");
    const obj = makeModel(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY, "Widget");
    const field = makeModel(TYPE_FIELD, FIELD_SUBTYPE_INT, "qty");
    const validator = makeModel(TYPE_VALIDATOR, VALIDATOR_SUBTYPE_LENGTH, "");
    validator.setAttr("min", 0);
    validator.setAttr("max", 100);
    field.addChild(validator);
    obj.addChild(field);
    root.addChild(obj);

    const json = serializeJson(root);
    const { root: reparsed } = parseJson(json, { registry });
    assertModelsEqual(root, reparsed);
  });

  it("fruitbasket fixture's abstract fields re-serialize as the reserved 'abstract' key", () => {
    // fruitbasket declares abstract via the reserved structural key. The
    // serializer must round-trip it as the reserved key "abstract", never @abstract.
    const registry = makeRegistry();
    const raw = loadFixture("fruitbasket-metadata.json");
    const { root } = parseJson(raw, { registry });

    // The Fruit object should have isAbstract=true
    const fruitObj = root.ownChildren().find((c) => c.name === "Fruit");
    expect(fruitObj).toBeDefined();
    expect(fruitObj!.isAbstract).toBe(true);

    const serialized = serializeJson(root);
    const parsed = JSON.parse(serialized);

    // Find the Fruit child in serialized output (fused "object.*" wrapper key)
    const children = childrenOf(bodyOf(parsed, TYPE_METADATA, SUBTYPE_ROOT))!;
    const fruitSerialized = children.find((wrapper) => {
      const key = Object.keys(wrapper)[0]!;
      return key.startsWith(`${TYPE_OBJECT}${TYPE_SUBTYPE_SEPARATOR}`) &&
        (wrapper[key] as JsonObj)[RESERVED_KEY_NAME] === "Fruit";
    });
    expect(fruitSerialized).toBeDefined();
    const fruitData = fruitSerialized![Object.keys(fruitSerialized!)[0]!] as JsonObj;

    // Must use reserved key form, NOT @abstract
    expect(fruitData[RESERVED_KEY_ABSTRACT]).toBe(true);
    expect(fruitData[`${ATTR_PREFIX}${RESERVED_KEY_ABSTRACT}`]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// canonicalSerialize — deterministic output for cross-language conformance
// ---------------------------------------------------------------------------

describe("canonicalSerialize — deterministic output for cross-language conformance", () => {
  it("emits inline attrs in alphabetical order", async () => {
    const json = JSON.stringify({
      "metadata.root": {
        package: "acme",
        children: [{
          "object.entity": {
            name: "Product",
            "@zindex": "10",
            "@alpha": "1",
            "@mid": "5",
          },
        }],
      },
    });
    const loader = new MetaDataLoader();
    const { root } = await loader.load([new InMemoryStringSource(json)]);
    const output = canonicalSerialize(root);
    // @alpha must appear before @mid which must appear before @zindex
    const aIdx = output.indexOf('"@alpha"');
    const mIdx = output.indexOf('"@mid"');
    const zIdx = output.indexOf('"@zindex"');
    expect(aIdx).toBeGreaterThan(-1);
    expect(aIdx).toBeLessThan(mIdx);
    expect(mIdx).toBeLessThan(zIdx);
  });

  it("appends a trailing newline", async () => {
    const loader = new MetaDataLoader();
    const { root } = await loader.load([new InMemoryStringSource('{"metadata.root":{}}')]);
    const output = canonicalSerialize(root);
    expect(output.endsWith("\n")).toBe(true);
  });

  it("uses 2-space indent", async () => {
    const loader = new MetaDataLoader();
    const { root } = await loader.load([new InMemoryStringSource('{"metadata.root":{"package":"acme"}}')]);
    const output = canonicalSerialize(root);
    expect(output).toContain('\n  "metadata.root"');
    expect(output).toContain('\n    "package": "acme"');
  });

  it("produces identical bytes on repeated calls (no Map iteration drift)", async () => {
    const json = JSON.stringify({
      "metadata.root": {
        package: "acme",
        children: [{
          "object.entity": {
            name: "Product",
            "@b": "1", "@a": "2", "@c": "3",
            children: [
              { "field.long": { name: "id" } },
              { "field.string": { name: "name" } },
            ],
          },
        }],
      },
    });
    const r1 = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
    const r2 = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
    const out1 = canonicalSerialize(r1.root);
    const out2 = canonicalSerialize(r2.root);
    expect(out1).toBe(out2);
  });
});
