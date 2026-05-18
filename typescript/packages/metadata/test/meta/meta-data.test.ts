import { describe, it, expect, beforeEach } from "bun:test";
import { MetaData } from "../../src/meta/meta-data.js";
import { TypeId } from "../../src/registry.js";
import {
  TYPE_FIELD,
  TYPE_OBJECT,
  FIELD_SUBTYPE_STRING,
} from "../../src/constants.js";

// MetaData is abstract — a minimal concrete subclass is the smallest thing
// that exercises the shared base-node behavior. The construction API is
// `new <ConcreteClass>(typeId, name)` for every node in the typed tree.
class TestNode extends MetaData {}

function makeField(subType: string, name: string): MetaData {
  return new TestNode(new TypeId(TYPE_FIELD, subType), name);
}

function makeObject(subType: string, name: string): MetaData {
  return new TestNode(new TypeId(TYPE_OBJECT, subType), name);
}

describe("MetaData base", () => {
  it("holds type, subType, name", () => {
    const n = new TestNode(new TypeId("object", "entity"), "Widget");
    expect(n.type).toBe("object");
    expect(n.subType).toBe("entity");
    expect(n.name).toBe("Widget");
  });

  it("cached() memoizes only after freeze", () => {
    const n = new TestNode(new TypeId("object", "entity"), "Widget");
    let calls = 0;
    const compute = () => { calls++; return calls; };
    expect((n as unknown as { cached: <T>(k: string, c: () => T) => T }).cached("k", compute)).toBe(1);
    expect((n as unknown as { cached: <T>(k: string, c: () => T) => T }).cached("k", compute)).toBe(2); // not frozen — recomputes
    n.freeze();
    const first = (n as unknown as { cached: <T>(k: string, c: () => T) => T }).cached("k2", compute);
    const second = (n as unknown as { cached: <T>(k: string, c: () => T) => T }).cached("k2", compute);
    expect(first).toBe(second); // frozen — memoized
  });

  it("freeze() blocks addChild", () => {
    const n = new TestNode(new TypeId("object", "entity"), "Widget");
    n.freeze();
    expect(() => n.addChild(new TestNode(new TypeId("field", "string"), "x"))).toThrow();
  });

  it("effectiveAttrs() returns a fresh defensive copy on each call even when frozen", () => {
    const n = new TestNode(new TypeId("object", "entity"), "Widget");
    n.setAttr("color", "blue");
    n.freeze();
    const a = n.effectiveAttrs();
    const b = n.effectiveAttrs();
    expect(a).not.toBe(b);
    expect(a.get("color")).toBe("blue");
    expect(b.get("color")).toBe("blue");
  });
});

// ---------------------------------------------------------------------------
// Construction & defaults
// (ported from the deleted test/model.test.ts — base-node behavior)
// ---------------------------------------------------------------------------

