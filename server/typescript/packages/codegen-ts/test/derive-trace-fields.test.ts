import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGen, defineConfig } from "../src/index.js";
import { entityFile, queriesFile, barrel, traceHelperFile } from "../src/generators/index.js";
import { deriveTraceFields } from "../src/ai/derive-trace-fields.js";
import { MetaDataLoader } from "@metaobjectsdev/metadata";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "ai1b-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

const MODEL = JSON.stringify({ "metadata.root": { package: "t::ai", children: [
  { "object.value": { name: "ReqVO", children: [{ "field.string": { name: "q" } }] } },
  { "object.value": { name: "ResVO", children: [{ "field.string": { name: "a" } }] } },
  { "object.entity": { name: "LlmCallBase", abstract: true, children: [
    { "field.uuid": { name: "spanId" } }, { "field.string": { name: "status" } },
  ] } },
  { "object.entity": { name: "ClassifyCall", extends: "LlmCallBase", children: [
    { "source.rdb": { "@table": "classify_call", "@role": "primary" } },
    { "identity.primary": { "@fields": ["spanId"] } },
    { "template.prompt": { name: "ClassifyPrompt", "@payloadRef": "ReqVO", "@responseRef": "ResVO", "@textRef": "p/x", "@format": "xml" } },
  ] } },
] } });

