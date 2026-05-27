// YAML conformance harness (TS port; corpus shared at fixtures/yaml-conformance/, ADR-0006 D4).
//
// YAML is the cross-language authoring front-end (TS, Python, Java, C#).
// Canonical JSON is the on-disk interchange. The corpus lives at the
// repo-root `fixtures/yaml-conformance/` so every port's YAML loader can
// run it (mirroring how `fixtures/conformance/` is shared for JSON conformance).
//
// Each fixture directory under fixtures/yaml-conformance/ contains:
//   - input.yaml                                        (required)
//   - expected.json   (happy-path → canonical-serialized output must match)
//   - expected-errors.json   (error-path → emitted ParseError codes must match)
//
// Exactly one of expected.json / expected-errors.json must be present per
// fixture. Adding a directory under fixtures/yaml-conformance/ adds two
// tests automatically (a parse run + the appropriate comparison).

import { test, expect } from "bun:test";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";
import { canonicalSerialize } from "../src/serializer-json.js";
import { ParseError } from "../src/errors.js";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";

const CORPUS = join(import.meta.dir, "../../../../../fixtures/yaml-conformance");

interface ExpectedYamlError {
  code: string;
  source?: { format: string; files: readonly string[]; jsonPath?: string };
}

interface YamlFixture {
  name: string;
  input: string;
  expected:
    | { kind: "canonical"; json: string }
    | { kind: "errors"; envelopes: ExpectedYamlError[]; warningsCount: number };
}

async function discoverYamlFixtures(corpus: string): Promise<YamlFixture[]> {
  const entries = (await readdir(corpus)).sort();
  const fixtures: YamlFixture[] = [];
  for (const entry of entries) {
    const path = join(corpus, entry);
    const st = await stat(path);
    if (!st.isDirectory()) continue;
    const input = await readFile(join(path, "input.yaml"), "utf8");

    // Prefer expected-errors.json when present; else canonical expected.json.
    let expectedErrorsRaw: string | undefined;
    try {
      expectedErrorsRaw = await readFile(join(path, "expected-errors.json"), "utf8");
    } catch {
      // not an error-path fixture
    }
    let expectedJsonRaw: string | undefined;
    try {
      expectedJsonRaw = await readFile(join(path, "expected.json"), "utf8");
    } catch {
      // not a happy-path fixture
    }

    if (expectedErrorsRaw !== undefined && expectedJsonRaw !== undefined) {
      throw new Error(
        `Fixture '${entry}' has both expected.json and expected-errors.json — one only.`,
      );
    }
    if (expectedErrorsRaw !== undefined) {
      const raw: unknown = JSON.parse(expectedErrorsRaw);
      // FR5a envelope: { errors: [{code, source}], warnings: [] }.
      // Legacy: [{code}, ...].
      let envelopes: ExpectedYamlError[];
      let warningsCount = 0;
      if (Array.isArray(raw)) {
        envelopes = (raw as { code: string }[]).map((e) => ({ code: e.code }));
      } else {
        const obj = raw as { errors: ExpectedYamlError[]; warnings?: unknown[] };
        envelopes = obj.errors;
        warningsCount = Array.isArray(obj.warnings) ? obj.warnings.length : 0;
      }
      fixtures.push({ name: entry, input, expected: { kind: "errors", envelopes, warningsCount } });
    } else if (expectedJsonRaw !== undefined) {
      fixtures.push({
        name: entry,
        input,
        expected: { kind: "canonical", json: expectedJsonRaw },
      });
    } else {
      throw new Error(
        `Fixture '${entry}' has neither expected.json nor expected-errors.json.`,
      );
    }
  }
  return fixtures;
}

async function loadYaml(yaml: string): Promise<{
  root: import("../src/shared/meta-root.js").MetaRoot;
  errors: Error[];
}> {
  const loader = new MetaDataLoader();
  const result = await loader.load([
    new InMemoryStringSource(yaml, { id: "input.yaml", format: "yaml" }),
  ]);
  return { root: result.root, errors: result.errors };
}

const fixtures = await discoverYamlFixtures(CORPUS);

for (const fix of fixtures) {
  test(`yaml-conformance: ${fix.name}`, async () => {
    const { root, errors } = await loadYaml(fix.input);

    if (fix.expected.kind === "canonical") {
      // Happy-path: no errors and the canonical serialization must match.
      if (errors.length > 0) {
        const codes = errors.map((e) => (e as ParseError).code ?? "(no code)").join(", ");
        throw new Error(
          `${fix.name}: expected no errors but got [${codes}]: ` +
            errors.map((e) => e.message).join("\n  "),
        );
      }
      const got = canonicalSerialize(root);
      expect(got).toBe(fix.expected.json);
    } else {
      // Error-path (FR5a / ADR-0009) — assert the full envelope. The fixture's
      // post-migration shape is `{ errors: [{code, source}], warnings: [] }`.
      // We assert in-order (errors[i] ↔ expected[i]) so the JSONPath / files
      // string match per error, not just the code-set.
      const expected = fix.expected.envelopes;
      expect(errors.length).toBe(expected.length);
      for (let i = 0; i < expected.length; i++) {
        const w = expected[i]!;
        const g = errors[i];
        expect(g).toBeInstanceOf(ParseError);
        const pe = g as ParseError;
        expect(pe.code).toBe(w.code);
        if (w.source !== undefined) {
          // Force the format that the fixture expects (yaml) — TS emits this
          // when loading a yaml InMemoryStringSource.
          expect(pe.source.format).toBe(w.source.format);
          // Files: the YAML fixture's source id is "input.yaml", so we
          // compare directly. ParseError envelopes carry the source id as the
          // sole entry of files[].
          const gFiles = "files" in pe.source ? pe.source.files : [];
          expect([...gFiles]).toEqual([...w.source.files]);
          if (w.source.jsonPath !== undefined) {
            const gPath = "jsonPath" in pe.source ? pe.source.jsonPath : undefined;
            expect(gPath).toBe(w.source.jsonPath);
          }
        }
      }
    }
  });
}
