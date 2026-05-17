// MetaDataSource — the raw-document unit consumed by the loader pipeline.
//
// A loader (FileMetaDataLoader, later UrlMetaDataLoader) discovers/acquires
// sources; the MetaDataLoader pipeline calls read() on each. read() is async
// so file/URL sources can do I/O; InMemorySource resolves immediately.

/** Format of a source's content. Selects the parser. */
export type MetaDataFormat = "json" | "yaml";

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
