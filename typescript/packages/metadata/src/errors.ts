// Typed error classes for the metadata parser.

export class ParseError extends Error {
  readonly source: string | undefined;
  readonly path: string | undefined; // logical path within the JSON, e.g. "metadata.children[2].field"

  constructor(message: string, opts?: { source?: string; path?: string }) {
    super(message);
    this.name = "ParseError";
    this.source = opts?.source;
    this.path = opts?.path;
  }
}
