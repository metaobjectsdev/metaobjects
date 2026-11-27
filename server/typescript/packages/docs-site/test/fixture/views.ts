// Docs views for the explorer tests, each built the way `meta gen` builds one: from a LOADED
// model, plus the optional inputs a fixture carries.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  InMemoryStringSource,
  MetaData,
  MetaDataLoader,
  applyProviderDefinition,
  buildDocsView,
  composeRegistry,
  coreProviders,
  type DocsView,
  type DocsViewInput,
  type FactoryMap,
  type MetaDataTypeProvider,
  type ProviderDefinition,
} from "@metaobjectsdev/metadata";

/** A node of a type the fixture's provider.json declares: no behaviour beyond MetaData's own. */
class FixtureNode extends MetaData {}

export const CORPUS = resolve(import.meta.dir, "../../../../../../fixtures/explorer-conformance");

function readJson(dir: string, name: string): unknown {
  const p = join(dir, name);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as unknown) : undefined;
}

/** A provider for a fixture's `provider.json`: every type it declares is a plain node. */
function fixtureProvider(def: ProviderDefinition): MetaDataTypeProvider {
  const factories: FactoryMap = {};
  for (const t of def.types ?? []) factories[`${t.type}.${t.subType}`] = (id, name) => new FixtureNode(id, name);
  return { id: def.provider, dependencies: ["metaobjects-core-types"], registerTypes: (r) => applyProviderDefinition(r, def, factories) };
}

/** One corpus fixture's view, with its committed inputs; `edit` may change them first. */
export async function corpusView(name: string, edit?: (input: Omit<DocsViewInput, "root">) => void): Promise<DocsView> {
  const dir = join(CORPUS, name);
  const def = readJson(dir, "provider.json") as ProviderDefinition | undefined;
  const registry = composeRegistry(def !== undefined ? [...coreProviders, fixtureProvider(def)] : coreProviders);
  const loaded = await MetaDataLoader.fromDirectory(join(dir, "project", "metaobjects"), { strict: true, registry });
  if (loaded.errors.length > 0) throw new Error(`fixture ${name} does not load: ${loaded.errors.map(String).join("; ")}`);
  const input: Omit<DocsViewInput, "root"> = {};
  for (const [key, file] of [["verify", "verify.json"], ["manifest", "hashes.json"], ["routes", "routes.json"]] as const) {
    const v = readJson(dir, file);
    if (v !== undefined) input[key] = v;
  }
  edit?.(input);
  return buildDocsView({ root: loaded.root, ...input });
}

/** The view of a model written inline as canonical JSON. */
export async function inlineView(model: unknown): Promise<DocsView> {
  const loaded = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(model))]);
  if (loaded.errors.length > 0) throw new Error(`model does not load: ${loaded.errors.map(String).join("; ")}`);
  return buildDocsView({ root: loaded.root });
}
