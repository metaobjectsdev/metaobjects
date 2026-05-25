// Load every JSON metadata file in a directory through the standard loader.
// Errors are aggregated and re-thrown with the directory + error codes so a
// scenario failure points at the right fixture immediately.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { InMemorySource, MetaDataLoader, type MetaRoot } from "@metaobjectsdev/metadata";

export async function loadMetadataDir(dir: string): Promise<MetaRoot> {
  const sources = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => new InMemorySource(readFileSync(join(dir, f), "utf8"), { id: f }));
  if (sources.length === 0) throw new Error(`${dir}: no .json metadata files found`);
  const result = await new MetaDataLoader().load(sources);
  if (result.errors.length > 0) {
    const summary = result.errors
      .map((e) => `${(e as { code?: string }).code ?? "ERROR"}: ${e.message}`)
      .join("; ");
    throw new Error(`${dir}: metadata did not load cleanly: ${summary}`);
  }
  return result.root;
}