describe("MetaData — construction", () => {
  it("exposes typeId, name, type, and subType", () => {
    const m = new TestNode(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING), "myField");
    expect(m.typeId.type).toBe(TYPE_FIELD);
    expect(m.typeId.subType).toBe(FIELD_SUBTYPE_STRING);
    expect(m.name).toBe("myField");
    expect(m.type).toBe(TYPE_FIELD);
    expect(m.subType).toBe(FIELD_SUBTYPE_STRING);
  });

  it("typeId accessor returns the TypeId instance passed in", () => {
    const tid = new TypeId(TYPE_OBJECT, "entity");
    const m = new TestNode(tid, "myObj");
    expect(m.typeId).toBe(tid);
  });

  it("defaults: isArray is false", () => {
    expect(makeField("string", "f").isArray).toBe(false);
  });

  it("defaults: isAbstract is false", () => {
    expect(makeField("string", "f").isAbstract).toBe(false);
  });

  it("defaults: package is undefined", () => {
    expect(makeField("string", "f").package).toBeUndefined();
  });

  it("defaults: superRef is undefined", () => {
    expect(makeField("string", "f").superRef).toBeUndefined();
  });

  it("defaults: superData is undefined", () => {
    expect(makeField("string", "f").superData).toBeUndefined();
  });

  it("defaults: ownAttrs() is empty", () => {
    expect(makeField("string", "f").ownAttrs().size).toBe(0);
  });

  it("defaults: ownChildren() is empty", () => {
    expect(makeField("string", "f").ownChildren().length).toBe(0);
  });

  it("defaults: isFrozen() is false", () => {
    expect(makeField("string", "f").isFrozen()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fqn()
// ---------------------------------------------------------------------------

describe("MetaData — fqn()", () => {
  it("without package returns just the name", () => {
    expect(makeField("string", "myField").fqn()).toBe("myField");
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
// Attributes
// ---------------------------------------------------------------------------

describe("MetaData — attributes", () => {
  let m: MetaData;

  beforeEach(() => {
    m = makeField("string", "f");
  });

  it("setAttr then ownAttr returns the value", () => {
    m.setAttr("label", "My Label");
    expect(m.ownAttr("label")).toBe("My Label");
  });

  it("ownAttr returns undefined for an unset key", () => {
    expect(m.ownAttr("missing")).toBeUndefined();
  });

  it("overwriting setAttr replaces the value", () => {
    m.setAttr("k", "first");
    m.setAttr("k", "second");
    expect(m.ownAttr("k")).toBe("second");
  });

  it("ownHasAttr returns true after setAttr", () => {
    m.setAttr("k", "v");
    expect(m.ownHasAttr("k")).toBe(true);
  });

  it("ownHasAttr returns false for unset key", () => {
    expect(m.ownHasAttr("missing")).toBe(false);
  });

  it("ownAttrs() returns all set attributes", () => {
    m.setAttr("a", 1);
    m.setAttr("b", true);
    m.setAttr("c", "hello");
    const map = m.ownAttrs();
    expect(map.get("a")).toBe(1);
    expect(map.get("b")).toBe(true);
    expect(map.get("c")).toBe("hello");
    expect(map.size).toBe(3);
  });

  it("ownAttrs() returns a defensive copy — mutating it does not affect the model", () => {
    m.setAttr("x", "original");
    const copy = m.ownAttrs();
    copy.set("x", "mutated");
    copy.set("injected", "val");
    expect(m.ownAttr("x")).toBe("original");
    expect(m.ownHasAttr("injected")).toBe(false);
  });

  it("supports string AttrValue", () => {
    m.setAttr("s", "hello");
    expect(m.ownAttr("s")).toBe("hello");
  });

  it("supports number AttrValue", () => {
    m.setAttr("n", 42);
    expect(m.ownAttr("n")).toBe(42);
  });

  it("supports boolean AttrValue", () => {
    m.setAttr("b", false);
    expect(m.ownAttr("b")).toBe(false);
  });

  it("supports string[] AttrValue", () => {
    m.setAttr("arr", ["a", "b", "c"]);
    expect(m.ownAttr("arr")).toEqual(["a", "b", "c"]);
  });
});

// ---------------------------------------------------------------------------
// Children
// ---------------------------------------------------------------------------

describe("MetaData — children", () => {
  let parent: MetaData;

  beforeEach(() => {
    parent = makeObject("entity", "Parent");
  });

  it("addChild then ownChildren() includes the child", () => {
    const c = makeField("string", "title");
    parent.addChild(c);
    expect(parent.ownChildren()).toContain(c);
  });

  it("ownChildren() preserves insertion order", () => {
    const c1 = makeField("string", "first");
    const c2 = makeField("int", "second");
    const c3 = makeField("boolean", "third");
    parent.addChild(c1);
    parent.addChild(c2);
    parent.addChild(c3);
    const list = parent.ownChildren();
    expect(list[0]).toBe(c1);
    expect(list[1]).toBe(c2);
    expect(list[2]).toBe(c3);
  });

  it("ownChildrenOfType filters by type", () => {
    const f1 = makeField("string", "a");
    const f2 = makeField("int", "b");
    const o1 = makeObject("entity", "c");
    parent.addChild(f1);
    parent.addChild(f2);
    parent.addChild(o1);
    const fields = parent.ownChildrenOfType("field");
    expect(fields).toContain(f1);
    expect(fields).toContain(f2);
    expect(fields).not.toContain(o1);
  });

  it("ownChildrenOfType returns empty array when no match", () => {
    parent.addChild(makeField("string", "a"));
    expect(parent.ownChildrenOfType("nonexistent")).toEqual([]);
  });

  it("ownChildrenOfSubType filters by both type and subType", () => {
    const f1 = makeField("string", "a");
    const f2 = makeField("int", "b");
    parent.addChild(f1);
    parent.addChild(f2);
    const strings = parent.ownChildrenOfSubType("field", "string");
    expect(strings).toContain(f1);
    expect(strings).not.toContain(f2);
  });

  it("ownChildByName returns first matching child by name", () => {
    const c1 = makeField("string", "foo");
    const c2 = makeField("int", "foo"); // same name, different subType
    parent.addChild(c1);
    parent.addChild(c2);
    expect(parent.ownChildByName("foo")).toBe(c1);
  });

  it("ownChildByName returns undefined when no match", () => {
    expect(parent.ownChildByName("nonexistent")).toBeUndefined();
  });

  it("ownChildByTypeAndName returns first child matching both type and name", () => {
    const f = makeField("string", "foo");
    const o = makeObject("entity", "foo");
    parent.addChild(f);
    parent.addChild(o);
    expect(parent.ownChildByTypeAndName("field", "foo")).toBe(f);
    expect(parent.ownChildByTypeAndName("object", "foo")).toBe(o);
  });

  it("ownChildByTypeAndName returns undefined when no match", () => {
    parent.addChild(makeField("string", "a"));
    expect(parent.ownChildByTypeAndName("field", "missing")).toBeUndefined();
    expect(parent.ownChildByTypeAndName("object", "a")).toBeUndefined();
  });

  it("ownChildren() length matches number of added children", () => {
    parent.addChild(makeField("string", "a"));
    parent.addChild(makeField("string", "b"));
    expect(parent.ownChildren().length).toBe(2);
  });

  it("ownChildren() is a defensive copy — a later addChild does not change a captured snapshot", () => {
    const c1 = makeField("string", "first");
    parent.addChild(c1);
    const snapshot = parent.ownChildren().length;
    parent.addChild(makeField("string", "second"));
    expect(snapshot).toBe(1);
    expect(parent.ownChildren().length).toBe(2);
  });

  it("mutating a cast copy of ownChildren() does not affect internal state", () => {
    const c1 = makeField("string", "original");
    parent.addChild(c1);
    const mutableCopy = parent.ownChildren() as MetaData[];
    mutableCopy.push(makeField("string", "injected"));
    expect(parent.ownChildren().length).toBe(1);
    expect(parent.ownChildByName("injected")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Flags and references
// ---------------------------------------------------------------------------

describe("MetaData — flags and references", () => {
  it("setIsArray(true) then setIsArray(false) toggles isArray", () => {
    const m = makeField("string", "f");
    m.setIsArray(true);
    expect(m.isArray).toBe(true);
    m.setIsArray(false);
    expect(m.isArray).toBe(false);
  });

  it("setIsAbstract(true) then setIsAbstract(false) toggles isAbstract", () => {
    const m = makeField("string", "f");
    m.setIsAbstract(true);
    expect(m.isAbstract).toBe(true);
    m.setIsAbstract(false);
    expect(m.isAbstract).toBe(false);
  });

  it("setSuper sets superRef; superData stays undefined until resolution", () => {
    const m = makeField("string", "f");
    m.setSuper("..::common::id");
    expect(m.superRef).toBe("..::common::id");
    expect(m.superData).toBeUndefined();
  });

  it("setPackage sets package and affects fqn()", () => {
    const m = makeField("string", "f");
    m.setPackage("my::pkg");
    expect(m.package).toBe("my::pkg");
    expect(m.fqn()).toBe("my::pkg::f");
  });

  it("setSuperResolved sets superData, readable via the getter", () => {
    const parent = makeObject("entity", "Parent");
    const child = makeObject("entity", "Child");
    child.setSuperResolved(parent);
    expect(child.superData).toBe(parent);
  });

  it("setSuperResolved can be called before freeze without throwing", () => {
    const parent = makeObject("entity", "Parent");
    const child = makeObject("entity", "Child");
    expect(() => child.setSuperResolved(parent)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Effective view: own + inherited via the super chain
// ---------------------------------------------------------------------------

describe("MetaData — effectiveAttrs()", () => {
  it("without super returns own attrs as a defensive copy", () => {
    const m = makeObject("entity", "A");
    m.setAttr("x", 1);
    m.setAttr("y", "hello");
    const eff = m.effectiveAttrs();
    expect(eff.get("x")).toBe(1);
    expect(eff.get("y")).toBe("hello");
    eff.set("z", "injected");
    expect(m.ownHasAttr("z")).toBe(false);
  });

  it("with super returns both own and inherited attrs", () => {
    const parent = makeObject("entity", "Parent");
    parent.setAttr("a", 1);
    const child = makeObject("entity", "Child");
    child.setAttr("b", 2);
    child.setSuperResolved(parent);
    const eff = child.effectiveAttrs();
    expect(eff.get("a")).toBe(1);
    expect(eff.get("b")).toBe(2);
  });

  it("own attr overrides super attr of the same name", () => {
    const parent = makeObject("entity", "Parent");
    parent.setAttr("a", "parent-value");
    const child = makeObject("entity", "Child");
    child.setAttr("a", "child-value");
    child.setSuperResolved(parent);
    expect(child.effectiveAttrs().get("a")).toBe("child-value");
  });

  it("multi-level super chain: all attrs accumulate, child wins on conflict", () => {
    const grandparent = makeObject("entity", "Grandparent");
    grandparent.setAttr("x", "grandparent");
    grandparent.setAttr("shared", "from-grandparent");

    const parent = makeObject("entity", "Parent");
    parent.setAttr("y", "parent");
    parent.setAttr("shared", "from-parent");
    parent.setSuperResolved(grandparent);

    const child = makeObject("entity", "Child");
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

describe("MetaData — children() (effective merge behaviour)", () => {
  it("without super returns own children as a copy", () => {
    const parent = makeObject("entity", "Parent");
    const c1 = makeField("string", "a");
    parent.addChild(c1);
    const eff = parent.children();
    expect(eff).toContain(c1);
    eff.push(makeField("string", "injected"));
    expect(parent.ownChildren().length).toBe(1);
  });

  it("with super includes super's children first, then own appended", () => {
    const superModel = makeObject("entity", "Super");
    const x = makeField("string", "x");
    superModel.addChild(x);

    const child = makeObject("entity", "Child");
    const y = makeField("string", "y");
    child.addChild(y);
    child.setSuperResolved(superModel);

    const eff = child.children();
    expect(eff.length).toBe(2);
    expect(eff[0]).toBe(x);
    expect(eff[1]).toBe(y);
  });

  it("own child with same (type, name) as a super child replaces it in the super's position", () => {
    const superModel = makeObject("entity", "Super");
    const superFoo = makeField("string", "foo");
    const superBar = makeField("string", "bar");
    superModel.addChild(superFoo);
    superModel.addChild(superBar);

    const child = makeObject("entity", "Child");
    const childFoo = makeField("string", "foo");
    childFoo.setAttr("origin", "child");
    child.addChild(childFoo);
    child.setSuperResolved(superModel);

    const eff = child.children();
    expect(eff.length).toBe(2);
    expect(eff[0]).toBe(childFoo); // override in place of super's foo
    expect(eff[1]).toBe(superBar);
    expect((eff[0] as MetaData).ownAttr("origin")).toBe("child");
  });

  it("multi-level super chain: all children accumulate", () => {
    const grandparent = makeObject("entity", "Grandparent");
    grandparent.addChild(makeField("string", "gp"));

    const parent = makeObject("entity", "Parent");
    parent.addChild(makeField("string", "p"));
    parent.setSuperResolved(grandparent);

    const child = makeObject("entity", "Child");
    child.addChild(makeField("string", "c"));
    child.setSuperResolved(parent);

    const eff = child.children();
    expect(eff.length).toBe(3);
    expect(eff.map((c) => c.name)).toEqual(["gp", "p", "c"]);
  });
});

// ---------------------------------------------------------------------------
// Cycle protection in effectiveAttrs() / children()
// ---------------------------------------------------------------------------

describe("MetaData — cycle protection in effective views", () => {
  it("effectiveAttrs() does not infinite-loop on an A -> B -> A cycle", () => {
    const A = makeObject("entity", "A");
    A.setAttr("fromA", "a");
    const B = makeObject("entity", "B");
    B.setAttr("fromB", "b");
    A.setSuperResolved(B);
    B.setSuperResolved(A);

    let result: Map<string, unknown> | undefined;
    expect(() => { result = A.effectiveAttrs(); }).not.toThrow();
    expect(result!.get("fromA")).toBe("a");
    expect(result!.get("fromB")).toBe("b");
  });

  it("children() does not infinite-loop on an A -> B -> A cycle", () => {
    const A = makeObject("entity", "A");
    A.addChild(makeField("string", "childA"));
    const B = makeObject("entity", "B");
    B.addChild(makeField("string", "childB"));
    A.setSuperResolved(B);
    B.setSuperResolved(A);

    let result: MetaData[] | undefined;
    expect(() => { result = A.children(); }).not.toThrow();
    expect(Array.isArray(result)).toBe(true);
    expect(result!.length).toBeGreaterThan(0);
    const names = result!.map((c) => c.name);
    expect(names).toContain("childA");
    expect(names).toContain("childB");
  });
});

// ---------------------------------------------------------------------------
// Freeze lifecycle
// ---------------------------------------------------------------------------

describe("MetaData — freeze()", () => {
  it("isFrozen() returns false before freeze and true after", () => {
    const m = makeField("string", "f");
    expect(m.isFrozen()).toBe(false);
    m.freeze();
    expect(m.isFrozen()).toBe(true);
  });

  it("freeze() is idempotent (can be called twice without error)", () => {
    const m = makeField("string", "f");
    expect(() => { m.freeze(); m.freeze(); }).not.toThrow();
  });

  it("setAttr throws after freeze with a message containing the fqn", () => {
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

  it("setSuperResolved throws after freeze with a message containing the fqn", () => {
    const parent = makeObject("entity", "Parent");
    const child = makeObject("entity", "Child");
    child.setPackage("pkg");
    child.freeze();
    expect(() => child.setSuperResolved(parent)).toThrow("pkg::Child");
  });

  it("before freeze: all mutators work without throwing", () => {
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

  it("freeze recursively freezes all descendants", () => {
    const root = makeObject("entity", "Root");
    const child1 = makeField("string", "a");
    const child2 = makeField("string", "b");
    const grandchild = makeField("int", "c");
    child1.addChild(grandchild);
    root.addChild(child1);
    root.addChild(child2);

    root.freeze();

    expect(child1.isFrozen()).toBe(true);
    expect(child2.isFrozen()).toBe(true);
    expect(grandchild.isFrozen()).toBe(true);
  });
});

describe("MetaData — parent / root", () => {
  it("addChild sets the child's parent; root() walks to the top", () => {
    const root = new TestNode(new TypeId("metadata", "root"), "");
    const mid = makeObject("entity", "Mid");
    const leaf = makeField("string", "Leaf");
    root.addChild(mid);
    mid.addChild(leaf);

    expect(mid.parent).toBe(root);
    expect(leaf.parent).toBe(mid);
    expect(root.parent).toBeUndefined();

    expect(leaf.root()).toBe(root);
    expect(mid.root()).toBe(root);
    expect(root.root()).toBe(root);
  });
});

describe("MetaData — effective child accessors (default)", () => {
  it("children() includes inherited children from the super chain", () => {
    const superModel = makeObject("entity", "Super");
    superModel.addChild(makeField("string", "x"));
    const child = makeObject("entity", "Child");
    child.addChild(makeField("string", "y"));
    child.setSuperResolved(superModel);
    expect(child.children().map((c) => c.name)).toEqual(["x", "y"]);
  });

  it("ownChildren() excludes inherited children", () => {
    const superModel = makeObject("entity", "Super");
    superModel.addChild(makeField("string", "x"));
    const child = makeObject("entity", "Child");
    child.addChild(makeField("string", "y"));
    child.setSuperResolved(superModel);
    expect(child.ownChildren().map((c) => c.name)).toEqual(["y"]);
  });

  it("childrenOfType() includes inherited children of that type", () => {
    const superModel = makeObject("entity", "Super");
    superModel.addChild(makeField("string", "inheritedField"));
    const child = makeObject("entity", "Child");
    child.addChild(makeField("string", "ownField"));
    child.setSuperResolved(superModel);
    expect(child.childrenOfType(TYPE_FIELD).map((c) => c.name)).toEqual([
      "inheritedField",
      "ownField",
    ]);
  });

  it("ownChildrenOfType() excludes inherited", () => {
    const superModel = makeObject("entity", "Super");
    superModel.addChild(makeField("string", "inheritedField"));
    const child = makeObject("entity", "Child");
    child.addChild(makeField("string", "ownField"));
    child.setSuperResolved(superModel);
    expect(child.ownChildrenOfType(TYPE_FIELD).map((c) => c.name)).toEqual([
      "ownField",
    ]);
  });

  it("childrenOfSubType() includes inherited children of that type+subType", () => {
    const superModel = makeObject("entity", "Super");
    superModel.addChild(makeField("string", "s1"));
    superModel.addChild(makeField("int", "i1"));
    const child = makeObject("entity", "Child");
    child.addChild(makeField("string", "s2"));
    child.setSuperResolved(superModel);
    expect(
      child.childrenOfSubType(TYPE_FIELD, "string").map((c) => c.name),
    ).toEqual(["s1", "s2"]);
  });

  it("childByName() finds an inherited child; ownChildByName() does not", () => {
    const superModel = makeObject("entity", "Super");
    superModel.addChild(makeField("string", "inherited"));
    const child = makeObject("entity", "Child");
    child.setSuperResolved(superModel);
    expect(child.childByName("inherited")?.name).toBe("inherited");
    expect(child.ownChildByName("inherited")).toBeUndefined();
  });

  it("childByTypeAndName() finds an inherited child; ownChildByTypeAndName() does not", () => {
    const superModel = makeObject("entity", "Super");
    superModel.addChild(makeField("string", "inherited"));
    const child = makeObject("entity", "Child");
    child.setSuperResolved(superModel);
    expect(child.childByTypeAndName(TYPE_FIELD, "inherited")?.name).toBe(
      "inherited",
    );
    expect(
      child.ownChildByTypeAndName(TYPE_FIELD, "inherited"),
    ).toBeUndefined();
  });

  it("childByTypeAndName() returns the own override when child and super share (type, name)", () => {
    const superModel = makeObject("entity", "Super");
    const superFoo = makeField("string", "foo");
    superFoo.setAttr("origin", "super");
    superModel.addChild(superFoo);
    const child = makeObject("entity", "Child");
    const childFoo = makeField("string", "foo");
    childFoo.setAttr("origin", "child");
    child.addChild(childFoo);
    child.setSuperResolved(superModel);
    expect(child.childByTypeAndName(TYPE_FIELD, "foo")?.ownAttr("origin")).toBe(
      "child",
    );
  });
});
