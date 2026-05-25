// FR5a — Phase 3: JSON parser populates node.source on every constructed node.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "../src/index.js";
import type { MetaObject } from "../src/core/object/meta-object.js";

describe("FR5a — JSON parser populates node.source", () => {
  test("root node carries format=json + files=[sourceId] + jsonPath", async () => {
    const res = await new MetaDataLoader().load([
      new InMemoryStringSource(
        JSON.stringify({
          "metadata.root": {
            package: "acme",
            children: [
              { "object.entity": { name: "User", children: [
                { "field.string": { name: "id" } },
                { "identity.primary": { "@fields": "id" } },
              ] } },
            ],
          },
        }),
        { id: "meta.json", format: "json" },
      ),
    ]);
    expect(res.errors).toEqual([]);
    expect(res.root.source.format).toBe("json");
    if (res.root.source.format === "json") {
      expect(res.root.source.files).toEqual(["meta.json"]);
      // The root's jsonPath should be the location of the metadata.root key.
      expect(res.root.source.jsonPath).toContain("metadata");
    }
  });

  test("nested object's source has correctly-indexed jsonPath", async () => {
    const res = await new MetaDataLoader().load([
      new InMemoryStringSource(
        JSON.stringify({
          "metadata.root": {
            package: "acme",
            children: [
              { "object.entity": { name: "User", children: [
                { "field.string": { name: "id" } },
                { "identity.primary": { "@fields": "id" } },
              ] } },
            ],
          },
        }),
        { id: "meta.json", format: "json" },
      ),
    ]);
    expect(res.errors).toEqual([]);
    const user = res.root.objects().find((o: MetaObject) => o.name === "User");
    expect(user).toBeDefined();
    expect(user!.source.format).toBe("json");
    if (user!.source.format === "json") {
      expect(user!.source.jsonPath).toContain("children[0]");
      expect(user!.source.jsonPath).toContain("object.entity");
    }
  });

  test("multiple sources: each node's files[0] reflects its origin", async () => {
    const res = await new MetaDataLoader().load([
      new InMemoryStringSource(
        JSON.stringify({ "metadata.root": { package: "acme", children: [
          { "object.entity": { name: "A", children: [
            { "field.string": { name: "x" } },
            { "identity.primary": { "@fields": "x" } },
          ] } },
        ] } }),
        { id: "file-a.json", format: "json" },
      ),
      new InMemoryStringSource(
        JSON.stringify({ "metadata.root": { package: "acme", children: [
          { "object.entity": { name: "B", children: [
            { "field.string": { name: "y" } },
            { "identity.primary": { "@fields": "y" } },
          ] } },
        ] } }),
        { id: "file-b.json", format: "json" },
      ),
    ]);
    expect(res.errors).toEqual([]);
    const a = res.root.objects().find((o: MetaObject) => o.name === "A");
    const b = res.root.objects().find((o: MetaObject) => o.name === "B");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    if (a && a.source.format === "json") expect(a.source.files).toEqual(["file-a.json"]);
    if (b && b.source.format === "json") expect(b.source.files).toEqual(["file-b.json"]);
  });
});
