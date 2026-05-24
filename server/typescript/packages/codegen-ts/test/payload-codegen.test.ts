import { describe, test, expect } from "bun:test";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { InMemorySource } from "@metaobjectsdev/metadata";
import { generatePayloadInterfaces, generateRenderHandle } from "../src/payload-codegen.js";

async function loadRoot(children: unknown[]) {
  const res = await new MetaDataLoader().load([
    new InMemorySource(JSON.stringify({ "metadata.root": { package: "acme::ai", children } })),
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
