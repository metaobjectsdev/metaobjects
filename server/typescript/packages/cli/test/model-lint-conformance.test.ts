// Cross-port model-lint conformance corpus — fixtures/model-lint-conformance/.
//
// Every case is LOADED strict first, so "this loads with no error today" is proven by
// the fixture rather than asserted in prose, and only then linted. The other ports'
// runners assert the same `expected.json`, so the codes, addresses and message text
// cannot drift between the ports.
import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";
import { lintOverlays } from "../src/lib/overlay-lint.js";
import { lintNodeNames } from "../src/lib/name-lint.js";
import { lintDeprecatedReferences } from "../src/lib/deprecation-lint.js";

const CORPUS_DIR = join(import.meta.dir, "../../../../../fixtures/model-lint-conformance");

interface Finding { code: string; path: string; message: string }

const order = (a: Finding, b: Finding): number =>
  a.code.localeCompare(b.code) || a.path.localeCompare(b.path) || a.message.localeCompare(b.message);

const cases = readdirSync(CORPUS_DIR).filter((n) => statSync(join(CORPUS_DIR, n)).isDirectory()).sort();

describe("model-lint conformance corpus", () => {
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
      const overlay = await lintOverlays(
        { files, fileIds: new Map(), configDir: input },
        (path) => new FileSource(path),
      );
      const actual = [
        ...overlay,
        ...lintNodeNames(result.root),
        ...lintDeprecatedReferences(result.root),
      ].map(({ code, path, message }) => ({ code, path: path ?? "", message }));

      expect(actual.sort(order)).toEqual([...expected.findings].sort(order));
    });
  }
});
