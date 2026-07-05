import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { MetaDataLoader, composeRegistry, coreTypesProvider, dbProvider, docProvider, promptProvider, uiProvider } from "@metaobjectsdev/metadata";
import type { MetaData, MetaRoot, MetaDataTypeProvider } from "@metaobjectsdev/metadata";

export interface LoadedModel {
  root: MetaRoot;
  warnings: string[];
  sourceDirs: string[];
}

/**
 * Load N metadata source dirs into ONE root via a staging dir of symlinks.
 *
 * `extraProviders` are consumer-supplied metamodel providers, composed AFTER
 * the built-in bundle (core-types + db + doc + prompt + ui) — mirroring
 * `loadMemory`'s `providers` option — so a site can document metadata that uses
 * custom field/view/object subtypes (e.g. a project's `metaobjects.config.ts`
 * `providers`). Defaults to none, so config-less callers are unchanged.
 */
export async function loadModel(
  sourceDirs: string[],
  extraProviders: readonly MetaDataTypeProvider[] = [],
): Promise<LoadedModel> {
  const staging = mkdtempSync(join(tmpdir(), "metadocs-"));
  try {
    const usedBasenames = new Set<string>();
    for (const dir of sourceDirs) {
      const baseName = basename(dir);
      if (usedBasenames.has(baseName)) {
        throw new Error(`duplicate source dir basename: ${baseName}`);
      }
      usedBasenames.add(baseName);
      symlinkSync(resolve(dir), join(staging, baseName));
    }
    const registry = composeRegistry([coreTypesProvider, dbProvider, docProvider, promptProvider, uiProvider, ...extraProviders]);
    const result = await MetaDataLoader.fromDirectory(staging, { registry, strict: false });
    if (result.errors.length > 0) {
      throw new Error(`metadata load failed:\n${result.errors.map((e) => String(e)).join("\n")}`);
    }
    return {
      root: result.root,
      warnings: result.warnings.map((w) => w.message),
      sourceDirs: sourceDirs.map((d) => basename(resolve(d))),
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Which top-level source dir a node came from (first file path segment of its source envelope). */
export function treeOf(node: MetaData, model: LoadedModel): string {
  const src = node.source as { files?: string[] };
  const f = src.files?.[0] ?? "";
  const seg = f.replace(/\\/g, "/").split("/")[0] ?? "";
  return model.sourceDirs.includes(seg) ? seg : (model.sourceDirs[0] ?? "");
}
