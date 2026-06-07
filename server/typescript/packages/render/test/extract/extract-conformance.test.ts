import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { extract } from "../../src/extract/extract.js";
import {
  Format,
  FieldKind,
  scalar,
  enumField,
  enumArray,
  range,
  object,
  textContentField,
  type FieldSpec,
  type ExtractSchema,
} from "../../src/extract/types.js";
import type { NormalizeMode } from "../../src/extract/normalize.js";

// FR-010 cross-language extract-conformance corpus runner — the correctness gate.
// Each fixture dir under fixtures/extract-conformance/ holds:
//   schema.json   { "format": "JSON"|"XML", "rootName": "...", "fields": [...] }
//   input.txt     the raw (possibly dirty) LLM output
//   expected.json { "empty": bool, "states": { path: FieldExtraction }, "data": { field: value } }
// All cases must pass. The corpus is the oracle — do not weaken assertions.
// Mirrors ExtractConformanceTest.java / ExtractConformanceTests.cs exactly.

/** Walk up from this test dir to the repo root that contains fixtures/extract-conformance. */
function corpusRoot(): string {
  let dir = import.meta.dir;
  for (;;) {
    const candidate = join(dir, "fixtures", "extract-conformance");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("fixtures/extract-conformance not found");
    dir = parent;
  }
}

interface ExpectedJson {
  empty: boolean;
  states: Record<string, string>;
  data: Record<string, unknown>;
}

function parseFormat(s: string): Format {
  switch (s) {
    case "JSON":
      return Format.JSON;
    case "XML":
      return Format.XML;
    default:
      throw new Error(`Unknown format: ${s}`);
  }
}

function parseFieldKind(s: string): FieldKind {
  switch (s) {
    case "STRING":
      return FieldKind.STRING;
    case "INT":
      return FieldKind.INT;
    case "LONG":
      return FieldKind.LONG;
    case "DOUBLE":
      return FieldKind.DOUBLE;
    case "BOOLEAN":
      return FieldKind.BOOLEAN;
    case "ENUM":
      return FieldKind.ENUM;
    case "OBJECT":
      return FieldKind.OBJECT;
    default:
      throw new Error(`Unknown field kind: ${s}`);
  }
}

interface RawFieldJson {
  name: string;
  kind: string;
  required?: boolean;
  array?: boolean;
  enumValues?: string[];
  enumAlias?: Record<string, string>;
  // FR-011: enum coercion-pipeline schema keys.
  coerceDefault?: string;
  normalize?: string;
  default?: string;
  min?: number;
  max?: number;
  // @xmlText: scalar field that receives its element's text content (the #text sentinel).
  textContent?: boolean;
  // FR-011: nested-object sub-fields (present only for kind === "OBJECT").
  fields?: RawFieldJson[];
}

function parseNormalize(s: string | undefined): NormalizeMode {
  switch (s) {
    case undefined:
      return "strip"; // FR-011 global default
    case "none":
    case "collapse":
    case "strip":
      return s;
    default:
      throw new Error(`Unknown normalize mode: ${s}`);
  }
}

function parseField(f: RawFieldJson): FieldSpec {
  const name = f.name;
  const kind = parseFieldKind(f.kind);
  const required = f.required === true;

  if (kind === FieldKind.ENUM) {
    const build = f.array === true ? enumArray : enumField;
    return build(
      name,
      required,
      f.enumValues ?? [],
      f.enumAlias ?? {},
      f.coerceDefault ?? null,
      parseNormalize(f.normalize),
      f.default ?? null,
    );
  }
  if (kind === FieldKind.OBJECT) {
    const nested =
      f.fields === undefined
        ? null
        : { format: Format.JSON, rootName: name, fields: f.fields.map(parseField) };
    return object(name, required, f.array === true, nested);
  }
  if (f.min !== undefined || f.max !== undefined) {
    return range(name, kind, required, f.min ?? null, f.max ?? null);
  }
  // @xmlText: a scalar field that receives its element's text content (the #text sentinel).
  if (f.textContent === true) return textContentField(name, kind, required);
  // Phase B (generalized @default): a scalar `default` key fills an absent field, coerced to kind.
  return scalar(name, kind, required, f.default ?? null);
}

