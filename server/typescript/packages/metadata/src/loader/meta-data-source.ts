// MetaDataSource — the raw-document unit consumed by the loader pipeline.
//
// A loader (MetaDataLoader, fed by FileSource/DirectorySource/UriSource/
// InMemoryStringSource) parses each source's content. read() is async so file
// and URI sources can do I/O; InMemoryStringSource resolves immediately.

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

/**
 * A metadata source backed by an in-memory string. The default identity is
 * `"<inline>"` — matches the cross-language convention shared by the Java /
 * C# / Python ports.
 */
export class InMemoryStringSource implements MetaDataSource {
  readonly id: string;
  readonly format: MetaDataFormat;
  private readonly _content: string;

  constructor(content: string, opts?: { id?: string; format?: MetaDataFormat }) {
    this._content = content;
    this.id = opts?.id ?? "<inline>";
    this.format = opts?.format ?? "json";
  }

  read(): Promise<string> {
    return Promise.resolve(this._content);
  }
}
