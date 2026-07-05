import { mkdtempSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { MetaDataLoader, composeRegistry, coreTypesProvider, dbProvider, docProvider, promptProvider, uiProvider } from "@metaobjectsdev/metadata";
import type { MetaData, MetaRoot, MetaDataTypeProvider } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";

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
    // Feed files in files-before-subdirs order (the same order the sdk's loadMemory
    // uses), NOT fromDirectory's flat basename sort. Cross-file overlays require the
    // base (typically a top-level file) to load before an overlay that lives in a
    // nested dir; the basename sort can otherwise process e.g.
    // `admin-ui/x.admin.yaml` before its base `x.yaml` and fail with
    // ERR_OVERLAY_NO_TARGET. (fromDirectory's basename order is a cross-port
    // DirectorySource contract, so we order at this boundary rather than change it.)
    const files = collectOrderedMetadataFiles(staging);
    const result = await new MetaDataLoader({ registry, strict: false }).load(
      files.map((f) => new FileSource(f)),
    );
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

/** Metadata files under `dir`, files-before-subdirs with each level sorted — the
 *  overlay-safe order the sdk's loadMemory uses, so a base loads before an overlay
 *  nested under it. Symlinks (the staging dir uses them) are followed. */
function collectOrderedMetadataFiles(dir: string): string[] {
  const files: string[] = [];
  const subdirs: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full); // follows symlinks — staging entries are symlinked source dirs
    if (s.isDirectory()) subdirs.push(full);
    else if (s.isFile() && /\.(json|ya?ml)$/i.test(entry)) files.push(full);
  }
  files.sort();
  const out = [...files];
  for (const sub of subdirs.sort()) out.push(...collectOrderedMetadataFiles(sub));
  return out;
}

/** Which top-level source dir a node came from (first file path segment of its source envelope). */
export function treeOf(node: MetaData, model: LoadedModel): string {
  const src = node.source as { files?: string[] };
  const f = src.files?.[0] ?? "";
  const seg = f.replace(/\\/g, "/").split("/")[0] ?? "";
  return model.sourceDirs.includes(seg) ? seg : (model.sourceDirs[0] ?? "");
}
