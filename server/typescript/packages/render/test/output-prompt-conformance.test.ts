import { describe, test, expect } from "bun:test";
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  renderOutputFormat,
  Format,
  FieldKind,
  PromptStyle,
  recover,
  recoverSchema,
  scalar,
  enumField,
  object,
  FieldRecovery,
  type OutputFormatSpec,
  type PromptField,
  type PromptOverrides,
  type RecoverSchema,
  type FieldSpec,
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

function buildRecoverSchema(c: CaseSpec): RecoverSchema {
  const fields: FieldSpec[] = c.fields.map((f) => {
    if (f.kind === "ENUM") return enumField(f.name, f.required, f.enumValues ?? null, {});
    if (f.kind === "OBJECT") return object(f.name, f.required, f.array ?? false, f.nested ? buildRecoverSchema(f.nested) : null);
    return scalar(f.name, FieldKind[f.kind], f.required);
  });
  return recoverSchema(toFormat(c.format), c.rootName, fields);
}

describe("output-prompt-conformance corpus", () => {
  const names = existsSync(CORPUS)
    ? readdirSync(CORPUS)
        .filter((n) => statSync(join(CORPUS, n)).isDirectory())
        .filter((n) => existsSync(join(CORPUS, n, "spec.json")))
        .sort()
    : [];
  // Count guard: a port silently skipping cases must fail. Bump when adding cases.
  const EXPECTED_CASE_COUNT = 12;
  expect(names.length).toBe(EXPECTED_CASE_COUNT);

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

      if (spec.roundTrip) {
        const exampleFragment = readFileSync(join(dir, "expected.exampleOnly.txt"), "utf8");
        const outcome = recover(exampleFragment, buildRecoverSchema(spec));
        // Skew guard: a field the renderer emitted must read back cleanly. We assert
        // NO state is MALFORMED or LOST_* (robust to DEFAULTED and to how a nested
        // OBJECT-container path classifies); any such state means the renderer emitted
        // an example the recover parser cannot read.
        const bad = [FieldRecovery.MALFORMED, FieldRecovery.LOST_REQUIRED, FieldRecovery.LOST_OPTIONAL] as const;
        for (const [field, state] of outcome.report.states()) {
          expect([field, bad.includes(state as (typeof bad)[number])]).toEqual([field, false]);
        }
      }
    });
  }
});
