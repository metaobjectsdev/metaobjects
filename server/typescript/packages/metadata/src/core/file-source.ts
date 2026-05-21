// FileSource — a MetaDataSource backed by a file on disk. Server-side only
// (touches node:fs); lives under src/core/ so the browser-safe root never
// imports it.

import { basename, extname } from "node:path";
import type { MetaDataFormat, MetaDataSource } from "../loader/meta-data-source.js";

/** Infer a source format from a file extension. `.yaml`/`.yml` → "yaml";
 *  everything else (including `.json`) → "json", the canonical default. */
function inferFormat(path: string): MetaDataFormat {
  const ext = extname(path).toLowerCase();
  return ext === ".yaml" || ext === ".yml" ? "yaml" : "json";
}

// File reader — Bun-first (Bun.file().text()) with a Node fallback
// (node:fs/promises.readFile). Matches CLAUDE.md's Bun-first / Node-compatible policy.
let _readText: ((path: string) => Promise<string>) | undefined;

async function getReadText(): Promise<(path: string) => Promise<string>> {
  if (_readText !== undefined) return _readText;
  if (typeof Bun !== "undefined") {
    _readText = (p) => Bun.file(p).text();
  } else {
    const { readFile } = await import("node:fs/promises");
    _readText = (p) => readFile(p, "utf-8");
  }
  return _readText;
}

/** A metadata source backed by a file on disk. */
export class FileSource implements MetaDataSource {
  readonly id: string;
  readonly format: MetaDataFormat;
  private readonly _path: string;

  constructor(path: string) {
    this._path = path;
    // basename() for readable error messages; cross-platform (handles both / and \). Full path retained for read().
    this.id = basename(path);
    this.format = inferFormat(path);
  }

  /** The absolute/relative path this source reads from. */
  get path(): string {
    return this._path;
  }

  async read(): Promise<string> {
    const readText = await getReadText();
    return readText(this._path);
  }
}
