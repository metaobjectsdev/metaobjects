import { describe, test, expect } from "bun:test";
import { loadMetaModel } from "../src/load-meta-model.js";

const DOC = JSON.stringify({
  "metadata.root": {
    package: "acme::blog",
    children: [
      {
        "object.entity": {
          name: "Author",
          extends: "acme::common::BaseEntity",
          "@dbTable": "authors",
          children: [
            { "field.string": { name: "firstName", children: [{ "view.text": { "@title": "Given name" } }] } },
            { "field.timestamp": { name: "createdAt" } },
            { "layout.dataGrid": { name: "default", "@pageSize": 50 } },
          ],
        },
      },
    ],
  },
});

describe("loadMetaModel", () => {
  test("exposes each object by name", () => {
    const model = loadMetaModel(DOC);
    expect(model.objects().map((o) => o.name)).toEqual(["Author"]);
    expect(model.object("Author")?.subType).toBe("entity");
    expect(model.object("Nope")).toBeUndefined();
  });

  test("reads attributes without the @ prefix", () => {
    expect(loadMetaModel(DOC).object("Author")!.attr("dbTable")).toBe("authors");
  });

  test("separates fields, layouts and views by node type", () => {
    const author = loadMetaModel(DOC).object("Author")!;
    expect(author.fields().map((f) => f.name)).toEqual(["firstName", "createdAt"]);
    expect(author.fields()[0]!.subType).toBe("string");
    expect(author.layouts().map((l) => l.name)).toEqual(["default"]);
    expect(author.layouts()[0]!.attr("pageSize")).toBe(50);
    expect(author.fields()[0]!.views()[0]!.attr("title")).toBe("Given name");
  });

  test("IGNORES extends — effective output already inlined inherited members", () => {
    // Resolving `extends` here would double-count. The ref is present in the
    // body and must not be followed.
    const author = loadMetaModel(DOC).object("Author")!;
    expect(author.attr("extends")).toBeUndefined();
    expect(author.fields()).toHaveLength(2);
  });

  test("accepts an already-parsed object as well as a string", () => {
    expect(loadMetaModel(JSON.parse(DOC)).object("Author")?.name).toBe("Author");
  });

  test("an unset or unregistered attr reads undefined", () => {
    expect(loadMetaModel(DOC).object("Author")!.attr("nothingLikeThis")).toBeUndefined();
  });
});
