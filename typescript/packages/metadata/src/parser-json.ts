// Canonical JSON parser.
//
// parseJson is a thin front-end: strip the UTF-8 BOM, JSON.parse, then hand
// the canonical object to the shared buildTree (parser-core.ts).

import { ParseError } from "./errors.js";
import { buildTree, errOpts } from "./parser-core.js";
import type { ParseOptions, ParseResult } from "./parser-core.js";

export type { ParseOptions, ParseResult } from "./parser-core.js";

export function parseJson(content: string, opts: ParseOptions): ParseResult {
  // Strip UTF-8 BOM if present (Java-authored files often have it).
  const normalizedContent =
    content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;

  let parsed: unknown;
  try {
    parsed = JSON.parse(normalizedContent);
  } catch (err) {
    throw new ParseError(
      `Invalid JSON: ${(err as Error).message}`,
      { ...errOpts(opts.sourceName), code: "ERR_MALFORMED_JSON" },
    );
  }

  return buildTree(parsed, opts);
}
