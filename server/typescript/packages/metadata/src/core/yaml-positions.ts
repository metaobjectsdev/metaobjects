// FR5b — YAML authoring source-position carrier (per ADR-0009).
//
// This module is split into two layers so the browser bundle (which
// imports from src/index.ts) stays free of the Node-only `yaml` package:
//
//   - yaml-positions.ts (this file) — pure types + Symbol + accessors. NO
//     `yaml` import. Imported by parser-core.ts so the source-on-node
//     stamper can read positions when stamping `format: "yaml"` envelopes.
//   - yaml-positions-walker.ts — depends on `yaml`. Imported only by
//     parser-yaml.ts (and parser-yaml itself only ships server-side).
//
// Source-map carrier (per the FR5b spec's "open question" §2): a
// Symbol-keyed, non-enumerable property on the wrapper-mapping object. The
// symbol is the well-known cross-port key
// `Symbol.for("@metaobjectsdev/yamlPositionByKey")`, so any plugin that
// touches the canonical JS can read positions if it knows to look. The
// map's keys are the wrapper's own keys (e.g. "object.entity" for a
// wrapper `{ "object.entity": { ... } }` or "name" / "package" /
// "children" for the body keys of a node).
//
// Rationale for "symbol-keyed property" over a parallel sourcemap / wrapper
// type:
//   - Invisible to JSON.stringify and Object.keys (non-enumerable).
//   - No parallel data structure to keep in sync — the position rides with
//     the node it describes.
//   - No wrapper type — desugar still operates on plain JS objects, so the
//     existing Rule 1–5 logic does not need a rewrite.
//
// On desugar-synthesized nodes (Rule 2's scalar-body lift): the synthesized
// body `{ name: rawScalar }` inherits the wrapper key's position from the
// parent's position map. On any other synthesis (Rule 4's isArray stamping,
// for example), the position survives because we shallow-copy via the
// existing desugar path.

/** Cross-port well-known symbol key for the position-by-key map. */
export const YAML_POSITION_BY_KEY = Symbol.for(
  "@metaobjectsdev/yamlPositionByKey",
);

/** A YAML source position — 1-indexed line and column. */
export interface YamlPosition {
  readonly line: number;
  readonly col: number;
}

/** The position-by-key map attached to a mapping object. */
export type PositionMap = Record<string, YamlPosition>;

/** Read the position-by-key map from a JS object, if present.
 *  Returns undefined for primitives, arrays, null, and untagged objects. */
export function getPositionMap(obj: unknown): PositionMap | undefined {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return undefined;
  }
  return (obj as { [YAML_POSITION_BY_KEY]?: PositionMap })[YAML_POSITION_BY_KEY];
}

/** Read the position for a specific key on a mapping object. */
export function getYamlPosition(
  obj: unknown,
  key: string,
): YamlPosition | undefined {
  const map = getPositionMap(obj);
  return map?.[key];
}

/** Attach (or replace) the position-by-key map on a mapping object. The map
 *  property is non-enumerable so JSON.stringify and `for (const k in obj)`
 *  loops do not see it. */
export function setPositionMap(
  obj: Record<string, unknown>,
  positions: PositionMap,
): void {
  Object.defineProperty(obj, YAML_POSITION_BY_KEY, {
    value: positions,
    enumerable: false,
    writable: true,
    configurable: true,
  });
}
