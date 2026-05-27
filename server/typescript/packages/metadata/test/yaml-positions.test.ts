// FR5b — YAML source-position tracking through the desugar + loader.
//
// The walker (core/yaml-positions-walker.ts) attaches a Symbol-keyed
// position-by-key map to every YAML mapping; the desugar (core/yaml-desugar.ts)
// preserves it through Rule-1/2/4/5 rewrites; parser-core (parser-core.ts)
// reads the wrapper's position when stamping `source.yamlPosition` on each
// constructed MetaData.
//
// FR5b finalized 2026-05-27 — all four ports flipped YAML-input source
// envelopes from `format: "json"` to `format: "yaml"` and the cross-port
// yaml-conformance fixtures' format discriminator was mass-updated to stay
// byte-stable. The new tier is the OPTIONAL `yamlPosition: {line, col}`
// field — empty for nodes the desugar synthesized without a YAML source
// position (e.g. an empty body), populated for every node that traces
// directly back to a YAML key.

import { test, expect } from "bun:test";
import { TypeRegistry } from "../src/registry.js";
import { registerCoreTypes, coreProviders } from "../src/core-types.js";
import { composeRegistry } from "../src/provider.js";
import { parseYaml } from "../src/core/parser-yaml.js";
import { parseJson } from "../src/parser-json.js";
import {
  parseYamlWithPositions,
} from "../src/core/yaml-positions-walker.js";
import {
  getYamlPosition,
  getPositionMap,
  YAML_POSITION_BY_KEY,
} from "../src/core/yaml-positions.js";
import { desugar } from "../src/core/yaml-desugar.js";
import { TYPE_FIELD, TYPE_OBJECT } from "../src/index.js";

function coreRegistry(): TypeRegistry {
  const registry = new TypeRegistry();
  registerCoreTypes(registry);
  return registry;
}

function fullRegistry(): TypeRegistry {
  return composeRegistry(coreProviders);
}

// ---------------------------------------------------------------------------
// Walker layer — position-by-key maps land on every mapping.
// ---------------------------------------------------------------------------

test("walker: every mapping in a YAML doc carries a position-by-key map", () => {
  const yaml =
    "metadata.root:\n" +
    "  package: acme\n" +
    "  children:\n" +
    "    - object.entity:\n" +
    "        name: Foo\n";
  const { value } = parseYamlWithPositions(yaml);
  const v = value as Record<string, unknown>;

  // Root wrapper has a position for "metadata.root".
  expect(getYamlPosition(v, "metadata.root")).toEqual({ line: 1, col: 1 });

  // Root body has positions for "package" and "children".
  const rootBody = v["metadata.root"] as Record<string, unknown>;
  expect(getYamlPosition(rootBody, "package")).toEqual({ line: 2, col: 3 });
  expect(getYamlPosition(rootBody, "children")).toEqual({ line: 3, col: 3 });

  // The single child wrapper points at the "object.entity" line.
  const children = rootBody["children"] as unknown[];
  const childWrapper = children[0] as Record<string, unknown>;
  expect(getYamlPosition(childWrapper, "object.entity")).toEqual({
    line: 4,
    col: 7,
  });

  // The child body points at the "name" line.
  const childBody = childWrapper["object.entity"] as Record<string, unknown>;
  expect(getYamlPosition(childBody, "name")).toEqual({ line: 5, col: 9 });
});

test("walker: the position-by-key map is non-enumerable (invisible to JSON.stringify)", () => {
  const yaml = "metadata.root:\n  package: acme\n";
  const { value } = parseYamlWithPositions(yaml);
  // The symbol property should be defined but non-enumerable.
  const v = value as Record<string, unknown>;
  expect(getPositionMap(v)).toBeDefined();
  // JSON.stringify and Object.keys ignore non-enumerable symbol-keyed props.
  const j = JSON.stringify(value);
  expect(j).not.toContain("yamlPosition");
  expect(Object.getOwnPropertyDescriptor(v, YAML_POSITION_BY_KEY)?.enumerable).toBe(false);
});