interface RawSchemaJson {
  format: string;
  rootName: string;
  // Optional per-fixture parse option: rootless XML (the response has no wrapper root element).
  rootless?: boolean;
  fields: RawFieldJson[];
}

function parseSchema(n: RawSchemaJson): ExtractSchema {
  return {
    format: parseFormat(n.format),
    rootName: n.rootName,
    fields: (n.fields ?? []).map(parseField),
  };
}

function assertCanonical(caseName: string, path: string, expected: unknown, actual: unknown): void {
  if (typeof expected === "number") {
    expect(typeof actual === "number" ? Math.abs(expected - (actual as number)) <= 1e-9 : false).toBe(true);
  } else {
    const expectedStr = typeof expected === "string" ? expected : String(expected);
    const actualStr = actual == null ? String(actual) : typeof actual === "string" ? actual : String(actual);
    expect(actualStr).toBe(expectedStr);
  }
}

/**
 * Flatten an assembled-data value into dotted leaf paths: objects recurse by key
 * (`prefix.key`), arrays recurse by index (`prefix[i]`), and every terminal scalar is recorded.
 * Mirrors the engine's per-field state enumeration so data leaves line up with state leaves.
 */
function flattenLeaves(prefix: string, value: unknown, out: Record<string, unknown>): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => flattenLeaves(`${prefix}[${i}]`, item, out));
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      flattenLeaves(prefix === "" ? k : `${prefix}.${k}`, v, out);
    }
  } else {
    out[prefix] = value;
  }
}

describe("extract-conformance corpus", () => {
  const corpus = corpusRoot();
  const cases = readdirSync(corpus)
    .filter((n) => statSync(join(corpus, n)).isDirectory())
    .filter((n) => existsSync(join(corpus, n, "schema.json")))
    .sort();

  expect(cases.length).toBe(31);

  for (const caseName of cases) {
    test(caseName, () => {
      const caseDir = join(corpus, caseName);
      const schemaNode = JSON.parse(readFileSync(join(caseDir, "schema.json"), "utf8")) as RawSchemaJson;
      const schema = parseSchema(schemaNode);
      const input = readFileSync(join(caseDir, "input.txt"), "utf8");
      const expected = JSON.parse(readFileSync(join(caseDir, "expected.json"), "utf8")) as ExpectedJson;

      // Optional per-fixture parse option: "rootless": true → the XML response has no wrapper root
      // element (the payload's fields ARE the top-level elements). Mirrors the Java/Python runners.
      // JSON fixtures ignore it.
      const outcome = extract(input, schema, schemaNode.rootless === true ? { rootless: true } : null);

      // empty flag
      expect(outcome.report.isEmpty()).toBe(expected.empty);

      // per-field states (value check)
      const actualStates = outcome.report.states();
      for (const [path, expectedState] of Object.entries(expected.states)) {
        expect(actualStates.has(path)).toBe(true);
        expect(actualStates.get(path)).toBe(expectedState as never);
      }

      // states key-set exhaustive (no extras, none missing)
      expect([...actualStates.keys()].sort()).toEqual(Object.keys(expected.states).sort());

      // Data is compared as a flat DOTTED-LEAF map (mirroring states): nested objects and
      // arrays are flattened to leaf paths (meta.score, items[0].label, tags[0], …) and every
      // leaf VALUE is asserted — including scalar-array elements and nested-object leaves.
      const actualLeaves: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(outcome.data)) flattenLeaves(key, val, actualLeaves);

      for (const [path, expectedValue] of Object.entries(expected.data)) {
        expect(Object.prototype.hasOwnProperty.call(actualLeaves, path)).toBe(true);
        assertCanonical(caseName, path, expectedValue, actualLeaves[path]);
      }

      // data leaf-set exhaustive (no extras, none missing)
      expect(Object.keys(actualLeaves).sort()).toEqual(Object.keys(expected.data).sort());
    });
  }
});
