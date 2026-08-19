// server/typescript/packages/codegen-ts/test/templates/output-parser.test.ts
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { renderOutputParser } from "../../src/templates/output-parser.js";

async function loadRoot(children: unknown[]) {
  const res = await new MetaDataLoader().load([
    new InMemoryStringSource(
      JSON.stringify({ "metadata.root": { package: "acme::ai", children } }),
      { id: "meta.json", format: "json" },
    ),
  ]);
  expect(res.errors).toEqual([]);
  return res.root;
}

// Same as loadRoot but tolerates loader errors — used to exercise post-load
// renderer error paths (the loader pre-validates some refs, but the renderer
// must still defend its own contract).
async function loadRootAllowErrors(children: unknown[]) {
  const res = await new MetaDataLoader().load([
    new InMemoryStringSource(
      JSON.stringify({ "metadata.root": { package: "acme::ai", children } }),
      { id: "meta.json", format: "json" },
    ),
  ]);
  return res.root;
}

describe("renderOutputParser()", () => {
  test("emits Zod schema + dual-API parse/safeParse for scalar payload", async () => {
    const root = await loadRoot([
      {
        "object.value": {
          name: "NpcResponsePayload",
          children: [
            { "field.string": { name: "name" } },
            { "field.int": { name: "age" } },
          ],
        },
      },
      {
        "template.output": {
          name: "NpcResponseOutput",
          "@payloadRef": "NpcResponsePayload",
          "@textRef": "npc/output",
          "@format": "json",
        },
      },
    ]);
    const out = renderOutputParser(root, "NpcResponseOutput");
    expect(out).toContain('import { z } from "zod"');
    // Self-contained: no cross-file payload import.
    expect(out).not.toContain('./payloads');
    expect(out).toContain("const NpcResponseOutputSchema = z.object({");
    expect(out).toContain("name: z.string()");
    expect(out).toContain("age: z.number().int()");
    expect(out).toContain("export type NpcResponseOutputData = z.infer<typeof NpcResponseOutputSchema>;");
    expect(out).toContain("export function parseNpcResponseOutput(text: string): NpcResponseOutputData");
    expect(out).toContain("export function safeParseNpcResponseOutput(");
    expect(out).toContain("{ success: true; data: NpcResponseOutputData }");
    expect(out).toContain("{ success: false; error: NpcResponseOutputValidationError }");
  });

  test("maps all scalar field subtypes correctly", async () => {
    const root = await loadRoot([
      {
        "object.value": {
          name: "AllScalars",
          children: [
            { "field.string": { name: "s" } },
            { "field.int": { name: "i" } },
            { "field.long": { name: "l" } },
            { "field.double": { name: "d" } },
            { "field.float": { name: "f" } },
            { "field.boolean": { name: "bool" } },
          ],
        },
      },
      {
        "template.output": {
          name: "AllScalarsOutput",
          "@payloadRef": "AllScalars",
          "@textRef": "x/y",
          "@format": "json",
        },
      },
    ]);
    const out = renderOutputParser(root, "AllScalarsOutput");
    expect(out).toContain("s: z.string()");
    expect(out).toContain("i: z.number().int()");
    expect(out).toContain("l: z.number().int()");
    expect(out).toContain("d: z.number()");
    expect(out).toContain("f: z.number()");
    expect(out).toContain("bool: z.boolean()");
  });

  test("emits z.array() for isArray fields", async () => {
    const root = await loadRoot([
      {
        "object.value": {
          name: "ListPayload",
          children: [
            { "field.string": { name: "tags", isArray: true } },
          ],
        },
      },
      {
        "template.output": {
          name: "ListOutput",
          "@payloadRef": "ListPayload",
          "@textRef": "x/y",
          "@format": "json",
        },
      },
    ]);
    const out = renderOutputParser(root, "ListOutput");
    expect(out).toContain("tags: z.array(z.string())");
  });

  test("emits nested object schemas for field.object with @objectRef", async () => {
    const root = await loadRoot([
      {
        "object.value": {
          name: "Inner",
          children: [{ "field.string": { name: "x" } }],
        },
      },
      {
        "object.value": {
          name: "Outer",
          children: [
            {
              "field.object": {
                name: "inner",
                "@objectRef": "Inner",
              },
            },
          ],
        },
      },
      {
        "template.output": {
          name: "OuterOutput",
          "@payloadRef": "Outer",
          "@textRef": "x/y",
          "@format": "json",
        },
      },
    ]);
    const out = renderOutputParser(root, "OuterOutput");
    expect(out).toContain("inner: z.object({");
    expect(out).toContain("x: z.string()");
  });

  test("indents nested object schemas one level deeper than parent fields", async () => {
    // Lock in the exact emitted shape — a nested z.object's fields must sit
    // one indent-step deeper than the parent's fields, and its closing `})`
    // must align with the parent's field column (not the parent's close).
    const root = await loadRoot([
      {
        "object.value": {
          name: "Inner",
          children: [{ "field.string": { name: "x" } }],
        },
      },
      {
        "object.value": {
          name: "Outer",
          children: [
            {
              "field.object": {
                name: "inner",
                "@objectRef": "Inner",
              },
            },
          ],
        },
      },
      {
        "template.output": {
          name: "OuterOutput",
          "@payloadRef": "Outer",
          "@textRef": "x/y",
          "@format": "json",
        },
      },
    ]);
    const out = renderOutputParser(root, "OuterOutput");
    expect(out).toContain(`const OuterOutputSchema = z.object({
  inner: z.object({
    x: z.string(),
  }),
});`);
  });

  test("throws when template name is not a template.output", async () => {
    const root = await loadRoot([
      {
        "object.value": {
          name: "P",
          children: [{ "field.string": { name: "x" } }],
        },
      },
      {
        "template.prompt": {
          name: "notOutput",
          "@payloadRef": "P",
          "@textRef": "x/y",
          "@format": "text",
        },
      },
    ]);
    expect(() => renderOutputParser(root, "notOutput")).toThrow(/not a template\.output/i);
  });

  test("throws when @payloadRef cannot be resolved", async () => {
    // Loader pre-validates @payloadRef, so we use the error-tolerant loader.
    // The renderer must still defend its contract on the post-load tree.
    const root = await loadRootAllowErrors([
      {
        "template.output": {
          name: "BrokenOutput",
          "@payloadRef": "DoesNotExist",
          "@textRef": "x/y",
          "@format": "json",
        },
      },
    ]);
    expect(() => renderOutputParser(root, "BrokenOutput")).toThrow(/DoesNotExist/);
  });
});

