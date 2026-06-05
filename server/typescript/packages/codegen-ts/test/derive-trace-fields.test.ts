import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGen, defineConfig } from "../src/index.js";
import { entityFile, queriesFile, barrel } from "../src/generators/index.js";
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
