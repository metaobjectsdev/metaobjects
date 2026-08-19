import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { parseExportArgs } from "../lib/args.js";
import { log } from "../lib/log.js";
import { FileSource } from "@metaobjectsdev/metadata/core";
import { TypeRegistry, registerCoreTypes, MetaDataLoader, canonicalSerialize } from "@metaobjectsdev/metadata";
import { registerForgeTypes, resolveCollection } from "@metaobjectsdev/sdk";

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
  let files: readonly string[];
  try {
    files = (await resolveCollection(projectRoot)).files;
  } catch (err) {
    log.error((err as Error).message);
    return 1;
  }

  // `loadAndExportJson` only accepts a scanned directory (`MetaDataLoader.fromDirectory`);
  // `resolveCollection` already resolved the file SET (declared `sources`, or the
  // `metaobjects/` default), so load that list directly via the same loader +
  // serializer `loadAndExportJson` composes, rather than re-deriving a directory.
  const loadResult = await new MetaDataLoader({ registry }).load(
    files.map((f) => new FileSource(f)),
  );
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
