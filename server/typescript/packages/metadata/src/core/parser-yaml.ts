// Authoring YAML parser.
//
// parseYaml is a front-end: parseYamlWithPositions → desugar → the shared
// buildTree (parser-core.ts). The desugar applies the four authoring-sugar
// rules so the resulting typed tree is identical to the one the equivalent
// canonical JSON produces.
//
// FR5b: the parse phase now preserves YAML source positions through the
// pipeline. parseYamlWithPositions attaches a Symbol-keyed position-by-key
// map onto every mapping object; desugar shallow-copies that property; and
// buildTree's `format: "yaml"` mode reads the position when stamping
// `node.source.yamlPosition` (see parser-core.ts).

import { ParseError } from "../errors.js";
import { buildTree } from "../parser-core.js";
import type { ParseOptions, ParseResult } from "../parser-core.js";
import type { ErrorSource } from "../source.js";
import { desugar } from "./yaml-desugar.js";
import { parseYamlWithPositions } from "./yaml-positions-walker.js";

/** FR5a / ADR-0009 — build a YAML-source envelope rooted at "$".
 *  yamlPosition on the envelope is left undefined here; envelopes for
 *  THROWN parser errors carry positions only when the parse phase pushed
 *  the path into the live parser-core builder (see populateNodeSource in
 *  parser-core.ts). Errors raised before buildTree (e.g. yaml syntax
 *  failures, an empty desugar result) lack a node — `yamlPosition` is
 *  intentionally omitted, per the spec's "skip on desugar-synthesized
 *  nodes" decision. */
function yamlSource(sourceName: string | undefined): ErrorSource {
  return {
    format: "yaml",
    files: [sourceName ?? "<unknown>"],
    jsonPath: "$",
  };
}

export function parseYaml(content: string, opts: ParseOptions): ParseResult {
  // Strip UTF-8 BOM if present (consistent with parseJson).
  const normalizedContent =
    content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;

  // YAML syntax errors throw — consistent with parseJson on invalid JSON.
  // The loader's per-source try/catch collects the throw into LoadResult.errors.
  let parsed: unknown;
  try {
    parsed = parseYamlWithPositions(normalizedContent).value;
  } catch (err) {
    throw new ParseError(
      `Invalid YAML: ${(err as Error).message}`,
      { code: "ERR_MALFORMED_YAML", source: yamlSource(opts.sourceName) },
    );
  }

  // Desugar the sugared authoring object into the canonical structure.
  const { canonical, errors: desugarErrors } = desugar(parsed, opts.registry);

  // If the desugar could not produce a usable document at all, surface the
  // first desugar error as a throw — parallels parseJson's top-level throws.
  if (Object.keys(canonical).length === 0) {
    const first = desugarErrors[0]!;
    throw new ParseError(
      first.message,
      { code: first.code ?? "ERR_MALFORMED_YAML", source: yamlSource(opts.sourceName) },
    );
  }

  // FR5b — buildTree needs to know the source-format discriminant so
  // populateNodeSource emits `format: "yaml"` envelopes (with the
  // optional yamlPosition) instead of the default `format: "json"`.
  const result = buildTree(canonical, { ...opts, sourceFormat: "yaml" });

  // Merge collected desugar errors ahead of buildTree's own collected errors.
  // Each CollectedError carries its own stable code when set (e.g.
  // ERR_YAML_COERCION from the D2 type-coercion guard); the malformed-document
  // shape errors fall back to ERR_MALFORMED_YAML.
  const desugarParseErrors = desugarErrors.map(
    (e) =>
      new ParseError(e.message, {
        code: e.code ?? "ERR_MALFORMED_YAML",
        source: yamlSource(opts.sourceName),
      }),
  );
  return {
    root: result.root,
    warnings: result.warnings,
    errors: [...desugarParseErrors, ...result.errors],
  };
}
