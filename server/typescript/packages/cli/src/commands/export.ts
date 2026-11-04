import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { parseExportArgs } from "../lib/args.js";
import { log } from "../lib/log.js";
import { FileSource } from "@metaobjectsdev/metadata/core";
import { composeRegistry, MetaDataLoader, canonicalSerialize, canonicalSerializeEffective } from "@metaobjectsdev/metadata";
import { defaultLoadMemoryProviders, forgeTypesProvider, resolveCollection } from "@metaobjectsdev/sdk";
import { loadProjectProviders } from "../lib/load-metaobjects-config.js";
import { collectionLoadOptions } from "../lib/collection-load-options.js";
import { describeError } from "../lib/error-text.js";

export async function exportCommand(args: string[], cwd: string): Promise<number> {
  let flags;
  try {
    flags = parseExportArgs(args);
  } catch (err) {
    log.error(describeError(err));
    return 2;
  }

  const projectRoot = cwd;

  // `export` has never used exit 2 for a metadata problem — only for a bad CLI
  // flag (see parseExportArgs above). Previously any directory-load failure
  // surfaced through loadAndExportJson's collected result.errors (exit 1); a
  // resolveCollection failure (no declared sources, no default metaobjects/,
  // or a malformed config.json) is the same class of problem and is reported
  // the same way, to keep that contract exactly as it was.
  let collection: Awaited<ReturnType<typeof resolveCollection>>;
  try {
    collection = await resolveCollection(projectRoot);
  } catch (err) {
    log.error(describeError(err));
    return 1;
  }

  // Core + descriptive (forge) types so decision/principle records load, plus the
  // project's own `metaobjects.config.ts` providers (a config that exists but fails to
  // load is reported as itself, not as an unknown-subtype error).
  let providers;
  try {
    providers = await loadProjectProviders(cwd, collection.configDir);
  } catch (err) {
    log.error(describeError(err));
    return 1;
  }
  const base = [...defaultLoadMemoryProviders, forgeTypesProvider];
  const registry = composeRegistry([...base, ...providers.filter((p) => !base.some((b) => b.id === p.id))]);

  // `loadAndExportJson` only accepts a scanned directory (`MetaDataLoader.fromDirectory`);
  // `resolveCollection` already resolved the file SET (declared `sources`, or the
  // `metaobjects/` default), so load that list directly via the same loader +
  // serializer `loadAndExportJson` composes, rather than re-deriving a directory.
  //
  // Everything the collection contributes to a load comes from `collectionLoadOptions`,
  // the helper every other command uses: `export` loaded `files` alone, so the libraries
  // a project opts into never loaded here and every reference into one failed to resolve.
  const load = collectionLoadOptions(collection);
  const libSources = load.libraries.length > 0
    ? (await import("@metaobjectsdev/metadata/library")).librarySources([...load.libraries])
    : [];
  const loadResult = await new MetaDataLoader({ registry }).load([
    ...libSources,
    ...load.files.map((f) => {
      const id = load.fileIds.get(f);
      return id === undefined ? new FileSource(f) : new FileSource(f, { id });
    }),
  ]);
  const result = {
    // `--effective` materializes the super chain (every inherited member and attribute
    // on the node that inherits it), so a reader that is not a loader — the explorer
    // builder, a port without this project's providers — never resolves `extends` itself.
    json: flags.effective ? canonicalSerializeEffective(loadResult.root) : canonicalSerialize(loadResult.root),
    errors: loadResult.errors,
    warnings: loadResult.warnings.map((w) => w.message),
  };

  for (const w of result.warnings) {
    log.warn(w);
  }

  if (result.errors.length > 0) {
    for (const err of result.errors) {
      log.error(err.message);
    }
    return 1;
  }

  if (flags.out !== undefined) {
    const outPath = resolve(projectRoot, flags.out);
    await writeFile(outPath, result.json, "utf8");
    const byteCount = Buffer.byteLength(result.json, "utf8");
    log.info(`meta export — wrote ${outPath} (${byteCount} bytes)`);
  } else {
    process.stdout.write(result.json);
  }

  return 0;
}
