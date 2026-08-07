// #210 — template-level payload targets widen to sourceless projections;
// assembly origins leave object.value; nested payload targets stay value-only.
import { describe, test, expect } from "bun:test";
import { MetaDataLoader } from "../src/index.js";
import { ASSEMBLY_ORIGIN_SUBTYPES } from "../src/persistence/origin/origin-constants.js";

function loadJson(children: unknown[]) {
  return MetaDataLoader.fromString(
    JSON.stringify({ "metadata.root": { package: "t::ai", children } }),
    "json",
  );
}

const authorEntity = {
  "object.entity": {
    name: "Author",
    children: [
      { "source.rdb": { "@table": "authors" } },
      { "field.uuid": { name: "id" } },
      { "field.string": { name: "name" } },
      { "identity.primary": { name: "pk", "@fields": ["id"] } },
    ],
  },
};

describe("#210 — @payloadRef/@responseRef accept a sourceless object.projection", () => {
  test("@payloadRef → sourceless projection loads clean", async () => {
    const r = await loadJson([
      authorEntity,
      {
        "object.projection": {
          name: "AuthorPayload",
          children: [
            { "field.string": { name: "name", extends: "t::ai::Author.name" } },
            { "field.string": { name: "summary" } },
          ],
        },
      },
      { "template.prompt": { name: "P", "@payloadRef": "AuthorPayload", "@textRef": "p/x", "@format": "xml" } },
    ]);
    expect(r.errors).toEqual([]);
  });

  test("@payloadRef → SOURCED projection is ERR_INVALID_TEMPLATE", async () => {
    const r = await loadJson([
      authorEntity,
      {
        "object.projection": {
          name: "AuthorView",
          children: [
            { "source.rdb": { "@kind": "view", "@view": "v_author" } },
            { "field.string": { name: "name", extends: "t::ai::Author.name" } },
          ],
        },
      },
      { "template.prompt": { name: "P", "@payloadRef": "AuthorView", "@textRef": "p/x", "@format": "xml" } },
    ]);
    const codes = r.errors.map((e) => (e as { code?: string }).code);
    expect(codes).toContain("ERR_INVALID_TEMPLATE");
  });

  test("@responseRef → sourceless projection loads clean", async () => {
    const r = await loadJson([
      authorEntity,
      { "object.value": { name: "ReqVO", children: [{ "field.string": { name: "q" } }] } },
      {
        "object.projection": {
          name: "AuthorAnswer",
          children: [{ "field.string": { name: "name", extends: "t::ai::Author.name" } }],
        },
      },
      { "template.prompt": { name: "P", "@payloadRef": "ReqVO", "@responseRef": "AuthorAnswer", "@textRef": "p/x", "@format": "xml" } },
    ]);
    expect(r.errors).toEqual([]);
  });
});

describe("#210 — assembly origins are illegal on an object.value host", () => {
  const originNode: Record<string, unknown> = {
    aggregate: { "origin.aggregate": { "@agg": "count", "@of": "t::ai::Author.id", "@via": "t::ai::Author.books" } },
    computed: { "origin.computed": { "@expr": { op: "isNotNull", arg: { field: "name" } } } },
    collection: { "origin.collection": { "@via": "t::ai::Author.posts" } },
    first: { "origin.first": { "@of": "t::ai::Author.name", "@via": "t::ai::Author.posts", "@orderBy": ["name:desc"] } },
  };

  for (const sub of ASSEMBLY_ORIGIN_SUBTYPES) {
    test(`origin.${sub} on a value-hosted field → ERR_SUBTYPE_RULE_VIOLATION`, async () => {
      const fieldDecl =
        sub === "collection"
          ? { "field.object": { name: "x", isArray: true, "@objectRef": "t::ai::NoteVO", children: [originNode[sub]] } }
          : sub === "computed"
            ? { "field.boolean": { name: "x", children: [originNode[sub]] } }
            : sub === "first"
              ? { "field.string": { name: "x", children: [originNode[sub]] } }
              : { "field.int": { name: "x", children: [originNode[sub]] } };
      const r = await loadJson([
        { "object.value": { name: "NoteVO", children: [{ "field.string": { name: "n" } }] } },
        { "object.value": { name: "Bad", children: [fieldDecl] } },
      ]);
      const codes = r.errors.map((e) => (e as { code?: string }).code);
      expect(codes).toContain("ERR_SUBTYPE_RULE_VIOLATION");
    });
  }

  test("origin.passthrough on a value-hosted field STAYS legal (FR-015 lineage)", async () => {
    const r = await loadJson([
      authorEntity,
      {
        "object.value": {
          name: "Args",
          children: [
            { "field.string": { name: "authorName", children: [{ "origin.passthrough": { "@from": "t::ai::Author.name" } }] } },
          ],
        },
      },
    ]);
    expect(r.errors).toEqual([]);
  });
});

describe("#210 — nested payload targets stay value-only", () => {
  test("payload field.object @objectRef → object.entity is ERR_SUBTYPE_RULE_VIOLATION", async () => {
    const r = await loadJson([
      authorEntity,
      {
        "object.value": {
          name: "ReviewRequest",
          children: [
            { "field.string": { name: "instructions" } },
            { "field.object": { name: "author", "@objectRef": "t::ai::Author" } },
          ],
        },
      },
      { "template.prompt": { name: "P", "@payloadRef": "ReviewRequest", "@textRef": "p/x", "@format": "xml" } },
    ]);
    const codes = r.errors.map((e) => (e as { code?: string }).code);
    expect(codes).toContain("ERR_SUBTYPE_RULE_VIOLATION");
  });

  test("payload field.object @objectRef → sourceless projection is ALSO rejected (nested is value-only)", async () => {
    const r = await loadJson([
      authorEntity,
      {
        "object.projection": {
          name: "AuthorBrief",
          children: [{ "field.string": { name: "name", extends: "t::ai::Author.name" } }],
        },
      },
      {
        "object.value": {
          name: "ReviewRequest",
          children: [{ "field.object": { name: "author", "@objectRef": "t::ai::AuthorBrief" } }],
        },
      },
      { "template.prompt": { name: "P", "@payloadRef": "ReviewRequest", "@textRef": "p/x", "@format": "xml" } },
    ]);
    const codes = r.errors.map((e) => (e as { code?: string }).code);
    expect(codes).toContain("ERR_SUBTYPE_RULE_VIOLATION");
  });

  test("payload field.object @objectRef → object.value nests clean (and transitively)", async () => {
    const r = await loadJson([
      { "object.value": { name: "Inner", children: [{ "field.string": { name: "s" } }] } },
      { "object.value": { name: "Mid", children: [{ "field.object": { name: "inner", "@objectRef": "t::ai::Inner" } }] } },
      { "object.value": { name: "Outer", children: [{ "field.object": { name: "mid", "@objectRef": "t::ai::Mid" } }] } },
      { "template.prompt": { name: "P", "@payloadRef": "Outer", "@textRef": "p/x", "@format": "xml" } },
    ]);
    expect(r.errors).toEqual([]);
  });
});
