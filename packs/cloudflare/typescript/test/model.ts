// Loads a conformance fixture's input/ with the pack and every pack it requires composed, and
// runs the pack's generators over it.
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defineConfig, runGen } from "@metaobjectsdev/codegen-ts";
import { MetaDataLoader, InMemoryStringSource, composeRegistry, coreProviders, type MetaRoot } from "@metaobjectsdev/metadata";
import { configProvider } from "@metaobjectsdev/pack-config";
import { provider as deliveryProvider } from "@metaobjectsdev/pack-delivery";
import { provider as systemsProvider } from "@metaobjectsdev/pack-systems";
import { cloudflareFiles, provider as cloudflareProvider, type CloudflareGeneratorOptions } from "../src/index.js";

const CORPUS = join(import.meta.dir, "../../fixtures/conformance");

export interface Source {
  readonly id: string;
  readonly json: string;
}

/** One source per model, or one per file of a fixture's input/ directory. */
export async function loadModels(sources: readonly Source[]): Promise<MetaRoot> {
  const registry = composeRegistry([...coreProviders, systemsProvider, deliveryProvider, configProvider, cloudflareProvider]);
  const res = await new MetaDataLoader({ registry, strict: true }).load(
    sources.map((s) => new InMemoryStringSource(s.json, { id: s.id, format: "json" })),
  );
  if (res.errors.length > 0) throw new Error(res.errors.map((e) => e.message).join("\n"));
  return res.root;
}

export function fixtureSources(scenario: string): Source[] {
  const dir = join(CORPUS, scenario, "input");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ id: f, json: readFileSync(join(dir, f), "utf8") }));
}

export function loadFixture(scenario: string): Promise<MetaRoot> {
  return loadModels(fixtureSources(scenario));
}

/**
 * Every file the pack's generators write for `root`, by its path relative to the output
 * directory: a dry run, nothing written.
 */
export async function emit(root: MetaRoot, opts: CloudflareGeneratorOptions = {}): Promise<Map<string, string>> {
  const out = join(process.env.DEV_SCRATCH ?? tmpdir(), "pack-cloudflare-out");
  const res = await runGen({
    config: defineConfig({ outDir: out, extStyle: "none", dbImport: "../db", dialect: "sqlite", generators: cloudflareFiles(opts) }),
    metadata: root,
    projectRoot: dirname(out),
    dryRun: true,
  });
  const files = new Map<string, string>();
  for (const [abs, content] of res.rendered ?? []) files.set(abs.slice(out.length + 1), content);
  return files;
}

const emitted = new Map<string, Promise<Map<string, string>>>();

/** A fixture's generated files with the default options, loaded and emitted once per test file. */
export function emitFixture(scenario: string): Promise<Map<string, string>> {
  let files = emitted.get(scenario);
  if (files === undefined) emitted.set(scenario, (files = loadFixture(scenario).then((root) => emit(root))));
  return files;
}

/** A fixture's input with `edit` applied to its one file's JSON: for the refusal tests. */
export function editFixture(scenario: string, edit: (root: { "metadata.root": { children: Record<string, Record<string, unknown>>[] } }) => void): Source[] {
  const [only, ...rest] = fixtureSources(scenario);
  if (only === undefined || rest.length > 0) throw new Error(`${scenario}: editFixture needs a fixture with one input file`);
  const json = JSON.parse(only.json);
  edit(json);
  return [{ id: only.id, json: JSON.stringify(json) }];
}