test("walker: an anchor alias is resolved to its target value (positions still attached on the target's container)", () => {
  const yaml =
    "metadata.root:\n" +
    "  children:\n" +
    "    - field.string:\n" +
    "        name: sku\n" +
    "        '@column': &col sku_code\n" +
    "    - field.string:\n" +
    "        name: altSku\n" +
    "        '@column': *col\n";
  const { value } = parseYamlWithPositions(yaml);
  const v = value as Record<string, unknown>;
  // Both fields' `@column` should resolve to "sku_code" (alias resolved).
  const children = (v["metadata.root"] as Record<string, unknown>)[
    "children"
  ] as unknown[];
  const first = (children[0] as Record<string, unknown>)[
    "field.string"
  ] as Record<string, unknown>;
  const second = (children[1] as Record<string, unknown>)[
    "field.string"
  ] as Record<string, unknown>;
  expect(first["@column"]).toBe("sku_code");
  expect(second["@column"]).toBe("sku_code");
});

// ---------------------------------------------------------------------------
// Desugar layer — positions survive the four sugar-rule transforms.
// ---------------------------------------------------------------------------

test("desugar: Rule-5 sigil-free attrs preserve their YAML key's position under the @-prefix", () => {
  const yaml =
    "object.entity:\n" +
    "  name: Foo\n" +
    "  filterable: true\n";
  const { value } = parseYamlWithPositions(yaml);
  const { canonical } = desugar(value, fullRegistry());
  const body = (canonical as Record<string, unknown>)[
    "object.entity"
  ] as Record<string, unknown>;
  // Rule 5 rewrites bare `filterable` to canonical `@filterable`; the
  // re-keyed position must point at the original `filterable:` line.
  expect(getYamlPosition(body, "@filterable")).toEqual({ line: 3, col: 3 });
  // Reserved structural keys keep their bare form and bare position.
  expect(getYamlPosition(body, "name")).toEqual({ line: 2, col: 3 });
});

test("desugar: Rule-2 scalar body inherits the wrapper key's position on its synthesized `name` slot", () => {
  // `field.string: sku` lifts to `{ field.string: { name: "sku" } }` —
  // the synthesized `name` has no YAML key of its own, so the FR5b spec
  // says it inherits the wrapper key's position.
  const yaml =
    "metadata.root:\n" +
    "  children:\n" +
    "    - field.string: sku\n";
  const { value } = parseYamlWithPositions(yaml);
  const { canonical } = desugar(value, coreRegistry());
  const root = (canonical as Record<string, unknown>)[
    "metadata.root"
  ] as Record<string, unknown>;
  const children = root["children"] as unknown[];
  const childWrapper = children[0] as Record<string, unknown>;
  const childBody = childWrapper["field.string"] as Record<string, unknown>;
  // The wrapper key's position is line 3.
  expect(getYamlPosition(childWrapper, "field.string")).toEqual({
    line: 3,
    col: 7,
  });
  // The synthesized `name` inherits the wrapper key's position.
  expect(getYamlPosition(childBody, "name")).toEqual({ line: 3, col: 7 });
});

test("desugar: Rule-4 `[]` suffix preserves the wrapper key's position under the un-suffixed canonical key", () => {
  const yaml =
    "object.entity:\n" +
    "  name: Foo\n" +
    "  children:\n" +
    "    - field.long[]: weekIds\n";
  const { value } = parseYamlWithPositions(yaml);
  const { canonical } = desugar(value, coreRegistry());
  const root = (canonical as Record<string, unknown>)[
    "object.entity"
  ] as Record<string, unknown>;
  const children = root["children"] as unknown[];
  const childWrapper = children[0] as Record<string, unknown>;
  // The canonical wrapper key is `field.long` (sans `[]`); position points
  // at the YAML `field.long[]:` line.
  expect(getYamlPosition(childWrapper, "field.long")).toEqual({
    line: 4,
    col: 7,
  });
});

// ---------------------------------------------------------------------------
// Loader layer — `node.source.yamlPosition` is populated end-to-end.
// ---------------------------------------------------------------------------

