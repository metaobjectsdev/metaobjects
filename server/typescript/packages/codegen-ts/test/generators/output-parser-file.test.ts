// server/typescript/packages/codegen-ts/test/generators/output-parser-file.test.ts
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { outputParser } from "../../src/generators/output-parser-file.js";
import type { GenContext } from "../../src/generator.js";

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

function makeCtx(root: Awaited<ReturnType<typeof loadRoot>>): GenContext {
  return {
    entities: root.objects(),
    loadedRoot: root,
    matches: () => true,
    config: { outDir: "/tmp/out", dialect: "sqlite" } as never,
    warn: () => {},
  };
}

describe("outputParser() factory", () => {
  test("emits no files when metadata has no template.output nodes", async () => {
    const root = await loadRoot([
      {
        "object.value": {
          name: "Payload",
          children: [{ "field.string": { name: "x" } }],
        },
      },
      {
        "template.prompt": {
          name: "promptOnly",
          "@payloadRef": "Payload",
          "@textRef": "p/x",
          "@format": "text",
        },
      },
    ]);
    const gen = outputParser();
    const out = await gen.generate(makeCtx(root));
    expect(out).toEqual([]);
  });

  test("emits one file per template.output", async () => {
    const root = await loadRoot([
      {
        "object.value": {
          name: "AlphaPayload",
          children: [{ "field.string": { name: "name" } }],
        },
      },
      {
        "object.value": {
          name: "BetaPayload",
          children: [{ "field.int": { name: "n" } }],
        },
      },
      {
        "template.output": {
          name: "Alpha",
          "@payloadRef": "AlphaPayload",
          "@textRef": "a/x",
          "@format": "json",
        },
      },
      {
        "template.output": {
          name: "Beta",
          "@payloadRef": "BetaPayload",
          "@textRef": "b/x",
          "@format": "json",
        },
      },
    ]);
    const gen = outputParser();
    const out = await gen.generate(makeCtx(root));
    expect(out).toHaveLength(2);
    const paths = out.map((f) => f.path).sort();
    expect(paths).toEqual(["Alpha.output.ts", "Beta.output.ts"]);
    const alpha = out.find((f) => f.path === "Alpha.output.ts")!;
    expect(alpha.content).toContain("export function parseAlpha");
    expect(alpha.content).toContain("export function safeParseAlpha");
    const beta = out.find((f) => f.path === "Beta.output.ts")!;
    expect(beta.content).toContain("export function parseBeta");
  });

  test("honors a custom outDir option", async () => {
    const root = await loadRoot([
      {
        "object.value": {
          name: "P",
          children: [{ "field.string": { name: "x" } }],
        },
      },
      {
        "template.output": {
          name: "P",
          "@payloadRef": "P",
          "@textRef": "x/y",
          "@format": "json",
        },
      },
    ]);
    const gen = outputParser({ outDir: "src/generated/outputs" });
    const out = await gen.generate(makeCtx(root));
    expect(out).toHaveLength(1);
    expect(out[0]!.path).toBe("src/generated/outputs/P.output.ts");
  });

  test("does not emit for template.prompt nodes", async () => {
    const root = await loadRoot([
      {
        "object.value": {
          name: "Payload",
          children: [{ "field.string": { name: "x" } }],
        },
      },
      {
        "template.prompt": {
          name: "PromptOne",
          "@payloadRef": "Payload",
          "@textRef": "p/x",
          "@format": "text",
        },
      },
      {
        "template.output": {
          name: "OutputOne",
          "@payloadRef": "Payload",
          "@textRef": "o/x",
          "@format": "json",
        },
      },
    ]);
    const gen = outputParser();
    const out = await gen.generate(makeCtx(root));
    expect(out).toHaveLength(1);
    expect(out[0]!.path).toBe("OutputOne.output.ts");
  });
});
