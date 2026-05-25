// DirectorySource — expands a directory into a sorted list of FileSource.
//
// Discovers .json / .yaml / .yml files (case-insensitive on extension).
// Recurses by default — matches Java/Python/C# DirectorySource behavior.
// Sort order is ordinal-by-basename so the overlay merge is deterministic
// across environments and language ports.

import { readdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { FileSource } from "./file-source.js";
import type { MetaDataSource } from "../meta-data-source.js";

export interface DirectoryOptions {
  /** Filename patterns to exclude. Supports literal match and `*` / `**` globs. */
  exclude?: string[];
  /** Recurse into subdirectories. Default: true. */
  recurse?: boolean;
}

const SUPPORTED_EXTS = new Set([".json", ".yaml", ".yml"]);

/** Minimal glob matcher supporting `*` (any chars except `/`) and `**` (any chars). */
function matchSimpleGlob(pattern: string, value: string): boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "::DOUBLESTAR::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DOUBLESTAR::/g, ".*");
  return new RegExp(`^${regexStr}$`).test(value);
}

export class DirectorySource {
  constructor(
    public readonly directory: string,
    public readonly opts: DirectoryOptions = {},
  ) {}

  async expand(): Promise<MetaDataSource[]> {
    const recurse = this.opts.recurse ?? true;
    const exclude = this.opts.exclude ?? [];

    const files = await this.collect(this.directory, recurse);
    const filtered: string[] = [];
    for (const p of files) {
      if (!SUPPORTED_EXTS.has(extname(p).toLowerCase())) continue;
      const name = basename(p);
      if (exclude.some((pat) => matchSimpleGlob(pat, name))) continue;
      filtered.push(p);
    }

    // Sort by basename (ordinal) for deterministic overlay order. The
    // pre-unification FileMetaDataLoader sorted readdir entries (basenames)
    // for the same reason — that contract carries forward here.
    filtered.sort((a, b) => {
      const an = basename(a);
      const bn = basename(b);
      return an < bn ? -1 : an > bn ? 1 : 0;
    });

    return filtered.map((p) => new FileSource(p));
  }

  private async collect(dir: string, recurse: boolean): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (err) {
      throw new Error(
        `DirectorySource: cannot read ${dir}: ${(err as Error).message}`,
      );
    }
    const out: string[] = [];
    for (const entry of entries) {
      const full = join(dir, entry);
      let s;
      try {
        s = await stat(full);
      } catch {
        // Entry vanished between readdir and stat (TOCTOU) or is not accessible.
        continue;
      }
      if (s.isDirectory()) {
        if (recurse) out.push(...(await this.collect(full, recurse)));
      } else if (s.isFile()) {
        out.push(full);
      }
    }
    return out;
  }
}
