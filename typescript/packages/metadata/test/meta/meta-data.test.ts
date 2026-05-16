import { describe, it, expect } from "bun:test";
import { MetaData } from "../../src/meta/meta-data.js";
import { TypeId } from "../../src/registry.js";

class TestNode extends MetaData {}

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
});
