import { describe, test, expect } from "bun:test";
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  renderOutputFormat,
  Format,
  FieldKind,
  PromptStyle,
  type OutputFormatSpec,
  type PromptField,
  type PromptOverrides,
} from "../src/index.js";

// The shared corpus lives at the repo root. This file is at
// server/typescript/packages/render/test/, so the repo root is five levels up.
const CORPUS = join(import.meta.dir, "../../../../../fixtures/output-prompt-conformance");

// ----- descriptor types (the spec.json shape) -----
interface CaseField {
  name: string;
  kind: keyof typeof FieldKind;
  required: boolean;
  array?: boolean;
  example?: string | null;
  instruction?: string | null;
  enumValues?: string[] | null;
  enumDoc?: Record<string, string> | null;
  nested?: CaseSpec | null;
}
interface CaseSpec {
  format: "json" | "xml";
  rootName: string;
  roundTrip?: boolean;
  fields: CaseField[];
}

const STYLES: ReadonlyArray<{ key: string; style: PromptStyle }> = [
  { key: "guide", style: PromptStyle.GUIDE },
  { key: "inline", style: PromptStyle.INLINE },
  { key: "exampleOnly", style: PromptStyle.EXAMPLE_ONLY },
];

function toFormat(f: "json" | "xml"): Format {
  return f === "json" ? Format.JSON : Format.XML;
}

function buildOutputSpec(c: CaseSpec): OutputFormatSpec {
  const fields: PromptField[] = c.fields.map((f) => ({
    name: f.name,
    kind: FieldKind[f.kind],
    required: f.required,
    array: f.array ?? false,
    enumValues: f.enumValues ?? null,
    enumDoc: f.enumDoc ?? null,
    example: f.example ?? null,
    instruction: f.instruction ?? null,
    nested: f.nested ? buildOutputSpec(f.nested) : null,
  }));
  // style here is a placeholder; each render overrides it per style.
  return { format: toFormat(c.format), rootName: c.rootName, style: PromptStyle.GUIDE, fields };
}

describe("output-prompt-conformance corpus", () => {
  const names = existsSync(CORPUS)
    ? readdirSync(CORPUS)
        .filter((n) => statSync(join(CORPUS, n)).isDirectory())
        .filter((n) => existsSync(join(CORPUS, n, "spec.json")))
        .sort()
    : [];
  expect(names.length).toBeGreaterThan(0);

  for (const name of names) {
    test(name, () => {
      const dir = join(CORPUS, name);
      const spec = JSON.parse(readFileSync(join(dir, "spec.json"), "utf8")) as CaseSpec;
      const ofs = buildOutputSpec(spec);

      for (const { key, style } of STYLES) {
        const overrides: PromptOverrides = { style };
        const actual = renderOutputFormat(ofs, overrides);
        const expectedPath = join(dir, `expected.${key}.txt`);
        if (!existsSync(expectedPath)) {
          // Snapshot-generate on first run; commit + review the output, then it becomes the gate.
          writeFileSync(expectedPath, actual, "utf8");
          throw new Error(`snapshot created: ${expectedPath} — review and re-run`);
        }
        const expected = readFileSync(expectedPath, "utf8");
        expect(actual).toBe(expected); // zero-drift, byte-exact
        // determinism: identical across runs
        expect(renderOutputFormat(ofs, overrides)).toBe(actual);
      }
    });
  }
});
