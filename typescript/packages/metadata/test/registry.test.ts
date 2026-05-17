import { describe, it, expect, beforeEach } from "bun:test";
import { TypeId, TypeRegistry, childRuleMatches } from "../src/registry.js";
import { registerCoreTypes } from "../src/core-types.js";
import type { MetaData } from "../src/meta/meta-data.js";
import {
  TYPE_FIELD,
  TYPE_OBJECT,
  TYPE_ATTR,
  TYPE_METADATA,
  TYPE_VALIDATOR,
  TYPE_IDENTITY,
  TYPE_VIEW,
  TYPE_RELATIONSHIP,
  TYPE_LAYOUT,
  TYPE_SOURCE,
  TYPE_ORIGIN,
  SUBTYPE_BASE,
  SUBTYPE_ROOT,
  FIELD_SUBTYPE_STRING,
  OBJECT_SUBTYPE_ENTITY,
  ATTR_SUBTYPE_STRING,
  ATTR_SUBTYPE_STRINGARRAY,
  IDENTITY_SUBTYPE_PRIMARY,
  CHILD_RULE_WILDCARD,
  FIELD_SUBTYPES,
  OBJECT_SUBTYPES,
  ATTR_SUBTYPES,
  VALIDATOR_SUBTYPES,
  VIEW_SUBTYPES,
  IDENTITY_SUBTYPES,
  RELATIONSHIP_SUBTYPES,
  LAYOUT_SUBTYPES,
} from "../src/constants.js";

// Stub factory used throughout tests — Task 3 will provide the real MetaData.
const stubFactory = (): MetaData => null as unknown as MetaData;

// Helper to build a minimal TypeDefinition for a given type+subType.
function makeDef(type: string, subType: string) {
  return {
    typeId: new TypeId(type, subType),
    description: `Test definition for ${type}.${subType}`,
    factory: (_typeId: TypeId, _name: string) => stubFactory(),
    childRules: [],
    attributes: [],
  };
}

// ---------------------------------------------------------------------------
// TypeId
// ---------------------------------------------------------------------------

