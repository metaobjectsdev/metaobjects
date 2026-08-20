// server/typescript/packages/codegen-ts/test/generators/output-parser-file.test.ts
//
// ADR-0052 — a template subtype's axis is DIRECTION. The inbound tier (parser,
// tolerant extract, FR-010 response-format fragment) is driven by a
// `template.prompt` that declares `@responseRef`; a `template.output` renders
// outbound and emits NOTHING here.
//
// Before ADR-0052 this file asserted the opposite polarity, which is why an email
// template generated a parser for text the system had just rendered, and why the
// committed example carried a JSON.parse() parser for a MARKDOWN document.
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { outputParser } from "../../src/generators/output-parser-file.js";
import { outputPrompt } from "../../src/generators/output-prompt-file.js";
import { extractor } from "../../src/generators/extractor-file.js";
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

const REQ = {
  "object.value": { name: "Req", children: [{ "field.string": { name: "q" } }] },
};
const RES = {
  "object.value": { name: "Res", children: [{ "field.string": { name: "a" } }] },
};

describe("outputParser() factory — ADR-0052 direction split", () => {
  test("emits nothing for a template.output, whatever its @format", async () => {
    // A markdown document template. Before ADR-0052 this emitted a parser whose
    // body was `Schema.parse(JSON.parse(text))` — a generated function that could
    // never work, and one the repo actually shipped in examples/advanced-modeling.
    const root = await loadRoot([
      { "object.value": { name: "Doc", children: [{ "field.string": { name: "body" } }] } },
      {
        "template.output": {
          name: "Welcome",
          "@payloadRef": "Doc",
          "@textRef": "mail/welcome",
          "@format": "markdown",
        },
      },
    ]);
    const ctx = makeCtx(root);
    expect(await outputParser().generate(ctx)).toEqual([]);
    expect(await extractor().generate(ctx)).toEqual([]);
    expect(await outputPrompt().generate(ctx)).toEqual([]);
  });

  test("emits nothing for a template.prompt that declares no @responseRef", async () => {
    // @responseRef presence is the gate (ADR-0052), never a format value: a prompt
    // that never declared a response shape has nothing to parse into.
    const root = await loadRoot([
      REQ,
      {
        "template.prompt": {
          name: "FireAndForget",
          "@payloadRef": "Req",
          "@textRef": "p/x",
          "@format": "text",
        },
      },
    ]);
    const ctx = makeCtx(root);
    expect(await outputParser().generate(ctx)).toEqual([]);
    expect(await extractor().generate(ctx)).toEqual([]);
    expect(await outputPrompt().generate(ctx)).toEqual([]);
  });

  test("emits the inbound trio for a template.prompt carrying @responseRef", async () => {
    // @format: text + @responseFormat: xml — the prompt BODY and the REPLY typed
    // independently. This is the shape a single @format could not express, and the
    // regression pin for ADR-0053.
    const root = await loadRoot([
      REQ,
      RES,
      {
        "template.prompt": {
          name: "Ask",
          "@payloadRef": "Req",
          "@responseRef": "Res",
          "@textRef": "p/ask",
          "@format": "text",
          "@responseFormat": "xml",
        },
      },
    ]);
    const ctx = makeCtx(root);

    const parsers = await outputParser().generate(ctx);
    expect(parsers.map((f) => f.path)).toEqual(["Ask.response.ts"]);
    // An XML reply gets the tolerant extract and NOTHING strict. The strict tier is
    // `Schema.parse(JSON.parse(text))` and has no XML equivalent — the TS runtime
    // ships no XML parser, which is why it used to emit a `parseAsk` that could
    // never work. Its typed shape is the nullable `AskExtracted` mirror instead.
    expect(parsers[0]!.content).not.toContain("export function parseAsk");
    expect(parsers[0]!.content).not.toContain("export function safeParseAsk");
    expect(parsers[0]!.content).not.toContain('from "zod"');
    expect(parsers[0]!.content).toContain("export interface AskExtracted");
    expect(parsers[0]!.content).toContain("export function extractLenientAskWithLoader");
    // The reply syntax comes from @responseFormat, NOT from @format — which is
    // "text" here and would have yielded no extract path at all before ADR-0053.
    expect(parsers[0]!.content).toContain("Format.XML");
    expect(parsers[0]!.content).not.toContain("Format.JSON");

    expect((await outputPrompt().generate(ctx)).map((f) => f.path)).toEqual([
      "Ask.responseFormat.ts",
    ]);
    expect((await extractor().generate(ctx)).map((f) => f.path)).toEqual([
      "Ask.extractor.ts",
    ]);
  });

  test("defaults the reply syntax to JSON when @responseFormat is absent", async () => {
    // ADR-0053: the default reproduces the trace helper's pre-existing fallback
    // (anything not "xml" was JSON), so a JSON responseRef carrier needs no edit.
    const root = await loadRoot([
      REQ,
      RES,
      {
        "template.prompt": {
          name: "Ask",
          "@payloadRef": "Req",
          "@responseRef": "Res",
          "@textRef": "p/ask",
          "@format": "markdown",
        },
      },
    ]);
    const out = await outputParser().generate(makeCtx(root));
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toContain("Format.JSON");
    expect(out[0]!.content).not.toContain("Format.XML");
    // A JSON reply DOES get the strict tier — JSON.parse is a real, exact parser,
    // so `Schema.parse(JSON.parse(text))` is a correct thing to generate.
    expect(out[0]!.content).toContain("export function parseAsk");
    expect(out[0]!.content).toContain("export function safeParseAsk");
  });

  test("parses into the @responseRef shape, not the @payloadRef shape", async () => {
    // The request and the response are different value-objects; the parser must
    // bind the RESPONSE. Before ADR-0052 the inbound tier read @payloadRef, so a
    // model that used one template for both directions could not tell them apart.
    const root = await loadRoot([
      { "object.value": { name: "Req", children: [{ "field.string": { name: "question" } }] } },
      { "object.value": { name: "Res", children: [{ "field.string": { name: "answer" } }] } },
      {
        "template.prompt": {
          name: "Ask",
          "@payloadRef": "Req",
          "@responseRef": "Res",
          "@textRef": "p/ask",
        },
      },
    ]);
    const out = await outputParser().generate(makeCtx(root));
    expect(out[0]!.content).toContain("answer:");
    expect(out[0]!.content).not.toContain("question:");
  });

  test("honors a custom outDir option", async () => {
    const root = await loadRoot([
      REQ,
      RES,
      {
        "template.prompt": {
          name: "P",
          "@payloadRef": "Req",
          "@responseRef": "Res",
          "@textRef": "x/y",
        },
      },
    ]);
    const gen = outputParser({ outDir: "src/generated/outputs" });
    const out = await gen.generate(makeCtx(root));
    expect(out).toHaveLength(1);
    expect(out[0]!.path).toBe("src/generated/outputs/P.response.ts");
  });

  test("emits one file per responding prompt", async () => {
    const root = await loadRoot([
      REQ,
      RES,
      {
        "template.prompt": {
          name: "Alpha",
          "@payloadRef": "Req",
          "@responseRef": "Res",
          "@textRef": "a/x",
        },
      },
      {
        "template.prompt": {
          name: "Beta",
          "@payloadRef": "Req",
          "@responseRef": "Res",
          "@textRef": "b/x",
        },
      },
      // Present to prove the outbound tier is not swept in.
      {
        "template.output": {
          name: "Card",
          "@payloadRef": "Req",
          "@textRef": "c/x",
          "@format": "html",
        },
      },
    ]);
    const out = await outputParser().generate(makeCtx(root));
    expect(out.map((f) => f.path).sort()).toEqual(["Alpha.response.ts", "Beta.response.ts"]);
  });
});
