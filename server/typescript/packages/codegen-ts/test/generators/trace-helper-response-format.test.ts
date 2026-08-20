// ADR-0053 — the trace helper parses the REPLY using @responseFormat.
//
// This site read @format twice: once as the reply's syntax and once as the prompt
// body's, under a comment calling them "two intentionally different shapes". They
// are two different FACTS. A plain-text prompt eliciting an XML reply — the shape
// the shipped docs-site fixture actually declares — was parsed as JSON.
//
// The discriminating case is @format: text + @responseFormat: xml. Under the old
// read that yields Format.JSON; only reading @responseFormat yields Format.XML.
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { traceHelperFile } from "../../src/generators/trace-helper-file.js";
import type { GenContext } from "../../src/generator.js";

async function loadRoot(promptAttrs: Record<string, unknown>) {
  const doc = {
    "metadata.root": {
      package: "app::ops",
      children: [
        {
          "object.value": {
            name: "AskVO",
            children: [{ "field.string": { name: "question" } }],
          },
        },
        {
          "object.value": {
            name: "AnswerVO",
            children: [{ "field.string": { name: "answer" } }],
          },
        },
        {
          "object.entity": {
            name: "LlmCallBase",
            abstract: true,
            children: [
              { "field.uuid": { name: "traceId" } },
              { "field.string": { name: "callType" } },
              { "field.string": { name: "llmRequest", "@dbColumnType": "jsonb" } },
            ],
          },
        },
        {
          "object.entity": {
            name: "ApiCall",
            extends: "LlmCallBase",
            children: [
              { "source.rdb": { "@table": "api_call", "@role": "primary" } },
              { "identity.primary": { name: "id", "@fields": ["traceId"] } },
              {
                "template.prompt": {
                  name: "AskPrompt",
                  "@payloadRef": "AskVO",
                  "@responseRef": "AnswerVO",
                  ...promptAttrs,
                },
              },
            ],
          },
        },
      ],
    },
  };
  const res = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify(doc), { id: "meta.json", format: "json" }),
  ]);
  expect(res.errors).toEqual([]);
  return res.root;
}

function ctxFor(root: Awaited<ReturnType<typeof loadRoot>>): GenContext {
  return {
    entities: root.objects(),
    loadedRoot: root,
    matches: () => true,
    config: { outDir: "/tmp/out", dialect: "postgres" } as never,
    warn: () => {},
  };
}

async function emit(promptAttrs: Record<string, unknown>): Promise<string> {
  const root = await loadRoot(promptAttrs);
  const files = await traceHelperFile().generate(ctxFor(root));
  expect(files.length).toBe(1);
  return files[0]!.content;
}

describe("trace helper — the reply's syntax comes from @responseFormat (ADR-0053)", () => {
  test("a TEXT-bodied prompt with an XML reply parses as XML", async () => {
    // The regression pin. Reading @format here yields Format.JSON and silently
    // mis-parses every XML reply whose prompt body is not itself XML.
    const src = await emit({ "@textRef": "p/ask", "@format": "text", "@responseFormat": "xml" });
    expect(src).toContain("Format.XML");
    expect(src).not.toContain("Format.JSON");
  });

  test("an XML-bodied prompt with a JSON reply parses as JSON", async () => {
    // The mirror image, so the test cannot pass by reading either attribute alone.
    const src = await emit({ "@textRef": "p/ask", "@format": "xml", "@responseFormat": "json" });
    expect(src).toContain("Format.JSON");
    expect(src).not.toContain("Format.XML");
  });

  test("@responseFormat absent defaults to JSON — behaviour-preserving", async () => {
    const src = await emit({ "@textRef": "p/ask", "@format": "markdown" });
    expect(src).toContain("Format.JSON");
    expect(src).not.toContain("Format.XML");
  });

  test("the prompt BODY still renders in its own @format, not the reply's", async () => {
    // render() takes the raw body format string; the two must not collapse back
    // into one another in either direction.
    const src = await emit({ "@textRef": "p/ask", "@format": "markdown", "@responseFormat": "xml" });
    expect(src).toContain("Format.XML");
    expect(src).toContain('"markdown"');
  });
});
