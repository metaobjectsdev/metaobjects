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
  { "object.value": { name: "PostBrief", children: [{ "field.string": { name: "title", "@required": true } }] } },
  {
    "object.value": {
      name: "AuthorBrief",
      children: [
        { "field.string": { name: "displayName", "@required": true } },
        { "field.int": { name: "postCount", "@required": true } },
        {
          "field.object": {
            name: "posts",
            "isArray": true,
            "@objectRef": "PostBrief",
            "@required": true,
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
            { "field.string":  { name: "tags",     isArray: true, "@required": true } },
            { "field.int":     { name: "scores",   isArray: true, "@required": true } },
            { "field.boolean": { name: "flags",    isArray: true, "@required": true } },
            { "field.string":  { name: "solo",                    "@required": true } },
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

  test("fields without required:true emit as optional + nullable (TS `?: T | null`)", async () => {
    const root = await loadRoot([
      {
        "object.value": {
          name: "MixedOptional",
          children: [
            { "field.string": { name: "mandatory", "@required": true } },
            { "field.string": { name: "discretionary" } },                  // implicit not-required
            { "field.string": { name: "explicitlyOptional", "@required": false } },
          ],
        },
      },
    ]);
    const out = generatePayloadInterfaces(root, "MixedOptional");
    expect(out).toContain("mandatory: string;");
    expect(out).toContain("discretionary?: string | null;");
    expect(out).toContain("explicitlyOptional?: string | null;");
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
      { "object.value": { name: "Lens", children: [{ "field.string": { name: "id", "@required": true } }] } },
      {
        "object.value": {
          name: "A",
          children: [
            { "field.string": { name: "qa", "@required": true } },
            { "field.object": { name: "items", "@objectRef": "Lens", isArray: true, "@required": true } },
          ],
        },
      },
      {
        "object.value": {
          name: "B",
          children: [
            { "field.string": { name: "qb", "@required": true } },
            { "field.object": { name: "items", "@objectRef": "Lens", isArray: true, "@required": true } },
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

describe("payload-codegen — FQN @objectRef (FR-032/ADR-0041) emits bare TS names", () => {
  // Regression: under package declaration, a nested @objectRef canonicalizes to an FQN
  // (`pkg::Name`). The emitter must strip the package for the emitted TS type AND the
  // generated interface name — an FQN contains `::`, which is invalid TypeScript. (The
  // 0.15.14 ADR-0041 fix extended FQN canonicalization into the payload tree but missed
  // promptRender's generated-type emission; this pins it.)
  test("a nested @objectRef given as an FQN emits a bare type + bare interface name (no `::`)", async () => {
    const root = await loadRoot([
      { "object.value": { name: "Note", children: [{ "field.string": { name: "text", "@required": true } }] } },
      {
        "object.value": {
          name: "Report",
          children: [
            { "field.string": { name: "title", "@required": true } },
            { "field.object": { name: "notes", "@objectRef": "acme::ai::Note", isArray: true, "@required": true } },
          ],
        },
      },
    ]);
    const out = generatePayloadInterfacesBatch(root, ["Report"]);
    // The defect emitted `notes: acme::ai::Note[];` and `export interface acme::ai::Note`.
    expect(out).not.toContain("::");
    expect(out).toContain("export interface Report {");
    expect(out).toContain("notes: Note[];");
    expect(out).toContain("export interface Note {");
    expect(out).toContain("text: string;");
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
