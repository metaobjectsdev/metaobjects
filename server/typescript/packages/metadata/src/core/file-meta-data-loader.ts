// FileMetaDataLoader — discovers file-backed MetaDataSources and runs the
// MetaDataLoader pipeline over them. A UrlMetaDataLoader will slot in the
// same way later.

import type { Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { MetaDataLoader, type LoadResult } from "../loader/meta-data-loader.js";
import { FileSource } from "../loader/sources/file-source.js";
import { parseYaml } from "./parser-yaml.js";
import type { ParseOptions, ParseResult } from "../parser-core.js";
import type { MetaDataSource } from "../loader/meta-data-source.js";

/** Minimal glob matcher supporting `*` (any chars except `/`) and `**` (any chars). */
function matchSimpleGlob(pattern: string, value: string): boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "::DOUBLESTAR::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DOUBLESTAR::/g, ".*");
  return new RegExp(`^${regexStr}$`).test(value);
}

export class FileMetaDataLoader extends MetaDataLoader {
  /** Adds YAML parsing on top of the base loader's JSON-only `parseSource`. */
  protected override parseSource(
    content: string,
    source: MetaDataSource,
    parseOpts: ParseOptions,
  ): ParseResult {
    if (source.format === "yaml") {
      return parseYaml(content, parseOpts);
    }
    return super.parseSource(content, source, parseOpts);
  }

  /**
   * Load every `.json` / `.yaml` / `.yml` file in a directory (non-recursive),
   * in deterministic ordinal filename order.
   * @param opts.exclude glob patterns (relative to dir) to skip — `*` / `**`.
   */
  async loadDirectory(dir: string, opts?: { exclude?: string[] }): Promise<LoadResult> {
    let entries: string[];
    try {
      // Sorted for deterministic multi-file load order: the overlay merge is
      // order-sensitive (last-writer-wins on attr conflicts), so the scan must
      // not depend on filesystem readdir order. Ordinal filename sort is
      // reproducible across the Java/Python/C# ports.
      entries = (await readdir(dir)).sort();
    } catch (err) {
      // Surface the I/O failure as a collected error via the empty-source path.
      const emptyResult = await this.load([]);
      return {
        ...emptyResult,
        errors: [
          new Error(`loadDirectory: cannot read ${dir}: ${(err as Error).message}`),
          ...emptyResult.errors,
        ],
      };
    }

    const excludes = opts?.exclude ?? [];
    const paths: string[] = [];
    for (const entry of entries) {
      const lower = entry.toLowerCase();
      if (!lower.endsWith(".json") && !lower.endsWith(".yaml") && !lower.endsWith(".yml")) {
        continue;
      }
      const filePath = join(dir, entry);
      let statResult: Stats;
      try {
        statResult = await stat(filePath);
      } catch {
        // Entry vanished between readdir and stat (TOCTOU) or is not accessible.
        // Skip it rather than breaking the no-throw contract of loadDirectory.
        continue;
      }
      if (!statResult.isFile()) continue;
      if (excludes.some((p) => matchSimpleGlob(p, entry))) continue;
      paths.push(filePath);
    }
    return this.loadFiles(paths);
  }

  /** Load an explicit list of file paths, in order. */
  async loadFiles(paths: string[]): Promise<LoadResult> {
    return this.load(paths.map((p) => new FileSource(p)));
  }
}
