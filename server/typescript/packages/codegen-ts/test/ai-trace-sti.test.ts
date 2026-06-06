import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGen, defineConfig } from "../src/index.js";
import { entityFile, queriesFile, barrel, traceHelperFile } from "../src/generators/index.js";
import { deriveTraceFields } from "../src/ai/derive-trace-fields.js";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "@metaobjectsdev/migrate-ts";

const STI_MODEL = JSON.stringify({ "metadata.root": { package: "t::ai", children: [
  { "object.value": { name: "ClassifyReq", children: [{ "field.string": { name: "text" } }] } },
  { "object.value": { name: "ClassifyRes", children: [{ "field.string": { name: "label", "@required": true } }] } },
  { "object.value": { name: "SummarizeReq", children: [{ "field.string": { name: "doc" } }] } },
  { "object.value": { name: "SummarizeRes", children: [{ "field.string": { name: "summary", "@required": true } }] } },
  { "object.entity": { name: "LlmCallBase", abstract: true, children: [
    { "field.uuid": { name: "spanId" } },
    { "field.string": { name: "callType" } },
    { "field.string": { name: "status" } },
  ] } },
  { "object.entity": { name: "PromptTrace", extends: "LlmCallBase", "@discriminator": "callType", children: [
    { "source.rdb": { "@table": "prompt_llm_call", "@role": "primary" } },
    { "identity.primary": { "@fields": ["spanId"] } },
  ] } },
  { "object.entity": { name: "ClassifyCall", extends: "PromptTrace", "@discriminatorValue": "classify", children: [
    { "template.prompt": { name: "ClassifyPrompt", "@textRef": "p/classify", "@payloadRef": "ClassifyReq", "@responseRef": "ClassifyRes", "@format": "json" } },
  ] } },
  { "object.entity": { name: "SummarizeCall", extends: "PromptTrace", "@discriminatorValue": "summarize", children: [
    { "template.prompt": { name: "SummarizePrompt", "@textRef": "p/summarize", "@payloadRef": "SummarizeReq", "@responseRef": "SummarizeRes", "@format": "json" } },
  ] } },
] } });

async function genTrace(): Promise<{ classify: string; summarize: string }> {
  const tmp = mkdtempSync(join(tmpdir(), "ai1c-out-"));
  const dir = mkdtempSync(join(tmpdir(), "ai1c-model-"));
  writeFileSync(join(dir, "m.json"), STI_MODEL);
  const loaded = await MetaDataLoader.fromDirectory(dir, { preFreeze: deriveTraceFields });
  rmSync(dir, { recursive: true, force: true });
  expect(loaded.errors).toEqual([]);
  const out = await runGen({
    config: defineConfig({ outDir: tmp, extStyle: "none", dbImport: "~/db", dialect: "postgres",
      generators: [entityFile(), queriesFile(), traceHelperFile(), barrel()] }),
    metadata: loaded.root,
  });
  expect(out.warnings).toEqual([]);
  return {
    classify: readFileSync(join(tmp, "ClassifyCall.trace.ts"), "utf-8"),
    summarize: readFileSync(join(tmp, "SummarizeCall.trace.ts"), "utf-8"),
  };
}

describe("ai-trace #1c — STI callType stamping", () => {
  test("record<Entity> omits callType from input and stamps the discriminator value", async () => {
    const { classify, summarize } = await genTrace();
    // both subtypes drop callType from the caller input and stamp their own value
    expect(classify).toContain('Omit<LlmCallInput, "llmRequest" | "callType">');
    expect(classify).toContain('{ ...input, callType: "classify" }');
    expect(summarize).toContain('Omit<LlmCallInput, "llmRequest" | "callType">');
    expect(summarize).toContain('{ ...input, callType: "summarize" }');
  });

  test("call<Entity> stamps the discriminator value (not the entity name)", async () => {
    const { summarize } = await genTrace();
    expect(summarize).toContain('callType: "summarize"');
    expect(summarize).not.toContain('callType: "SummarizeCall"');
  });
});

describe("ai-trace #1c — STI table collapse", () => {
  test("N trace subtypes collapse to one prompt_llm_call table", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ai1c-schema-"));
    writeFileSync(join(dir, "m.json"), STI_MODEL);
    const loaded = await MetaDataLoader.fromDirectory(dir, { preFreeze: deriveTraceFields });
    rmSync(dir, { recursive: true, force: true });
    expect(loaded.errors).toEqual([]);

    const expected = buildExpectedSchema(loaded.root, { columnNamingStrategy: "literal" });
    const traceTables = expected.tables.filter((t) => t.name === "prompt_llm_call");
    expect(traceTables.length).toBe(1);
    expect(expected.tables.some((t) => t.name === "classify_call" || t.name === "summarize_call")).toBe(false);

    const cols = new Set(traceTables[0]!.columns.map((c) => c.name));
    expect(cols.has("callType")).toBe(true);
    expect(cols.has("voRequest")).toBe(true);
    expect(cols.has("voResponse")).toBe(true);
    expect(traceTables[0]!.columns.filter((c) => c.name === "voResponse").length).toBe(1);
  });
});
