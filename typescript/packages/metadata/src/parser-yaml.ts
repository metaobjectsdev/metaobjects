// Authoring YAML parser.
//
// parseYaml is a front-end: yaml.parse → desugar → the shared buildTree
// (parser-core.ts). The desugar applies the four authoring-sugar rules so the
// resulting typed tree is identical to the one the equivalent canonical JSON
// produces.

import { parse as parseYamlText } from "yaml";
import { ParseError } from "./errors.js";
import { buildTree, errOpts } from "./parser-core.js";
import type { ParseOptions, ParseResult } from "./parser-core.js";
import { desugar } from "./yaml-desugar.js";

export function parseYaml(content: string, opts: ParseOptions): ParseResult {
  // Strip UTF-8 BOM if present (consistent with parseJson).
  const normalizedContent =
    content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;

  // YAML syntax errors throw — consistent with parseJson on invalid JSON.
  // The loader's per-source try/catch collects the throw into LoadResult.errors.
  let parsed: unknown;
  try {
    parsed = parseYamlText(normalizedContent);
  } catch (err) {
    throw new ParseError(
      `Invalid YAML: ${(err as Error).message}`,
      errOpts(opts.sourceName),
    );
  }

  // Desugar the sugared authoring object into the canonical structure.
  const { canonical, errors: desugarErrors } = desugar(parsed, opts.registry);

  // If the desugar could not produce a usable document at all, surface the
  // first desugar error as a throw — parallels parseJson's top-level throws.
  if (Object.keys(canonical).length === 0) {
    throw new ParseError(
      desugarErrors[0]!,
      errOpts(opts.sourceName),
    );
  }

  const result = buildTree(canonical, opts);

  // Merge collected desugar errors ahead of buildTree's own collected errors.
  const desugarParseErrors = desugarErrors.map(
    (msg) => new ParseError(msg, errOpts(opts.sourceName)),
  );
  return {
    root: result.root,
    warnings: result.warnings,
    errors: [...desugarParseErrors, ...result.errors],
  };
}
