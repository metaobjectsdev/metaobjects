// FR5b — YAML AST → JS walker that preserves source positions.
//
// This module is the only place inside @metaobjectsdev/metadata that
// imports the `yaml` package. It lives in core/ alongside parser-yaml.ts,
// and is reached only via that parser — never via src/index.ts. The
// browser-safety test guards this invariant.

import {
  parseDocument,
  isAlias,
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  type Document,
} from "yaml";

import {
  setPositionMap,
  type PositionMap,
} from "./yaml-positions.js";

/** Result of parsing YAML text with positions retained. */
export interface YamlParseResult {
  /** The JS object (same shape as `yaml.parse(text)` returns), with
   *  position-by-key maps attached to every mapping. */
  value: unknown;
  /** The yaml library's LineCounter — exposed for callers that need to map
   *  additional ranges (e.g. surfacing errors raised by the YAML library
   *  itself). */
  lineCounter: LineCounter;
}

/** Parse YAML text and return a JS object with positions attached.
 *
 *  Mirrors the contract of `yaml.parse(text)` for the shapes the metaobjects
 *  authoring grammar uses (mappings, sequences, scalars). Aliases and tags
 *  are deferred via the underlying parseDocument call — i.e. they resolve as
 *  the library normally would.
 *
 *  Throws on YAML syntax errors (same behavior as `yaml.parse`). */
export function parseYamlWithPositions(text: string): YamlParseResult {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter });
  // Surface YAML syntax errors as a throw, matching `yaml.parse` behavior.
  // (parseDocument collects them rather than throwing.)
  if (doc.errors.length > 0) {
    throw doc.errors[0]!;
  }
  const value = yamlNodeToJs(doc.contents, lineCounter, doc);
  return { value, lineCounter };
}

// Walk a yaml AST node into a JS structure. For each YAMLMap, attach a
// position-by-key map onto the resulting JS object — the position of each
// key is the (line, col) of the KEY token in the YAML source.
function yamlNodeToJs(
  node: unknown,
  lineCounter: LineCounter,
  doc: Document,
): unknown {
  if (node === null || node === undefined) return null;
  if (isScalar(node)) {
    // Honour the library's default scalar typing (numbers / booleans /
    // strings / null all come through Scalar.value).
    return node.value;
  }
  if (isAlias(node)) {
    // Resolve an anchor alias (e.g. `*col` after `&col sku_code`) to its
    // target value — same behaviour as the library's toJS().
    const target = node.resolve(doc);
    return yamlNodeToJs(target, lineCounter, doc);
  }
  if (isMap(node)) {
    const out: Record<string, unknown> = {};
    const positions: PositionMap = {};
    let hasAnyPosition = false;
    for (const pair of node.items) {
      // Only string-keyed entries are valid in metaobjects authoring; ignore
      // exotic keys (numeric / complex) — they'd already break the desugar.
      if (!isScalar(pair.key)) continue;
      const keyText = String(pair.key.value);
      const valueJs = yamlNodeToJs(pair.value, lineCounter, doc);
      out[keyText] = valueJs;
      const keyRange = pair.key.range;
      if (keyRange !== null && keyRange !== undefined) {
        const pos = lineCounter.linePos(keyRange[0]);
        positions[keyText] = { line: pos.line, col: pos.col };
        hasAnyPosition = true;
      }
    }
    if (hasAnyPosition) setPositionMap(out, positions);
    return out;
  }
  if (isSeq(node)) {
    return node.items.map((item) => yamlNodeToJs(item, lineCounter, doc));
  }
  // Tags / unsupported — fall back to null. The metaobjects authoring
  // grammar does not use them.
  return null;
}