test("loader: every YAML-loaded node carries source.yamlPosition", () => {
  const yaml =
    "metadata.root:\n" +
    "  package: acme\n" +
    "  children:\n" +
    "    - object.entity:\n" +
    "        name: Foo\n" +
    "        children:\n" +
    "          - field.string:\n" +
    "              name: id\n";
  const result = parseYaml(yaml, {
    registry: coreRegistry(),
    sourceName: "input.yaml",
  });
  expect(result.errors).toEqual([]);

  // Root
  const root = result.root;
  expect(root.source.format).toBe("yaml"); // FR5b finalized 2026-05-27
  expect("yamlPosition" in root.source ? root.source.yamlPosition : undefined)
    .toEqual({ line: 1, col: 1 });

  // Object.entity
  const foo = root.ownChildren()[0]!;
  expect(foo.type).toBe(TYPE_OBJECT);
  expect("yamlPosition" in foo.source ? foo.source.yamlPosition : undefined)
    .toEqual({ line: 4, col: 7 });

  // field.string
  const id = foo.ownChildren()[0]!;
  expect(id.type).toBe(TYPE_FIELD);
  expect("yamlPosition" in id.source ? id.source.yamlPosition : undefined)
    .toEqual({ line: 7, col: 13 });
});

test("loader: a JSON-loaded node has NO yamlPosition (control)", () => {
  // The JSON parser path does not enable the FR5b yaml-format branch; the
  // node's `source` is the FR5a envelope with no yamlPosition field.
  const result = parseJson(
    JSON.stringify({
      "metadata.root": { package: "acme", children: [] },
    }),
    { registry: coreRegistry(), sourceName: "input.json" },
  );
  expect(result.errors).toEqual([]);
  expect(result.root.source.format).toBe("json");
  expect(
    "yamlPosition" in result.root.source
      ? result.root.source.yamlPosition
      : undefined,
  ).toBeUndefined();
});

test("loader: a Rule-2 scalar-body node's yamlPosition points at the wrapper key's line", () => {
  const yaml =
    "metadata.root:\n" +
    "  package: acme\n" +
    "  children:\n" +
    "    - object.entity:\n" +
    "        name: Foo\n" +
    "        children:\n" +
    "          - field.string: sku\n";
  const result = parseYaml(yaml, {
    registry: coreRegistry(),
    sourceName: "input.yaml",
  });
  expect(result.errors).toEqual([]);
  const field = result.root.ownChildren()[0]!.ownChildren()[0]!;
  expect(field.name).toBe("sku");
  // Wrapper key `field.string:` is on line 7.
  expect(
    "yamlPosition" in field.source ? field.source.yamlPosition : undefined,
  ).toEqual({ line: 7, col: 13 });
});

test("loader: a node parsed mid-error (ERR_RESERVED_ATTR) carries the YAML position", () => {
  // Authoring an `@-prefixed reserved word` (e.g. `@isArray`) is a hard
  // ERR_RESERVED_ATTR. The error envelope should now include the YAML
  // position pointing at the bad line.
  const yaml =
    "metadata.root:\n" +
    "  package: acme\n" +
    "  children:\n" +
    "    - object.entity:\n" +
    "        name: Foo\n" +
    "        '@isArray': true\n";
  const result = parseYaml(yaml, {
    registry: coreRegistry(),
    sourceName: "input.yaml",
  });
  expect(result.errors.length).toBeGreaterThan(0);
  const err = result.errors.find((e) => e.code === "ERR_RESERVED_ATTR");
  expect(err).toBeDefined();
  const src = err!.source;
  // The error fires while parser-core is INSIDE object.entity, so the
  // current yamlPosition is the object.entity wrapper-key's line (4).
  expect("yamlPosition" in src ? src.yamlPosition : undefined).toEqual({
    line: 4,
    col: 7,
  });
});

test("loader: an empty-body node (`field.string:` with nothing after) has no yamlPosition", () => {
  // Per the FR5b spec's "Skip yamlPosition on desugar-synthesized nodes"
  // recommendation: a body with NO keys (the empty-body case) generates
  // no body-side positions, so the wrapper-key's position is the only
  // surfaced one — and that's what `source.yamlPosition` reflects on the
  // resulting node.
  const yaml =
    "metadata.root:\n" +
    "  children:\n" +
    "    - field.string:\n";
  const result = parseYaml(yaml, {
    registry: coreRegistry(),
    sourceName: "input.yaml",
  });
  expect(result.errors).toEqual([]);
  const field = result.root.ownChildren()[0]!;
  // Wrapper position survives even when the body is empty.
  expect(
    "yamlPosition" in field.source ? field.source.yamlPosition : undefined,
  ).toEqual({ line: 3, col: 7 });
});
