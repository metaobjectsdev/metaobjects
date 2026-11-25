// Reference nodes (`{ "path": …, "reference": true }` sources) load so a prompt's
// `@responseRef` resolves, and no generator emits a type for them: another run owns those
// types. The responding prompt's parser still emits, naming the reply type as usual.
// Corpus for the load half: fixtures/reference-source-conformance/.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { InMemoryStringSource, MetaDataLoader } from "@metaobjectsdev/metadata";
import { runGen } from "../src/runner.js";
import { defineConfig } from "../src/metaobjects-config.js";
import { entityFile } from "../src/generators/entity-file.js";
import { outputParser } from "../src/generators/output-parser-file.js";
import { removeTree } from "../src/scratch-dir.js";

const TEMP: string[] = [];
afterAll(() => TEMP.forEach(removeTree));

const META = JSON.stringify({ "metadata.root": { package: "acme::support", children: [
  { "object.value": { name: "SupportRequest", children: [{ "field.string": { name: "question" } }] } },
  { "object.value": { name: "AnswerSource", children: [{ "field.string": { name: "url" } }] } },
  { "object.value": { name: "SupportAnswer", children: [
    { "field.string": { name: "text" } },
    { "field.object": { name: "source", "@objectRef": "acme::support::AnswerSource" } },
  ] } },
  { "template.prompt": { name: "SupportAnswerPrompt", "@payloadRef": "acme::support::SupportRequest",
    "@responseRef": "acme::support::SupportAnswer", "@textRef": "support/answer", "@format": "text" } },
] } });

async function gen(reference: readonly string[]): Promise<Map<string, string>> {
  const res = await new MetaDataLoader().load([new InMemoryStringSource(META)]);
  expect(res.errors).toEqual([]);
  res.root.referenceNodes = new Set(reference);
  const dir = mkdtempSync(join(process.env["DEV_SCRATCH"] ?? tmpdir(), "mo-ref-gen-"));
  TEMP.push(dir);
  const result = await runGen({
    config: defineConfig({ outDir: dir, extStyle: "js", dbImport: "../db", dialect: "postgres", generators: [entityFile(), outputParser()] }),
    metadata: res.root,
  });
  expect(result.conflicts).toEqual([]);
  const out = new Map<string, string>();
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (e.isFile()) out.set(relative(dir, join(e.parentPath, e.name)), readFileSync(join(e.parentPath, e.name), "utf8"));
  }
  return out;
}

describe("reference nodes in codegen", () => {
  test("a reference reply type emits no type of its own, and its parser still emits", async () => {
    const all = await gen([]);
    const ref = await gen(["acme::support::SupportAnswer", "acme::support::AnswerSource"]);
    const has = (m: Map<string, string>, n: string) => [...m.keys()].some((k) => k.endsWith(`${n}.ts`));
    expect(has(all, "SupportAnswer")).toBe(true);
    expect(has(all, "AnswerSource")).toBe(true);
    expect(has(ref, "SupportAnswer")).toBe(false);
    expect(has(ref, "AnswerSource")).toBe(false);
    expect(has(ref, "SupportRequest")).toBe(true);
    const parser = [...ref.entries()].find(([k]) => k.endsWith("SupportAnswerPrompt.response.ts"));
    expect(parser).toBeDefined();
    // The parser names the reply type the owning run generates, exactly as it would here.
    expect(parser![1]).toBe(all.get(parser![0])!);
  });
});