describe("TypeId", () => {
  it("exposes type and subType as public readonly properties", () => {
    const id = new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING);
    expect(id.type).toBe(TYPE_FIELD);
    expect(id.subType).toBe(FIELD_SUBTYPE_STRING);
  });

  it("toString returns 'type.subType'", () => {
    expect(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING).toString()).toBe("field.string");
    expect(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY).toString()).toBe("object.entity");
  });

  it("equals returns true for identical type and subType", () => {
    const a = new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING);
    const b = new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING);
    expect(a.equals(b)).toBe(true);
  });

  it("equals returns false when type differs", () => {
    const a = new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING);
    const b = new TypeId(TYPE_OBJECT, FIELD_SUBTYPE_STRING);
    expect(a.equals(b)).toBe(false);
  });

  it("equals returns false when subType differs", () => {
    const a = new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING);
    const b = new TypeId(TYPE_FIELD, "integer");
    expect(a.equals(b)).toBe(false);
  });

  it("equals returns false when both differ", () => {
    const a = new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING);
    const b = new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY);
    expect(a.equals(b)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TypeRegistry — register / find / has
// ---------------------------------------------------------------------------

describe("TypeRegistry — register/find/has", () => {
  it("find returns the registered definition", () => {
    const registry = new TypeRegistry();
    const def = makeDef(TYPE_FIELD, FIELD_SUBTYPE_STRING);
    registry.register(def);
    expect(registry.find(TYPE_FIELD, FIELD_SUBTYPE_STRING)).toBe(def);
  });

  it("find returns undefined for an unregistered type+subType", () => {
    const registry = new TypeRegistry();
    expect(registry.find(TYPE_FIELD, FIELD_SUBTYPE_STRING)).toBeUndefined();
  });

  it("find returns undefined when only the type matches", () => {
    const registry = new TypeRegistry();
    registry.register(makeDef(TYPE_FIELD, FIELD_SUBTYPE_STRING));
    expect(registry.find(TYPE_FIELD, "integer")).toBeUndefined();
  });

  it("find returns undefined when only the subType matches", () => {
    const registry = new TypeRegistry();
    registry.register(makeDef(TYPE_FIELD, FIELD_SUBTYPE_STRING));
    expect(registry.find(TYPE_OBJECT, FIELD_SUBTYPE_STRING)).toBeUndefined();
  });

  it("has returns true after registration", () => {
    const registry = new TypeRegistry();
    registry.register(makeDef(TYPE_FIELD, FIELD_SUBTYPE_STRING));
    expect(registry.has(TYPE_FIELD, FIELD_SUBTYPE_STRING)).toBe(true);
  });

  it("has returns false for an unregistered type+subType", () => {
    const registry = new TypeRegistry();
    expect(registry.has(TYPE_FIELD, FIELD_SUBTYPE_STRING)).toBe(false);
  });

  it("multiple definitions can be registered and found independently", () => {
    const registry = new TypeRegistry();
    const d1 = makeDef(TYPE_FIELD, FIELD_SUBTYPE_STRING);
    const d2 = makeDef(TYPE_FIELD, "integer");
    const d3 = makeDef(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY);
    registry.register(d1);
    registry.register(d2);
    registry.register(d3);
    expect(registry.find(TYPE_FIELD, FIELD_SUBTYPE_STRING)).toBe(d1);
    expect(registry.find(TYPE_FIELD, "integer")).toBe(d2);
    expect(registry.find(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY)).toBe(d3);
  });
});

// ---------------------------------------------------------------------------
// TypeRegistry — duplicate registration throws
// ---------------------------------------------------------------------------

describe("TypeRegistry — duplicate registration", () => {
  it("throws when the same type+subType is registered a second time", () => {
    const registry = new TypeRegistry();
    registry.register(makeDef(TYPE_FIELD, FIELD_SUBTYPE_STRING));
    expect(() => registry.register(makeDef(TYPE_FIELD, FIELD_SUBTYPE_STRING))).toThrow();
  });

  it("error message includes the duplicate type and subType", () => {
    const registry = new TypeRegistry();
    registry.register(makeDef(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY));
    let caught: unknown;
    try {
      registry.register(makeDef(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(TYPE_OBJECT);
    expect((caught as Error).message).toContain(OBJECT_SUBTYPE_ENTITY);
  });

  it("does not throw for same type with different subType", () => {
    const registry = new TypeRegistry();
    registry.register(makeDef(TYPE_FIELD, FIELD_SUBTYPE_STRING));
    expect(() => registry.register(makeDef(TYPE_FIELD, "integer"))).not.toThrow();
  });

  it("does not throw for same subType with different type", () => {
    const registry = new TypeRegistry();
    registry.register(makeDef(TYPE_FIELD, FIELD_SUBTYPE_STRING));
    expect(() => registry.register(makeDef(TYPE_OBJECT, FIELD_SUBTYPE_STRING))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// TypeRegistry — allTypes / allSubTypesOf
// ---------------------------------------------------------------------------

describe("TypeRegistry — allTypes/allSubTypesOf", () => {
  it("allTypes returns an empty array when nothing is registered", () => {
    const registry = new TypeRegistry();
    expect(registry.allTypes()).toEqual([]);
  });

  it("allTypes length matches the number of registered definitions", () => {
    const registry = new TypeRegistry();
    registry.register(makeDef(TYPE_FIELD, FIELD_SUBTYPE_STRING));
    registry.register(makeDef(TYPE_FIELD, "integer"));
    registry.register(makeDef(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY));
    expect(registry.allTypes()).toHaveLength(3);
  });

  it("allTypes contains all registered TypeIds", () => {
    const registry = new TypeRegistry();
    registry.register(makeDef(TYPE_FIELD, FIELD_SUBTYPE_STRING));
    registry.register(makeDef(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY));
    const ids = registry.allTypes();
    const strings = ids.map((id) => id.toString());
    expect(strings).toContain("field.string");
    expect(strings).toContain("object.entity");
  });

  it("allSubTypesOf returns subtypes registered under the given type", () => {
    const registry = new TypeRegistry();
    registry.register(makeDef(TYPE_FIELD, FIELD_SUBTYPE_STRING));
    registry.register(makeDef(TYPE_FIELD, "integer"));
    registry.register(makeDef(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY));
    const subs = registry.allSubTypesOf(TYPE_FIELD);
    expect(subs).toContain(FIELD_SUBTYPE_STRING);
    expect(subs).toContain("integer");
    expect(subs).not.toContain(OBJECT_SUBTYPE_ENTITY);
  });

  it("allSubTypesOf preserves insertion order", () => {
    const registry = new TypeRegistry();
    registry.register(makeDef(TYPE_FIELD, FIELD_SUBTYPE_STRING));
    registry.register(makeDef(TYPE_FIELD, "integer"));
    registry.register(makeDef(TYPE_FIELD, "boolean"));
    expect(registry.allSubTypesOf(TYPE_FIELD)).toEqual([FIELD_SUBTYPE_STRING, "integer", "boolean"]);
  });

  it("allSubTypesOf returns empty array for unregistered type", () => {
    const registry = new TypeRegistry();
    registry.register(makeDef(TYPE_FIELD, FIELD_SUBTYPE_STRING));
    expect(registry.allSubTypesOf("nonexistent")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// TypeRegistry — childRuleMatches
// ---------------------------------------------------------------------------

describe("TypeRegistry — childRuleMatches", () => {
  it("all-wildcard rule matches any child", () => {
    expect(
      childRuleMatches(
        { childType: CHILD_RULE_WILDCARD, childSubType: CHILD_RULE_WILDCARD, childName: CHILD_RULE_WILDCARD },
        { type: TYPE_FIELD, subType: FIELD_SUBTYPE_STRING, name: "title" },
      ),
    ).toBe(true);
  });

  it("specific childType matches only that type", () => {
    const rule = { childType: TYPE_FIELD, childSubType: CHILD_RULE_WILDCARD, childName: CHILD_RULE_WILDCARD };
    expect(childRuleMatches(rule, { type: TYPE_FIELD, subType: FIELD_SUBTYPE_STRING, name: "x" })).toBe(true);
    expect(childRuleMatches(rule, { type: TYPE_OBJECT, subType: OBJECT_SUBTYPE_ENTITY, name: "x" })).toBe(false);
  });

  it("specific childSubType matches only that subType", () => {
    const rule = { childType: CHILD_RULE_WILDCARD, childSubType: FIELD_SUBTYPE_STRING, childName: CHILD_RULE_WILDCARD };
    expect(childRuleMatches(rule, { type: TYPE_FIELD, subType: FIELD_SUBTYPE_STRING, name: "x" })).toBe(true);
    expect(childRuleMatches(rule, { type: TYPE_FIELD, subType: "integer", name: "x" })).toBe(false);
  });

  it("specific childName matches only that name", () => {
    const rule = { childType: CHILD_RULE_WILDCARD, childSubType: CHILD_RULE_WILDCARD, childName: "title" };
    expect(childRuleMatches(rule, { type: TYPE_FIELD, subType: FIELD_SUBTYPE_STRING, name: "title" })).toBe(true);
    expect(childRuleMatches(rule, { type: TYPE_FIELD, subType: FIELD_SUBTYPE_STRING, name: "body" })).toBe(false);
  });

  it("all three constraints must match simultaneously", () => {
    const rule = { childType: TYPE_FIELD, childSubType: FIELD_SUBTYPE_STRING, childName: "title" };
    // Exact match
    expect(childRuleMatches(rule, { type: TYPE_FIELD, subType: FIELD_SUBTYPE_STRING, name: "title" })).toBe(true);
    // Wrong type
    expect(childRuleMatches(rule, { type: TYPE_OBJECT, subType: FIELD_SUBTYPE_STRING, name: "title" })).toBe(false);
    // Wrong subType
    expect(childRuleMatches(rule, { type: TYPE_FIELD, subType: "integer", name: "title" })).toBe(false);
    // Wrong name
    expect(childRuleMatches(rule, { type: TYPE_FIELD, subType: FIELD_SUBTYPE_STRING, name: "body" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TypeRegistry — allSubTypesOf returns a defensive copy
// ---------------------------------------------------------------------------

describe("TypeRegistry — allSubTypesOf mutation safety", () => {
  it("mutating the returned array does not affect registry internal state", () => {
    const registry = new TypeRegistry();
    registry.register(makeDef(TYPE_FIELD, FIELD_SUBTYPE_STRING));
    registry.register(makeDef(TYPE_FIELD, "integer"));
    const list = registry.allSubTypesOf(TYPE_FIELD);
    list.push("injected");
    expect(registry.allSubTypesOf(TYPE_FIELD)).not.toContain("injected");
    expect(registry.allSubTypesOf(TYPE_FIELD)).toEqual([FIELD_SUBTYPE_STRING, "integer"]);
  });
});

// ---------------------------------------------------------------------------
// registerCoreTypes — Java metamodel taxonomy
// ---------------------------------------------------------------------------

describe("registerCoreTypes", () => {
  let registry: TypeRegistry;

  beforeEach(() => {
    registry = new TypeRegistry();
    registerCoreTypes(registry);
  });

  // 1. All 63 types registered (object subtypes: base/entity/value; field adds base + 15 subtypes (int/string/long/currency/...);
  //    view adds base + 13 subtypes (text/textarea/currency/...); layout adds base + dataGrid; source adds base + dbTable + dbView;
  //    origin adds base + passthrough + aggregate — net type count 63)
  it("registers exactly 63 type definitions", () => {
    expect(registry.allTypes()).toHaveLength(63);
  });

  // 2. Per-base-type subtype lists exact match
  it("registers the correct subtypes for 'metadata'", () => {
    expect(registry.allSubTypesOf(TYPE_METADATA).sort()).toEqual([SUBTYPE_ROOT]);
  });

  it("registers the correct subtypes for 'object'", () => {
    expect(registry.allSubTypesOf(TYPE_OBJECT).sort()).toEqual(
      [...OBJECT_SUBTYPES].sort(),
    );
  });

  it("registers the correct subtypes for 'field'", () => {
    expect(registry.allSubTypesOf(TYPE_FIELD).sort()).toEqual(
      [...FIELD_SUBTYPES].sort(),
    );
  });

  it("registers the correct subtypes for 'attr'", () => {
    expect(registry.allSubTypesOf(TYPE_ATTR).sort()).toEqual(
      [...ATTR_SUBTYPES].sort(),
    );
  });

  it("registers the correct subtypes for 'validator'", () => {
    expect(registry.allSubTypesOf(TYPE_VALIDATOR).sort()).toEqual(
      [...VALIDATOR_SUBTYPES].sort(),
    );
  });

  it("registers the correct subtypes for 'view'", () => {
    expect(registry.allSubTypesOf(TYPE_VIEW).sort()).toEqual(
      [...VIEW_SUBTYPES].sort(),
    );
  });

  it("registers the correct subtypes for 'layout'", () => {
    expect(registry.allSubTypesOf(TYPE_LAYOUT).sort()).toEqual(
      [...LAYOUT_SUBTYPES].sort(),
    );
  });

  it("registers the correct subtypes for 'identity' (no base)", () => {
    expect(registry.allSubTypesOf(TYPE_IDENTITY).sort()).toEqual([...IDENTITY_SUBTYPES].sort());
  });

  it("registers the correct subtypes for 'relationship'", () => {
    expect(registry.allSubTypesOf(TYPE_RELATIONSHIP).sort()).toEqual(
      [...RELATIONSHIP_SUBTYPES].sort(),
    );
  });

  // 3. No identity.base
  it("does NOT register identity.base", () => {
    expect(registry.has(TYPE_IDENTITY, SUBTYPE_BASE)).toBe(false);
  });

  // 4. object.entity registered; legacy/typo subtypes are not
  it("registers object.entity (legacy pojo/map/proxy are not registered)", () => {
    expect(registry.has(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY)).toBe(true);
    expect(registry.has(TYPE_OBJECT, "pojo")).toBe(false);
    expect(registry.has(TYPE_OBJECT, "map")).toBe(false);
    expect(registry.has(TYPE_OBJECT, "proxy")).toBe(false);
  });

  // 5. Child rules spot-checks per base type
  it("object.base has the correct 7 child-type wildcards", () => {
    const def = registry.find(TYPE_OBJECT, SUBTYPE_BASE);
    expect(def).toBeDefined();
    const childTypes = def!.childRules.map((r) => r.childType).sort();
    expect(childTypes).toEqual(
      [TYPE_ATTR, TYPE_FIELD, TYPE_IDENTITY, TYPE_LAYOUT, TYPE_RELATIONSHIP, TYPE_SOURCE, TYPE_VALIDATOR].sort(),
    );
    // All rules are wildcards on subType and name
    for (const rule of def!.childRules) {
      expect(rule.childSubType).toBe(CHILD_RULE_WILDCARD);
      expect(rule.childName).toBe(CHILD_RULE_WILDCARD);
    }
  });

  it("field.string has validator, view, attr, and origin child-type wildcards", () => {
    const def = registry.find(TYPE_FIELD, FIELD_SUBTYPE_STRING);
    expect(def).toBeDefined();
    const childTypes = def!.childRules.map((r) => r.childType).sort();
    expect(childTypes).toEqual([TYPE_ATTR, TYPE_VALIDATOR, TYPE_VIEW, TYPE_ORIGIN].sort());
    for (const rule of def!.childRules) {
      expect(rule.childSubType).toBe(CHILD_RULE_WILDCARD);
      expect(rule.childName).toBe(CHILD_RULE_WILDCARD);
    }
  });

  it("identity.primary has only attr child-type wildcard", () => {
    const def = registry.find(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY);
    expect(def).toBeDefined();
    expect(def!.childRules).toHaveLength(1);
    expect(def!.childRules[0]).toEqual({
      childType: TYPE_ATTR,
      childSubType: CHILD_RULE_WILDCARD,
      childName: CHILD_RULE_WILDCARD,
    });
  });

  it("metadata.root allows object, field, attr, and validator children", () => {
    const def = registry.find(TYPE_METADATA, SUBTYPE_ROOT);
    expect(def).toBeDefined();
    const childTypes = def!.childRules.map((r) => r.childType).sort();
    expect(childTypes).toEqual([TYPE_ATTR, TYPE_FIELD, TYPE_OBJECT, TYPE_VALIDATOR].sort());
  });

  // 6. attr.* has empty child rules
  it("attr.string has no child rules", () => {
    const def = registry.find(TYPE_ATTR, ATTR_SUBTYPE_STRING);
    expect(def).toBeDefined();
    expect(def!.childRules).toHaveLength(0);
  });

  it("attr.stringarray has no child rules", () => {
    const def = registry.find(TYPE_ATTR, ATTR_SUBTYPE_STRINGARRAY);
    expect(def).toBeDefined();
    expect(def!.childRules).toHaveLength(0);
  });

  // 7. Factory works
  it("factory for field.string produces a MetaData with correct typeId and name", () => {
    const def = registry.find(TYPE_FIELD, FIELD_SUBTYPE_STRING);
    expect(def).toBeDefined();
    const typeId = new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING);
    const model = def!.factory(typeId, "myField");
    expect(model.typeId.type).toBe(TYPE_FIELD);
    expect(model.typeId.subType).toBe(FIELD_SUBTYPE_STRING);
    expect(model.name).toBe("myField");
  });

  it("factory for object.entity produces a MetaData with correct typeId and name", () => {
    const def = registry.find(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY);
    expect(def).toBeDefined();
    const typeId = new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY);
    const model = def!.factory(typeId, "MyEntity");
    expect(model.typeId.type).toBe(TYPE_OBJECT);
    expect(model.typeId.subType).toBe(OBJECT_SUBTYPE_ENTITY);
    expect(model.name).toBe("MyEntity");
  });
});

// ---------------------------------------------------------------------------
// TypeRegistry — extend
// ---------------------------------------------------------------------------

describe("TypeRegistry — extend", () => {
  function registryWithFieldString(): TypeRegistry {
    const registry = new TypeRegistry();
    registry.register({
      typeId: new TypeId("field", "string"),
      description: "test field.string",
      factory: () => stubFactory(),
      childRules: [],
      attributes: [],
    });
    return registry;
  }

  it("extend adds attributes to an existing type", () => {
    const registry = registryWithFieldString();
    registry.extend("field", "string", {
      attributes: [
        { name: "objectRef", valueType: ATTR_SUBTYPE_STRING, required: false, description: "ref" },
      ],
    });
    expect(registry.attrsOf("field", "string").some((a) => a.name === "objectRef")).toBe(true);
  });

  it("extend accumulates childRules", () => {
    const registry = registryWithFieldString();
    registry.extend("field", "string", {
      childRules: [{ childType: "attr", childSubType: "*", childName: "*" }],
    });
    expect(registry.find("field", "string")!.childRules).toHaveLength(1);
  });

  it("extend errors on a conflicting attr name", () => {
    const registry = registryWithFieldString();
    registry.extend("field", "string", {
      attributes: [{ name: "dup", valueType: ATTR_SUBTYPE_STRING, required: false, description: "first" }],
    });
    expect(() =>
      registry.extend("field", "string", {
        attributes: [{ name: "dup", valueType: ATTR_SUBTYPE_STRING, required: false, description: "second" }],
      }),
    ).toThrow(/dup/);
  });

  it("extend errors for an unregistered type", () => {
    const registry = new TypeRegistry();
    expect(() => registry.extend("field", "string", { attributes: [] })).toThrow(/field\.string/);
  });

  it("extend errors when an attr name conflicts with one set at register time", () => {
    const registry = new TypeRegistry();
    registry.register({
      typeId: new TypeId("field", "string"),
      description: "test field.string",
      factory: () => stubFactory(),
      childRules: [],
      attributes: [
        { name: "existing", valueType: ATTR_SUBTYPE_STRING, required: false, description: "declared at register time" },
      ],
    });
    expect(() =>
      registry.extend("field", "string", {
        attributes: [
          { name: "existing", valueType: ATTR_SUBTYPE_STRING, required: false, description: "added via extend" },
        ],
      }),
    ).toThrow(/existing/);
  });
});

// ---------------------------------------------------------------------------
// TypeRegistry — default subType
// ---------------------------------------------------------------------------

describe("TypeRegistry — default subType", () => {
  it("setDefaultSubType / defaultSubTypeOf round-trips", () => {
    const registry = new TypeRegistry();
    registry.register({
      typeId: new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY),
      description: "test",
      factory: (id, name) => {
        const typeId = new TypeId(id.type, id.subType);
        const meta = stubFactory();
        return meta;
      },
      childRules: [],
      attributes: [],
    });
    expect(registry.defaultSubTypeOf(TYPE_OBJECT)).toBeUndefined();
    registry.setDefaultSubType(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY);
    expect(registry.defaultSubTypeOf(TYPE_OBJECT)).toBe(OBJECT_SUBTYPE_ENTITY);
  });

  it("defaultSubTypeOf is undefined for an undesignated type", () => {
    const registry = new TypeRegistry();
    expect(registry.defaultSubTypeOf(TYPE_FIELD)).toBeUndefined();
  });
});

describe("TypeDefinition — dataType", () => {
  it("a registered definition carries its declared dataType", () => {
    const registry = new TypeRegistry();
    registry.register({
      typeId: new TypeId("field", "string"),
      description: "test",
      factory: () => stubFactory(),
      childRules: [],
      attributes: [],
      dataType: "string",
    });
    expect(registry.find("field", "string")!.dataType).toBe("string");
  });
});
