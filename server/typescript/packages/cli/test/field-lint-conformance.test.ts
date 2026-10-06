// Cross-port field-lint conformance corpus — fixtures/field-lint-conformance/.
//
// Every case is LOADED strict first, so "this loads with no error today" is proven by
// the fixture rather than asserted in prose, and only then linted. The C#, Java and
// Python runners assert the same `expected.json`, so the codes, addresses and message
// text cannot drift between the ports.
import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";
import { lintDuplicateFields, lintReferenceFields } from "../src/lib/field-lint.js";

const CORPUS_DIR = join(import.meta.dir, "../../../../../fixtures/field-lint-conformance");

interface Finding { code: string; path: string; message: string }

const order = (a: Finding, b: Finding): number =>
  a.code.localeCompare(b.code) || a.path.localeCompare(b.path) || a.message.localeCompare(b.message);

const cases = readdirSync(CORPUS_DIR).filter((n) => statSync(join(CORPUS_DIR, n)).isDirectory()).sort();

describe("field-lint conformance corpus", () => {
  test("discovers the corpus", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const name of cases) {
    test(name, async () => {
      const input = join(CORPUS_DIR, name, "input");
      const expected = JSON.parse(readFileSync(join(CORPUS_DIR, name, "expected.json"), "utf8")) as { findings: Finding[] };

      const result = await MetaDataLoader.fromDirectory(input, { strict: true });
      expect(result.errors.map(String)).toEqual([]);

      const files = readdirSync(input).sort().map((f) => join(input, f));
      const actual = [
        ...lintReferenceFields(result.root),
        ...(await lintDuplicateFields(files, (path) => new FileSource(path))),
      ].map(({ code, path, message }) => ({ code, path: path ?? "", message }));

      expect(actual.sort(order)).toEqual([...expected.findings].sort(order));
    });
  }
});
