import { describe, test, expect } from "bun:test";
import { encodeRef, decodeRef } from "../src/ref-codec.js";
import { UnsafeNameError, MetadataError } from "../src/errors.js";

describe("encodeRef", () => {
  test("simple PK → 'Entity:value'", () => {
    expect(encodeRef("Post", { id: 42, title: "x" }, ["id"])).toBe("Post:42");
  });

  test("string PK", () => {
    expect(encodeRef("User", { id: "abc-123", name: "x" }, ["id"])).toBe("User:abc-123");
  });

  test("composite PK → 'Entity:v1,v2'", () => {
    expect(encodeRef("UserTag", { userId: 1, tagId: 5 }, ["userId", "tagId"])).toBe("UserTag:1,5");
  });

  test("rejects unsafe entity names", () => {
    expect(() => encodeRef("../evil", { id: 1 }, ["id"])).toThrow(UnsafeNameError);
  });

  test("throws when a PK field is missing on the record", () => {
    expect(() => encodeRef("Post", { title: "no id" }, ["id"])).toThrow(MetadataError);
  });

  test("rejects PK values containing the composite separator", () => {
    expect(() => encodeRef("User", { id: "abc,def" }, ["id"])).toThrow(MetadataError);
  });
});

describe("decodeRef", () => {
  test("simple PK", () => {
    expect(decodeRef("Post:42")).toEqual({ entity: "Post", pkValues: ["42"] });
  });

  test("composite PK", () => {
    expect(decodeRef("UserTag:1,5")).toEqual({ entity: "UserTag", pkValues: ["1", "5"] });
  });

  test("rejects strings missing the separator", () => {
    expect(() => decodeRef("Post42")).toThrow(MetadataError);
  });

  test("rejects unsafe entity names", () => {
    expect(() => decodeRef("../evil:1")).toThrow(UnsafeNameError);
  });

  test("rejects empty PK", () => {
    expect(() => decodeRef("Post:")).toThrow(MetadataError);
  });
});
