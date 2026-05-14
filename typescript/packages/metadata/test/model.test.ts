import { describe, it, expect, beforeEach } from "bun:test";
import { MetaModel } from "../src/model.js";
import { TypeId } from "../src/registry.js";
import { TYPE_FIELD, TYPE_OBJECT, FIELD_SUBTYPE_STRING } from "../src/constants.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeField(subType: string, name: string): MetaModel {
  return new MetaModel(new TypeId(TYPE_FIELD, subType), name);
}

function makeObject(subType: string, name: string): MetaModel {
  return new MetaModel(new TypeId(TYPE_OBJECT, subType), name);
}

// ---------------------------------------------------------------------------
// 1. Construction & defaults
// ---------------------------------------------------------------------------

describe("MetaModel — construction", () => {
  it("exposes typeId, name, type, and subType", () => {
    const m = new MetaModel(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING), "myField");
    expect(m.typeId.type).toBe(TYPE_FIELD);
    expect(m.typeId.subType).toBe(FIELD_SUBTYPE_STRING);
    expect(m.name).toBe("myField");
    expect(m.type).toBe(TYPE_FIELD);
    expect(m.subType).toBe(FIELD_SUBTYPE_STRING);
  });

  it("typeId accessor delegates to the TypeId instance passed in", () => {
    const tid = new TypeId(TYPE_OBJECT, "map");
    const m = new MetaModel(tid, "myObj");
    expect(m.typeId).toBe(tid);
  });

  it("defaults: isArray is false", () => {
    const m = makeField("string", "f");
    expect(m.isArray).toBe(false);
  });

  it("defaults: isAbstract is false", () => {
    const m = makeField("string", "f");
    expect(m.isAbstract).toBe(false);
  });

  it("defaults: package is undefined", () => {
    const m = makeField("string", "f");
    expect(m.package).toBeUndefined();
  });

  it("defaults: superRef is undefined", () => {
    const m = makeField("string", "f");
    expect(m.superRef).toBeUndefined();
  });

  it("defaults: superResolved is undefined", () => {
    const m = makeField("string", "f");
    expect(m.superResolved).toBeUndefined();
  });

  it("defaults: attrs() is empty", () => {
    const m = makeField("string", "f");
    expect(m.attrs().size).toBe(0);
  });

  it("defaults: children() is empty", () => {
    const m = makeField("string", "f");
    expect(m.children().length).toBe(0);
  });

  it("defaults: isFrozen() is false", () => {
    const m = makeField("string", "f");
    expect(m.isFrozen()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. fqn()
// ---------------------------------------------------------------------------

describe("MetaModel — fqn()", () => {
  it("without package returns just the name", () => {
    const m = makeField("string", "myField");
    expect(m.fqn()).toBe("myField");
  });

  it("with package returns 'package::name'", () => {
    const m = makeField("string", "myField");
    m.setPackage("demo::pkg");
    expect(m.fqn()).toBe("demo::pkg::myField");
  });

  it("with a simple package (no nested ::) returns 'pkg::name'", () => {
    const m = makeField("string", "title");
    m.setPackage("com");
    expect(m.fqn()).toBe("com::title");
  });

  it("empty name with package returns 'pkg::'", () => {
    const m = makeField("string", "");
    m.setPackage("demo::pkg");
    // Edge case: documented to not throw
    expect(m.fqn()).toBe("demo::pkg::");
  });
});

// ---------------------------------------------------------------------------
// 3. Attributes
// ---------------------------------------------------------------------------

describe("MetaModel — attributes", () => {
  let m: MetaModel;

  beforeEach(() => {
    m = makeField("string", "f");
  });

  it("setAttr then attr returns the value", () => {
    m.setAttr("label", "My Label");
    expect(m.attr("label")).toBe("My Label");
  });

  it("attr returns undefined for an unset key", () => {
    expect(m.attr("missing")).toBeUndefined();
  });

  it("overwriting setAttr replaces the value", () => {
    m.setAttr("k", "first");
    m.setAttr("k", "second");
    expect(m.attr("k")).toBe("second");
  });

  it("hasAttr returns true after setAttr", () => {
    m.setAttr("k", "v");
    expect(m.hasAttr("k")).toBe(true);
  });

  it("hasAttr returns false for unset key", () => {
    expect(m.hasAttr("missing")).toBe(false);
  });

  it("attrs() returns all set attributes", () => {
    m.setAttr("a", 1);
    m.setAttr("b", true);
    m.setAttr("c", "hello");
    const map = m.attrs();
    expect(map.get("a")).toBe(1);
    expect(map.get("b")).toBe(true);
    expect(map.get("c")).toBe("hello");
    expect(map.size).toBe(3);
  });

  it("attrs() returns a defensive copy — mutating it does not affect the model", () => {
    m.setAttr("x", "original");
    const copy = m.attrs();
    copy.set("x", "mutated");
    copy.set("injected", "val");
    expect(m.attr("x")).toBe("original");
    expect(m.hasAttr("injected")).toBe(false);
  });

  it("supports string AttrValue", () => {
    m.setAttr("s", "hello");
    expect(m.attr("s")).toBe("hello");
  });

  it("supports number AttrValue", () => {
    m.setAttr("n", 42);
    expect(m.attr("n")).toBe(42);
  });

  it("supports boolean AttrValue", () => {
    m.setAttr("b", false);
    expect(m.attr("b")).toBe(false);
  });

  it("supports string[] AttrValue", () => {
    m.setAttr("arr", ["a", "b", "c"]);
    expect(m.attr("arr")).toEqual(["a", "b", "c"]);
  });
});

// ---------------------------------------------------------------------------
// 4. Children
// ---------------------------------------------------------------------------

describe("MetaModel — children", () => {
  let parent: MetaModel;

  beforeEach(() => {
    parent = makeObject("simple", "Parent");
  });

  it("addChild then children() includes the child", () => {
    const c = makeField("string", "title");
    parent.addChild(c);
    expect(parent.children()).toContain(c);
  });

  it("children() preserves insertion order", () => {
    const c1 = makeField("string", "first");
    const c2 = makeField("integer", "second");
    const c3 = makeField("boolean", "third");
    parent.addChild(c1);
    parent.addChild(c2);
    parent.addChild(c3);
    const list = parent.children();
    expect(list[0]).toBe(c1);
    expect(list[1]).toBe(c2);
    expect(list[2]).toBe(c3);
  });

  it("childrenOfType filters by type", () => {
    const f1 = makeField("string", "a");
    const f2 = makeField("integer", "b");
    const o1 = makeObject("simple", "c");
    parent.addChild(f1);
    parent.addChild(f2);
    parent.addChild(o1);
    const fields = parent.childrenOfType("field");
    expect(fields).toContain(f1);
    expect(fields).toContain(f2);
    expect(fields).not.toContain(o1);
  });

  it("childrenOfType returns empty array when no match", () => {
    parent.addChild(makeField("string", "a"));
    expect(parent.childrenOfType("nonexistent")).toEqual([]);
  });

  it("childrenOfSubType filters by both type and subType", () => {
    const f1 = makeField("string", "a");
    const f2 = makeField("integer", "b");
    parent.addChild(f1);
    parent.addChild(f2);
    const strings = parent.childrenOfSubType("field", "string");
    expect(strings).toContain(f1);
    expect(strings).not.toContain(f2);
  });

  it("childByName returns first matching child by name", () => {
    const c1 = makeField("string", "foo");
    const c2 = makeField("integer", "foo"); // same name, different subType
    parent.addChild(c1);
    parent.addChild(c2);
    expect(parent.childByName("foo")).toBe(c1);
  });

  it("childByName returns undefined when no match", () => {
    expect(parent.childByName("nonexistent")).toBeUndefined();
  });

  it("childByTypeAndName returns first child matching both type and name", () => {
    const f = makeField("string", "foo");
    const o = makeObject("simple", "foo");
    parent.addChild(f);
    parent.addChild(o);
    expect(parent.childByTypeAndName("field", "foo")).toBe(f);
    expect(parent.childByTypeAndName("object", "foo")).toBe(o);
  });

  it("childByTypeAndName returns undefined when no match", () => {
    parent.addChild(makeField("string", "a"));
    expect(parent.childByTypeAndName("field", "missing")).toBeUndefined();
    expect(parent.childByTypeAndName("object", "a")).toBeUndefined();
  });

  it("children() length matches number of added children", () => {
    parent.addChild(makeField("string", "a"));
    parent.addChild(makeField("string", "b"));
    expect(parent.children().length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 5. isArray / isAbstract / setSuper / setPackage
// ---------------------------------------------------------------------------

describe("MetaModel — flags and references", () => {
  it("setIsArray(true) sets isArray to true", () => {
    const m = makeField("string", "f");
    m.setIsArray(true);
    expect(m.isArray).toBe(true);
  });

  it("setIsArray(false) sets isArray back to false", () => {
    const m = makeField("string", "f");
    m.setIsArray(true);
    m.setIsArray(false);
    expect(m.isArray).toBe(false);
  });

  it("setIsAbstract(true) sets isAbstract to true", () => {
    const m = makeField("string", "f");
    m.setIsAbstract(true);
    expect(m.isAbstract).toBe(true);
  });

  it("setIsAbstract(false) sets isAbstract back to false", () => {
    const m = makeField("string", "f");
    m.setIsAbstract(true);
    m.setIsAbstract(false);
    expect(m.isAbstract).toBe(false);
  });

  it("setSuper sets superRef; superResolved remains undefined (Task 6's job)", () => {
    const m = makeField("string", "f");
    m.setSuper("..::common::id");
    expect(m.superRef).toBe("..::common::id");
    expect(m.superResolved).toBeUndefined();
  });

  it("setPackage sets package and affects fqn()", () => {
    const m = makeField("string", "f");
    m.setPackage("my::pkg");
    expect(m.package).toBe("my::pkg");
    expect(m.fqn()).toBe("my::pkg::f");
  });
});

// ---------------------------------------------------------------------------
// 6. Effective view (own + inherited via super chain)
// ---------------------------------------------------------------------------

describe("MetaModel — effectiveAttrs()", () => {
  it("without super returns own attrs as a defensive copy", () => {
    const m = makeObject("simple", "A");
    m.setAttr("x", 1);
    m.setAttr("y", "hello");
    const eff = m.effectiveAttrs();
    expect(eff.get("x")).toBe(1);
    expect(eff.get("y")).toBe("hello");
    // Defensive copy
    eff.set("z", "injected");
    expect(m.hasAttr("z")).toBe(false);
  });

  it("with super returns both own and inherited attrs", () => {
    const parent = makeObject("simple", "Parent");
    parent.setAttr("a", 1);
    const child = makeObject("simple", "Child");
    child.setAttr("b", 2);
    child.setSuperResolved(parent);
    const eff = child.effectiveAttrs();
    expect(eff.get("a")).toBe(1);
    expect(eff.get("b")).toBe(2);
  });

  it("own attr overrides super attr of same name", () => {
    const parent = makeObject("simple", "Parent");
    parent.setAttr("a", "parent-value");
    const child = makeObject("simple", "Child");
    child.setAttr("a", "child-value");
    child.setSuperResolved(parent);
    expect(child.effectiveAttrs().get("a")).toBe("child-value");
  });

  it("multi-level super chain: all attrs accumulate, child wins on conflict", () => {
    const grandparent = makeObject("simple", "Grandparent");
    grandparent.setAttr("x", "grandparent");
    grandparent.setAttr("shared", "from-grandparent");

    const parent = makeObject("simple", "Parent");
    parent.setAttr("y", "parent");
    parent.setAttr("shared", "from-parent");
    parent.setSuperResolved(grandparent);

    const child = makeObject("simple", "Child");
    child.setAttr("z", "child");
    child.setAttr("shared", "from-child");
    child.setSuperResolved(parent);

    const eff = child.effectiveAttrs();
    expect(eff.get("x")).toBe("grandparent");
    expect(eff.get("y")).toBe("parent");
    expect(eff.get("z")).toBe("child");
    expect(eff.get("shared")).toBe("from-child");
  });
});

describe("MetaModel — effectiveChildren()", () => {
  it("without super returns own children as a copy", () => {
    const parent = makeObject("simple", "Parent");
    const c1 = makeField("string", "a");
    parent.addChild(c1);
    const eff = parent.effectiveChildren();
    expect(eff).toContain(c1);
    // It is a copy — pushing to it does not affect internal state
    eff.push(makeField("string", "injected"));
    expect(parent.children().length).toBe(1);
  });

  it("with super includes super's children first, then own appended", () => {
    const superModel = makeObject("simple", "Super");
    const x = makeField("string", "x");
    superModel.addChild(x);

    const child = makeObject("simple", "Child");
    const y = makeField("string", "y");
    child.addChild(y);
    child.setSuperResolved(superModel);

    const eff = child.effectiveChildren();
    expect(eff.length).toBe(2);
    expect(eff[0]).toBe(x); // super's child first
    expect(eff[1]).toBe(y); // own appended
  });

  it("own child with same (type, name) as super child replaces the super child", () => {
    const superModel = makeObject("simple", "Super");
    const superFoo = makeField("string", "foo");
    superFoo.setAttr("origin", "super");
    superModel.addChild(superFoo);

    const child = makeObject("simple", "Child");
    const childFoo = makeField("string", "foo");
    childFoo.setAttr("origin", "child");
    child.addChild(childFoo);
    child.setSuperResolved(superModel);

    const eff = child.effectiveChildren();
    // Only one "foo" field
    const foos = eff.filter((c) => c.name === "foo" && c.type === "field");
    expect(foos.length).toBe(1);
    expect(foos[0]).toBe(childFoo);
    expect((foos[0] as MetaModel).attr("origin")).toBe("child");
  });

  it("override lands in the super's position, not appended", () => {
    const superModel = makeObject("simple", "Super");
    const superFoo = makeField("string", "foo");
    const superBar = makeField("string", "bar");
    superModel.addChild(superFoo);
    superModel.addChild(superBar);

    const child = makeObject("simple", "Child");
    const childFoo = makeField("string", "foo"); // overrides super's foo
    child.addChild(childFoo);
    child.setSuperResolved(superModel);

    const eff = child.effectiveChildren();
    // super's positions: [foo, bar]; child overrides foo in place
    expect(eff.length).toBe(2);
    expect(eff[0]).toBe(childFoo); // override in place of super's foo
    expect(eff[1]).toBe(superBar);
  });

  it("multi-level super chain: all children accumulate, child wins on override", () => {
    const grandparent = makeObject("simple", "Grandparent");
    const gpChild = makeField("string", "gp");
    grandparent.addChild(gpChild);

    const parent = makeObject("simple", "Parent");
    const pChild = makeField("string", "p");
    parent.addChild(pChild);
    parent.setSuperResolved(grandparent);

    const child = makeObject("simple", "Child");
    const cChild = makeField("string", "c");
    child.addChild(cChild);
    child.setSuperResolved(parent);

    const eff = child.effectiveChildren();
    expect(eff.length).toBe(3);
    expect(eff.map((c) => c.name)).toEqual(["gp", "p", "c"]);
  });
});

// ---------------------------------------------------------------------------
// 7. Freeze
// ---------------------------------------------------------------------------

describe("MetaModel — freeze()", () => {
  it("isFrozen() returns false before freeze", () => {
    const m = makeField("string", "f");
    expect(m.isFrozen()).toBe(false);
  });

  it("isFrozen() returns true after freeze", () => {
    const m = makeField("string", "f");
    m.freeze();
    expect(m.isFrozen()).toBe(true);
  });

  it("freeze() is idempotent (can be called twice without error)", () => {
    const m = makeField("string", "f");
    expect(() => {
      m.freeze();
      m.freeze();
    }).not.toThrow();
  });

  it("setAttr throws after freeze with message containing fqn", () => {
    const m = makeField("string", "myField");
    m.setPackage("pkg");
    m.freeze();
    expect(() => m.setAttr("k", "v")).toThrow("pkg::myField");
  });

  it("addChild throws after freeze", () => {
    const m = makeField("string", "f");
    m.freeze();
    expect(() => m.addChild(makeField("string", "child"))).toThrow();
  });

  it("setPackage throws after freeze", () => {
    const m = makeField("string", "f");
    m.freeze();
    expect(() => m.setPackage("pkg")).toThrow();
  });

  it("setSuper throws after freeze", () => {
    const m = makeField("string", "f");
    m.freeze();
    expect(() => m.setSuper("..::ref")).toThrow();
  });

  it("setIsArray throws after freeze", () => {
    const m = makeField("string", "f");
    m.freeze();
    expect(() => m.setIsArray(true)).toThrow();
  });

  it("setIsAbstract throws after freeze", () => {
    const m = makeField("string", "f");
    m.freeze();
    expect(() => m.setIsAbstract(true)).toThrow();
  });

  it("before freeze: mutators work without throwing", () => {
    const m = makeField("string", "f");
    expect(() => {
      m.setAttr("k", "v");
      m.setPackage("pkg");
      m.setSuper("..::ref");
      m.setIsArray(true);
      m.setIsAbstract(true);
      m.addChild(makeField("string", "child"));
    }).not.toThrow();
  });

  it("freeze recursively freezes all children", () => {
    const root = makeObject("simple", "Root");
    const child1 = makeField("string", "a");
    const child2 = makeField("string", "b");
    const grandchild = makeField("integer", "c");
    child1.addChild(grandchild);
    root.addChild(child1);
    root.addChild(child2);

    root.freeze();

    expect(child1.isFrozen()).toBe(true);
    expect(child2.isFrozen()).toBe(true);
    expect(grandchild.isFrozen()).toBe(true);
  });

  it("error message includes model fqn", () => {
    const m = makeField("string", "specificName");
    m.freeze();
    let caught: unknown;
    try {
      m.setAttr("k", "v");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("specificName");
  });
});

// ---------------------------------------------------------------------------
// 8. setSuperResolved mutator
// ---------------------------------------------------------------------------

describe("MetaModel — setSuperResolved()", () => {
  it("sets superResolved and is readable via the getter", () => {
    const parent = makeObject("simple", "Parent");
    const child = makeObject("simple", "Child");
    child.setSuperResolved(parent);
    expect(child.superResolved).toBe(parent);
  });

  it("setSuperResolved throws after freeze with message containing fqn", () => {
    const parent = makeObject("simple", "Parent");
    const child = makeObject("simple", "Child");
    child.setPackage("pkg");
    child.freeze();
    expect(() => child.setSuperResolved(parent)).toThrow("pkg::Child");
  });

  it("setSuperResolved can be called before freeze without throwing", () => {
    const parent = makeObject("simple", "Parent");
    const child = makeObject("simple", "Child");
    expect(() => child.setSuperResolved(parent)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 9. children() is a defensive copy
// ---------------------------------------------------------------------------

describe("MetaModel — children() defensive copy", () => {
  it("snapshot length does not change when a new child is added after capture", () => {
    const parent = makeObject("simple", "Parent");
    const c1 = makeField("string", "first");
    parent.addChild(c1);

    const snapshot = parent.children().length;
    parent.addChild(makeField("string", "second"));

    // The snapshot was taken from a copy; the length it captured is stale
    expect(snapshot).toBe(1);
    expect(parent.children().length).toBe(2);
  });

  it("mutating a cast copy does not affect the internal child list", () => {
    const parent = makeObject("simple", "Parent");
    const c1 = makeField("string", "original");
    parent.addChild(c1);

    // Cast away readonly to simulate an adversarial caller
    const mutableCopy = parent.children() as MetaModel[];
    mutableCopy.push(makeField("string", "injected"));

    // Internal state is unaffected
    expect(parent.children().length).toBe(1);
    expect(parent.childByName("injected")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 10. Cycle protection in effectiveAttrs() and effectiveChildren()
// ---------------------------------------------------------------------------

describe("MetaModel — cycle protection in effective views", () => {
  it("effectiveAttrs() does not infinite-loop on A -> B -> A cycle", () => {
    const A = makeObject("simple", "A");
    A.setAttr("fromA", "a");
    const B = makeObject("simple", "B");
    B.setAttr("fromB", "b");

    // Create a cycle: A super B, B super A
    A.setSuperResolved(B);
    B.setSuperResolved(A);

    // Must not throw / stack-overflow and must return a finite Map
    let result: Map<string, unknown> | undefined;
    expect(() => {
      result = A.effectiveAttrs();
    }).not.toThrow();

    // A's own attrs are always present
    expect(result!.get("fromA")).toBe("a");
    // B's attr is included (one pass through B before the cycle stops)
    expect(result!.get("fromB")).toBe("b");
  });

  it("effectiveChildren() does not infinite-loop on A -> B -> A cycle", () => {
    const A = makeObject("simple", "A");
    const aChild = makeField("string", "childA");
    A.addChild(aChild);

    const B = makeObject("simple", "B");
    const bChild = makeField("string", "childB");
    B.addChild(bChild);

    // Create a cycle: A super B, B super A
    A.setSuperResolved(B);
    B.setSuperResolved(A);

    let result: MetaModel[] | undefined;
    expect(() => {
      result = A.effectiveChildren();
    }).not.toThrow();

    // The result is a finite array containing children from both A and B
    expect(Array.isArray(result)).toBe(true);
    expect(result!.length).toBeGreaterThan(0);
    const names = result!.map((c) => c.name);
    expect(names).toContain("childA");
    expect(names).toContain("childB");
  });
});
