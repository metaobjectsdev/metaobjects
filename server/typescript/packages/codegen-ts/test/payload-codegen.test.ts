import { describe, test, expect } from "bun:test";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { InMemoryStringSource } from "@metaobjectsdev/metadata";
import { generatePayloadInterfaces, generatePayloadInterfacesBatch, generateRenderHandle } from "../src/payload-codegen.js";

async function loadRoot(children: unknown[]) {
  const res = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify({ "metadata.root": { package: "acme::ai", children } })),
  ]);
  expect(res.errors).toEqual([]);
  return res.root;
}

const model = [
  { "object.value": { name: "PostBrief", children: [{ "field.string": { name: "title" } }] } },
  {
    "object.value": {
      name: "AuthorBrief",
      children: [
        { "field.string": { name: "displayName" } },
        { "field.int": { name: "postCount" } },
        {
          "field.object": {
            name: "posts",
            "isArray": true,
            "@objectRef": "PostBrief",
            children: [{ "origin.collection": { "@via": "Author.posts" } }],
          },
        },
      ],
    },
  },
  {
    "template.prompt": {
      name: "contentStrategyPrompt",
      "@payloadRef": "AuthorBrief",
      "@textRef": "prompt/strategy",
      "@format": "xml",
    },
  },
];

describe("payload-codegen — typed payload interface (types only, no class/VO)", () => {
  test("emits an interface with scalar + nested-array fields and the element interface", async () => {
    const root = await loadRoot(model);
    const out = generatePayloadInterfaces(root, "AuthorBrief");
    expect(out).toContain("export interface AuthorBrief {");
    expect(out).toContain("displayName: string;");
    expect(out).toContain("postCount: number;");
    expect(out).toContain("posts: PostBrief[];");
    expect(out).toContain("export interface PostBrief {");
    expect(out).toContain("title: string;");
  });

  test("scalar isArray fields emit array TS types (string[], number[], boolean[])", async () => {
    const root = await loadRoot([
      {
        "object.value": {
          name: "Lists",
          children: [
            { "field.string":  { name: "tags",     isArray: true } },
            { "field.int":     { name: "scores",   isArray: true } },
            { "field.boolean": { name: "flags",    isArray: true } },
            { "field.string":  { name: "solo" } },
          ],
        },
      },
    ]);
    const out = generatePayloadInterfaces(root, "Lists");
    expect(out).toContain("tags: string[];");
    expect(out).toContain("scores: number[];");
    expect(out).toContain("flags: boolean[];");
    // Non-array scalars stay scalar.
    expect(out).toContain("solo: string;");
  });
});

describe("payload-codegen — generatePayloadInterfacesBatch", () => {
  test("returns empty string for empty input", async () => {
    const root = await loadRoot([
      { "object.value": { name: "X", children: [{ "field.string": { name: "y" } }] } },
    ]);
    expect(generatePayloadInterfacesBatch(root, [])).toBe("");
  });

  test("dedupes a nested type across multiple payloads", async () => {
    const root = await loadRoot([
      { "object.value": { name: "Lens", children: [{ "field.string": { name: "id" } }] } },
      {
        "object.value": {
          name: "A",
          children: [
            { "field.string": { name: "qa" } },
            { "field.object": { name: "items", "@objectRef": "Lens", isArray: true } },
          ],
        },
      },
      {
        "object.value": {
          name: "B",
          children: [
            { "field.string": { name: "qb" } },
            { "field.object": { name: "items", "@objectRef": "Lens", isArray: true } },
          ],
        },
      },
    ]);
    const out = generatePayloadInterfacesBatch(root, ["A", "B"]);
    const lensDeclarations = out.match(/export interface Lens \{/g);
    expect(lensDeclarations).toHaveLength(1);
    expect(out).toContain("export interface A {");
    expect(out).toContain("export interface B {");
    expect(out).toContain("items: Lens[];");
  });
});

describe("payload-codegen — typed render handle", () => {
  test("emits a handle binding @textRef + @format and typing the payload", async () => {
    const root = await loadRoot(model);
    const out = generateRenderHandle(root, "contentStrategyPrompt");
    expect(out).toContain("export function renderContentStrategyPrompt(payload: AuthorBrief, provider: Provider): string");
    expect(out).toContain('ref: "prompt/strategy"');
    expect(out).toContain('format: "xml"');
    expect(out).toContain('from "@metaobjectsdev/render"');
  });
});
