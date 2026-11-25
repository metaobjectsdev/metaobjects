// Loads a conformance fixture's input/ with the pack and every pack it requires composed.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MetaDataLoader, InMemoryStringSource, composeRegistry, coreProviders, type MetaRoot } from "@metaobjectsdev/metadata";
import { configProvider } from "@metaobjectsdev/pack-config";
import { provider as deliveryProvider } from "@metaobjectsdev/pack-delivery";
import { provider as systemsProvider } from "@metaobjectsdev/pack-systems";
import { provider as railwayProvider } from "../src/index.js";

export const CORPUS = join(import.meta.dir, "../../fixtures/conformance");

/** One source per model, or one per file of a fixture's input/ directory. */
export async function loadModels(sources: readonly { id: string; json: string }[]): Promise<MetaRoot> {
  const registry = composeRegistry([...coreProviders, systemsProvider, deliveryProvider, configProvider, railwayProvider]);
  const res = await new MetaDataLoader({ registry, strict: true }).load(
    sources.map((s) => new InMemoryStringSource(s.json, { id: s.id, format: "json" })),
  );
  if (res.errors.length > 0) throw new Error(res.errors.map((e) => e.message).join("\n"));
  return res.root;
}

export function fixtureSources(scenario: string): { id: string; json: string }[] {
  const dir = join(CORPUS, scenario, "input");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ id: f, json: readFileSync(join(dir, f), "utf8") }));
}

export function loadFixture(scenario: string): Promise<MetaRoot> {
  return loadModels(fixtureSources(scenario));
}
