import { resolve, join } from "node:path";
import { writeFile } from "node:fs/promises";
import { parseExportArgs } from "../lib/args.js";
import { log } from "../lib/log.js";
import { loadAndExportJson } from "@metaobjects/metadata/core";
import { TypeRegistry, registerCoreTypes } from "@metaobjects/metadata";
import { DEFAULT_METADATA_DIR, registerForgeTypes } from "@metaobjects/sdk";

export async function exportCommand(args: string[], cwd: string): Promise<number> {
  let flags;
  try {
    flags = parseExportArgs(args);
  } catch (err) {
    log.error((err as Error).message);
    return 2;
  }

  const projectRoot = cwd;
  const metadataDir = join(projectRoot, DEFAULT_METADATA_DIR);

  // Build a registry with core + forge types so metadata that includes
  // descriptive types (decision, principle, etc.) loads without errors.
  const registry = new TypeRegistry();
  registerCoreTypes(registry);
  registerForgeTypes(registry);

  const result = await loadAndExportJson(metadataDir, { registry });

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
