// UriSource — a MetaDataSource that fetches content from a URI.
// Supports file://, http://, and https:// schemes.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname } from "node:path";
import type { MetaDataFormat, MetaDataSource } from "../meta-data-source.js";

function inferFormat(uri: string): MetaDataFormat {
  // URL constructor handles file://, http://, https:// uniformly.
  // Strip query/fragment by reading .pathname.
  try {
    const pathname = new URL(uri).pathname;
    const ext = extname(pathname).toLowerCase();
    return ext === ".yaml" || ext === ".yml" ? "yaml" : "json";
  } catch {
    // If the URI isn't a valid URL, fall back to JSON.
    return "json";
  }
}

export class UriSource implements MetaDataSource {
  readonly id: string;
  readonly format: MetaDataFormat;

  constructor(public readonly uri: string, format?: MetaDataFormat) {
    this.id = uri;
    this.format = format ?? inferFormat(uri);
  }

  async read(): Promise<string> {
    if (this.uri.startsWith("file://")) {
      return readFile(fileURLToPath(this.uri), "utf-8");
    }
    if (this.uri.startsWith("http://") || this.uri.startsWith("https://")) {
      const res = await fetch(this.uri);
      if (!res.ok) {
        throw new Error(`UriSource: ${this.uri} -> HTTP ${res.status}`);
      }
      return res.text();
    }
    throw new Error(`UriSource: unsupported scheme on ${this.uri}`);
  }
}
