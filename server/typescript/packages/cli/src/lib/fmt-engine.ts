// server/typescript/packages/cli/src/lib/fmt-engine.ts
//
// `meta fmt` (#304) orchestration: resolve the project's own metadata files
// (resolveCollection — never a hardcoded `metaobjects/`), format each one
// standalone (@metaobjectsdev/metadata's formatMetadataFile — own-mode,
// declared-here layer only), and gate every rewrite behind a whole-project
// reload-and-compare safety check before it ever touches disk.
//
// The safety check (design rule 4): swap a candidate in via an in-memory
// source carrying the SAME file id the real load would use, reload the WHOLE
// project, and require both that it loads with no errors AND that its
// canonical serialization is byte-identical to the untouched baseline. Only
// then is the candidate written — so `--check` (which skips the write) and a
// real run share one code path, and a bug in the formatter can only ever
// leave a file unchanged plus an error, never a corrupted file.
import { basename, extname, resolve as resolvePath } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import type { MetaDataTypeProvider } from "@metaobjectsdev/metadata";
import {
  composeRegistry,
  MetaDataLoader,
  InMemoryStringSource,
  canonicalSerialize,
  formatMetadataFile,
} from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";
import { resolveCollection, defaultLoadMemoryProviders, type Collection } from "@metaobjectsdev/sdk";
import { loadMetaobjectsConfig, loadMemoryOptionsFrom } from "./load-metaobjects-config.js";

export type FmtFileStatus =
  | "formatted"
  | "would-format"
  | "unchanged"
  | "skipped-yaml"
  | "skipped-overlay"
  | "error";

export interface FmtFileReport {
  readonly path: string;
  readonly status: FmtFileStatus;
  readonly detail?: string;
}

export interface FmtRunResult {
  readonly files: readonly FmtFileReport[];
  /** Set when the run could not even start — an unresolvable collection, an
   *  explicit file argument outside the project's sources, or metadata that
   *  does not currently load cleanly. Nothing was attempted. */
  readonly fatal?: string;
}

export interface FmtRunOptions {
  readonly projectRoot: string;
  readonly check: boolean;
  /** Explicit paths (cwd-relative or absolute) narrowing the run. Omit/empty
   *  for every file the project owns. */
  readonly files?: readonly string[];
}

async function projectProviders(collection: Collection): Promise<readonly MetaDataTypeProvider[]> {
  try {
    const cfg = await loadMetaobjectsConfig(collection.configDir);
    return loadMemoryOptionsFrom(cfg).providers ?? [];
  } catch {
    // No metaobjects.config.ts (common for a non-TS-server project running
    // `meta fmt` just for schema-neutral formatting) — format against the
    // core vocabulary only, exactly like a project with no custom providers.
    return [];
  }
}

export async function runFmt(opts: FmtRunOptions): Promise<FmtRunResult> {
  let collection: Collection;
  try {
    collection = await resolveCollection(opts.projectRoot);
  } catch (err) {
    return { files: [], fatal: err instanceof Error ? err.message : String(err) };
  }

  const providers = await projectProviders(collection);
  const registry = composeRegistry([...defaultLoadMemoryProviders, ...providers]);

  let targets: readonly string[];
  if (opts.files !== undefined && opts.files.length > 0) {
    const want = new Set(opts.files.map((f) => resolvePath(opts.projectRoot, f)));
    const owned = new Set(collection.ownFiles);
    const missing = [...want].filter((f) => !owned.has(f));
    if (missing.length > 0) {
      return {
        files: [],
        fatal:
          `not among this project's resolved metadata sources: ${missing.join(", ")}\n` +
          "meta fmt only formats files resolveCollection() already resolves — pass no " +
          "arguments to format every one of them.",
      };
    }
    targets = collection.ownFiles.filter((f) => want.has(f));
  } else {
    targets = collection.ownFiles;
  }

  const sourceId = (p: string): string => collection.fileIds.get(p) ?? basename(p);

  const libSources =
    collection.libraries.length > 0
      ? (await import("@metaobjectsdev/metadata/library")).librarySources([...collection.libraries])
      : [];

  const buildSources = (overridePath?: string, overrideText?: string) => [
    ...libSources,
    ...collection.files.map((p) => {
      const id = sourceId(p);
      return overridePath !== undefined && p === overridePath
        ? new InMemoryStringSource(overrideText ?? "", { id })
        : new FileSource(p, { id });
    }),
  ];

  const baseline = await new MetaDataLoader({ registry }).load(buildSources());
  if (baseline.errors.length > 0) {
    return {
      files: [],
      fatal:
        "this project's metadata does not currently load cleanly — fix the error(s) below, " +
        "then re-run fmt:\n" +
        baseline.errors.map((e) => `  ${e.message}`).join("\n"),
    };
  }
  const baselineCanonical = canonicalSerialize(baseline.root);

  const reports: FmtFileReport[] = [];
  for (const path of targets) {
    const ext = extname(path).toLowerCase();
    if (ext === ".yaml" || ext === ".yml") {
      reports.push({
        path,
        status: "skipped-yaml",
        detail: "no canonical YAML emitter exists (ADR-0006: JSON is the canonical interchange form) — left untouched",
      });
      continue;
    }

    const content = await readFile(path, "utf8");
    const formatted = formatMetadataFile(content, { registry, sourceId: sourceId(path) });
    if (!formatted.ok) {
      reports.push(
        formatted.overlay
          ? { path, status: "skipped-overlay", detail: formatted.message }
          : { path, status: "error", detail: formatted.message },
      );
      continue;
    }

    if (formatted.text === content) {
      reports.push({ path, status: "unchanged" });
      continue;
    }

    const testLoad = await new MetaDataLoader({ registry }).load(buildSources(path, formatted.text));
    const safe = testLoad.errors.length === 0 && canonicalSerialize(testLoad.root) === baselineCanonical;
    if (!safe) {
      reports.push({
        path,
        status: "error",
        detail: "formatting this file would change the loaded model's meaning — left unchanged",
      });
      continue;
    }

    if (opts.check) {
      reports.push({ path, status: "would-format" });
    } else {
      await writeFile(path, formatted.text, "utf8");
      reports.push({ path, status: "formatted" });
    }
  }

  return { files: reports };
}