describe("derive trace fields", () => {
  test("nested prompt → voRequest/voResponse jsonb columns on the table", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ai1b-model-"));
    writeFileSync(join(dir, "m.json"), MODEL);
    const loaded = await MetaDataLoader.fromDirectory(dir, { preFreeze: deriveTraceFields });
    rmSync(dir, { recursive: true, force: true });
    expect(loaded.errors).toEqual([]);
    const out = await runGen({
      config: defineConfig({ outDir: tmp, extStyle: "none", dbImport: "~/db", dialect: "postgres", generators: [entityFile(), queriesFile(), barrel()] }),
      metadata: loaded.root,
    });
    expect(out.warnings).toEqual([]);
    const t = readFileSync(join(tmp, "ClassifyCall.ts"), "utf-8");
    expect(t).toContain("classify_call");
    expect(t).toContain("voRequest");
    expect(t).toContain("voResponse");
    expect(t).toContain("jsonb");
  });

  test("emits a typed record helper for a derived trace entity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ai1b-h-"));
    writeFileSync(join(dir, "m.json"), MODEL);
    const loaded = await MetaDataLoader.fromDirectory(dir, { preFreeze: deriveTraceFields });
    rmSync(dir, { recursive: true, force: true });
    expect(loaded.errors).toEqual([]);
    const out = await runGen({
      config: defineConfig({ outDir: tmp, extStyle: "none", dbImport: "~/db", dialect: "postgres",
        generators: [entityFile(), queriesFile(), traceHelperFile(), barrel()] }),
      metadata: loaded.root,
    });
    expect(out.warnings).toEqual([]);
    const files = readdirSync(tmp);
    expect(files).toContain("ClassifyCall.trace.ts");
    const h = readFileSync(join(tmp, "ClassifyCall.trace.ts"), "utf-8");
    expect(h).toContain("recordClassifyCall");
    expect(h).toContain("recordLlmCall");
    // non-STI invariant: a trace entity that is NOT a TPH subtype keeps callType
    // caller-supplied (no "| callType" omission, no spread-injection).
    expect(h).toContain('Omit<LlmCallInput, "llmRequest">');
    expect(h).not.toContain('"llmRequest" | "callType"');
  });

  test("trace-helper emits both record and call helpers for a renderable prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ai1b-call-"));
    writeFileSync(join(dir, "m.json"), MODEL);
    const loaded = await MetaDataLoader.fromDirectory(dir, { preFreeze: deriveTraceFields });
    rmSync(dir, { recursive: true, force: true });
    expect(loaded.errors).toEqual([]);
    const out = await runGen({
      config: defineConfig({ outDir: tmp, extStyle: "none", dbImport: "~/db", dialect: "postgres",
        generators: [entityFile(), queriesFile(), traceHelperFile(), barrel()] }),
      metadata: loaded.root,
    });
    expect(out.warnings).toEqual([]);
    const h = readFileSync(join(tmp, "ClassifyCall.trace.ts"), "utf-8");
    expect(h).toContain("export async function recordClassifyCall(");
    expect(h).toContain("export async function callClassifyCall(");
    expect(h).toContain('from "@metaobjectsdev/ai-runtime"');
    expect(h).toContain('from "@metaobjectsdev/render"');
    expect(h).toContain('render({ ref: "p/x"');
    // exactOptionalPropertyTypes-safe shape: request built then optionals added.
    expect(h).toContain("const request: LlmRequest = { prompt, model: deps.model };");
    expect(h).toContain("const callInput: CallLlmInput = { callType: \"ClassifyCall\", payload, request };");
    expect(h).toContain("if (deps.system !== undefined) request.system = deps.system;");
    expect(h).toContain("const result = await callLlm(callInput, callDeps);");
    // imports must all be at the top: no `import ` after the first export.
    const firstExport = h.indexOf("export ");
    const lastImport = h.lastIndexOf("\nimport ");
    expect(lastImport).toBeLessThan(firstExport);
  });

  test("trace-helper emits only the record helper for a non-renderable prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ai1b-norender-"));
    writeFileSync(join(dir, "m.json"), JSON.stringify({ "metadata.root": { package: "t::ai", children: [
      { "object.value": { name: "ReqVO", children: [{ "field.string": { name: "q" } }] } },
      { "object.value": { name: "ResVO", children: [{ "field.string": { name: "a" } }] } },
      { "object.entity": { name: "LlmCallBase", abstract: true, children: [
        { "field.uuid": { name: "spanId" } }, { "field.string": { name: "status" } },
      ] } },
      { "object.entity": { name: "ClassifyCall", extends: "LlmCallBase", children: [
        { "source.rdb": { "@table": "classify_call", "@role": "primary" } },
        { "identity.primary": { "@fields": ["spanId"] } },
        { "template.prompt": { name: "ClassifyPrompt", "@payloadRef": "ReqVO", "@responseRef": "ResVO", "@format": "xml" } },
      ] } },
    ] } }));
    const loaded = await MetaDataLoader.fromDirectory(dir, { preFreeze: deriveTraceFields });
    rmSync(dir, { recursive: true, force: true });
    // A template.prompt without @textRef is flagged by the loader (it always requires
    // a renderable body), but the entity still loads — the generator must degrade to
    // emitting ONLY the record helper, never the render-dependent call helper.
    expect(loaded.errors.map((e) => String(e))).toContain(
      "ParseError: template \"ClassifyPrompt\" requires @textRef",
    );
    const out = await runGen({
      config: defineConfig({ outDir: tmp, extStyle: "none", dbImport: "~/db", dialect: "postgres",
        generators: [traceHelperFile()] }),
      metadata: loaded.root,
    });
    const h = readFileSync(join(tmp, "ClassifyCall.trace.ts"), "utf-8");
    expect(h).toContain("export async function recordClassifyCall(");
    expect(h).not.toContain("export async function callClassifyCall(");
    expect(h).not.toContain('from "@metaobjectsdev/ai-runtime"');
  });

  test("entity without a nested prompt is untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ai1b-plain-"));
    writeFileSync(join(dir, "m.json"), JSON.stringify({ "metadata.root": { package: "t::x", children: [
      { "object.entity": { name: "Widget", children: [
        { "source.rdb": { "@table": "widget", "@role": "primary" } },
        { "field.uuid": { name: "id" } }, { "identity.primary": { "@fields": ["id"] } },
      ] } },
    ] } }));
    const loaded = await MetaDataLoader.fromDirectory(dir);
    rmSync(dir, { recursive: true, force: true });
    const out = await runGen({ config: defineConfig({ outDir: tmp, extStyle: "none", dbImport: "~/db", dialect: "postgres", generators: [entityFile(), barrel()] }), metadata: loaded.root });
    const t = readFileSync(join(tmp, "Widget.ts"), "utf-8");
    expect(t).not.toContain("voRequest");
  });
});
