// FileMetaDataLoader — discovers file-backed MetaDataSources and runs the
// MetaDataLoader pipeline over them. A UrlMetaDataLoader will slot in the
// same way later.

import type { Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { MetaDataLoader, type LoadResult } from "../loader/meta-data-loader.js";
import { FileSource } from "./file-source.js";

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
  /**
   * Load every `.json` / `.yaml` / `.yml` file in a directory (non-recursive).
   * @param opts.exclude glob patterns (relative to dir) to skip — `*` / `**`.
   */
  async loadDirectory(dir: string, opts?: { exclude?: string[] }): Promise<LoadResult> {
    let entries: string[];
    try {
      entries = await readdir(dir);
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
