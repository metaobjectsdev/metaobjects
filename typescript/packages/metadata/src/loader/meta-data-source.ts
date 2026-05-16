// MetaDataSource — the raw-document unit consumed by the loader pipeline.
//
// A loader (FileMetaDataLoader, later UrlMetaDataLoader) discovers/acquires
// sources; the MetaDataLoader pipeline calls read() on each. read() is async
// so file/URL sources can do I/O; InMemorySource resolves immediately.

import { basename } from "node:path";

/** Format of a source's content. Phase 2 supports JSON only; XML/YAML land in Phase 3. */
export type MetaDataFormat = "json";

/** One unit of raw metadata input. */
export interface MetaDataSource {
  /** Human-readable identifier — used in parse-error messages (e.g. a filename). */
  readonly id: string;
  /** Content format hint — selects the parser. */
  readonly format: MetaDataFormat;
  /** Resolve the raw content. May perform I/O. */
  read(): Promise<string>;
}

/** A metadata source backed by an in-memory string. */
export class InMemorySource implements MetaDataSource {
  readonly id: string;
  readonly format: MetaDataFormat;
  private readonly _content: string;

  constructor(content: string, opts?: { id?: string; format?: MetaDataFormat }) {
    this._content = content;
    this.id = opts?.id ?? "<in-memory>";
    this.format = opts?.format ?? "json";
  }

  read(): Promise<string> {
    return Promise.resolve(this._content);
  }
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
    this.format = "json"; // Phase 2: only .json files; format inference expands in Phase 3.
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
