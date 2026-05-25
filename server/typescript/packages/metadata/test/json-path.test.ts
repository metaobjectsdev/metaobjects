import { describe, test, expect } from "bun:test";
import { JsonPathBuilder } from "../src/json-path.js";

describe("JsonPathBuilder", () => {
  test("root is '$' on an empty builder", () => {
    expect(new JsonPathBuilder().toString()).toBe("$");
  });

  test("simple keys use dot notation when they match identifier rule", () => {
    const b = new JsonPathBuilder();
    b.pushKey("metadata"); b.pushKey("root");
    expect(b.toString()).toBe("$.metadata.root");
  });

  test("special-character keys use bracket-quoted form", () => {
    const b = new JsonPathBuilder();
    b.pushKey("my-package");
    expect(b.toString()).toBe("$['my-package']");
  });

  test("digits-leading keys use bracket form", () => {
    const b = new JsonPathBuilder();
    b.pushKey("123foo");
    expect(b.toString()).toBe("$['123foo']");
  });

  test("array index uses [N] notation", () => {
    const b = new JsonPathBuilder();
    b.pushKey("children");
    b.pushIndex(2);
    expect(b.toString()).toBe("$.children[2]");
  });

  test("nested children/indexes compose correctly", () => {
    const b = new JsonPathBuilder();
    b.pushKey("metadata");
    b.pushKey("root");
    b.pushKey("children");
    b.pushIndex(0);
    b.pushKey("object.entity");
    expect(b.toString()).toBe("$.metadata.root.children[0]['object.entity']");
  });

  test("pop reverses push", () => {
    const b = new JsonPathBuilder();
    b.pushKey("a"); b.pushKey("b"); b.pop();
    expect(b.toString()).toBe("$.a");
    b.pop();
    expect(b.toString()).toBe("$");
  });

  test("at-prefixed attr key uses bracket-quoted form", () => {
    const b = new JsonPathBuilder();
    b.pushKey("@values");
    expect(b.toString()).toBe("$['@values']");
  });

  test("pop on empty builder is a no-op (defensive)", () => {
    const b = new JsonPathBuilder();
    b.pop();
    expect(b.toString()).toBe("$");
  });

  test("toString() does not mutate the builder", () => {
    const b = new JsonPathBuilder();
    b.pushKey("x");
    b.toString(); b.toString();
    expect(b.toString()).toBe("$.x");
  });
});
