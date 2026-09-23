import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { parseExportArgs } from "../lib/args.js";
import { log } from "../lib/log.js";
import { FileSource } from "@metaobjectsdev/metadata/core";
import { TypeRegistry, registerCoreTypes, MetaDataLoader, canonicalSerialize } from "@metaobjectsdev/metadata";
import { registerForgeTypes, resolveCollection } from "@metaobjectsdev/sdk";
import { collectionLoadOptions } from "../lib/collection-load-options.js";

export async function exportCommand(args: string[], cwd: string): Promise<number> {
  let flags;
  try {
    flags = parseExportArgs(args);
  } catch (err) {
    log.error((err as Error).message);
    return 2;
  }

  const projectRoot = cwd;

  // Build a registry with core + forge types so metadata that includes
  // descriptive types (decision, principle, etc.) loads without errors.
  const registry = new TypeRegistry();
  registerCoreTypes(registry);
  registerForgeTypes(registry);

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
    log.error((err as Error).message);
    return 1;
  }

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
    json: canonicalSerialize(loadResult.root),
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