// ---------------------------------------------------------------------------
// The strict schema's notion of the contract must be the metadata's notion.
//
// The strict tier used to emit every field as mandatory — it never read
// @required and never emitted .optional(). So `parse<Name>` threw on a reply
// that correctly omitted a declared-OPTIONAL field: it enforced a contract the
// metadata does not declare, and disagreed with the tolerant tier sitting in the
// same file, which reads the real attr.
//
// Every other port reuses the payload VO (made @required-correct by #309); only
// TypeScript re-derives its own schema inline, which is how it drifted. These
// tests pin the two tiers to ONE answer.
// ---------------------------------------------------------------------------
describe("renderOutputParser() — strict optionality tracks @required", () => {
  const RESPONSE_WITH_BOTH = [
    { "object.value": { name: "Req", children: [{ "field.string": { name: "q" } }] } },
    {
      "object.value": {
        name: "Res",
        children: [
          { "field.string": { name: "answer", "@required": true } },
          { "field.string": { name: "note" } },
          { "field.int": { name: "score" } },
          { "field.string": { name: "tags", isArray: true } },
        ],
      },
    },
    {
      "template.prompt": {
        name: "Ask",
        "@payloadRef": "Req",
        "@responseRef": "Res",
        "@textRef": "p/ask",
      },
    },
  ];

  test("a @required field is mandatory; an unmarked field is .optional()", async () => {
    const src = renderOutputParser(await loadRoot(RESPONSE_WITH_BOTH), "Ask");
    expect(src).toContain("answer: z.string(),");
    expect(src).toContain("note: z.string().optional(),");
    expect(src).toContain("score: z.number().int().optional(),");
  });

  test("array-ness and optionality compose — .optional() wraps the array", async () => {
    const src = renderOutputParser(await loadRoot(RESPONSE_WITH_BOTH), "Ask");
    expect(src).toContain("tags: z.array(z.string()).optional(),");
  });

  test("a nested value-object field honours @required the same way", async () => {
    const src = renderOutputParser(
      await loadRoot([
        { "object.value": { name: "Req", children: [{ "field.string": { name: "q" } }] } },
        { "object.value": { name: "Inner", children: [{ "field.string": { name: "x" } }] } },
        {
          "object.value": {
            name: "Res",
            children: [
              {
                "field.object": {
                  name: "kept",
                  "@objectRef": "Inner",
                  "@required": true,
                },
              },
              { "field.object": { name: "maybe", "@objectRef": "Inner" } },
            ],
          },
        },
        {
          "template.prompt": {
            name: "Ask",
            "@payloadRef": "Req",
            "@responseRef": "Res",
            "@textRef": "p/ask",
          },
        },
      ]),
      "Ask",
    );
    // Asserted as exact blocks, not a spanning regex: a lazy [\s\S]*? between
    // `kept:` and `}).optional()` happily matches ACROSS the required field into
    // the optional one's closer, so the negative form silently cannot fail.
    expect(src).toContain(
      ["  kept: z.object({", "    x: z.string().optional(),", "  }),"].join("\n"),
    );
    expect(src).toContain(
      ["  maybe: z.object({", "    x: z.string().optional(),", "  }).optional(),"].join("\n"),
    );
  });
});
