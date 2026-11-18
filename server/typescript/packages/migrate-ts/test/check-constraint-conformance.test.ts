// The shared CHECK corpus: `fixtures/check-constraint-conformance/`
// pins the name and the expression text of every CHECK `meta migrate` derives from the corpus's
// validators and enums, per dialect, with and without `migrate.checks.skipRedundant`. Every port
// that writes CHECKs into its own model (the C# EF context) passes the same expected files, so
// one model builds one database through either delivery path.
//
// Regenerate the expected files (after a deliberate change, reviewed): META_WRITE_CHECKS=1 bun test test/check-constraint-conformance.test.ts

import { describe, test, expect } from "bun:test";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../src/expected-schema.js";

const CORPUS = resolve(import.meta.dir, "../../../../../fixtures/check-constraint-conformance");

/** Each expected file: the dialect and the skipRedundant setting it was built with. */
const CASES = [
  { file: "expected.postgres.json", dialect: "postgres", skipRedundantChecks: false },
  { file: "expected.postgres.skip-redundant.json", dialect: "postgres", skipRedundantChecks: true },
  { file: "expected.sqlite.json", dialect: "sqlite", skipRedundantChecks: false },
  { file: "expected.d1.json", dialect: "d1", skipRedundantChecks: false },
  { file: "expected.sqlite.skip-redundant.json", dialect: "sqlite", skipRedundantChecks: true },
] as const;

async function load() {
  const dir = join(CORPUS, "input");
  const sources = readdirSync(dir).filter((f) => f.endsWith(".json")).sort()
    .map((f) => new InMemoryStringSource(readFileSync(join(dir, f), "utf8"), { id: f, format: "json" }));
  const { root, errors } = await new MetaDataLoader().load(sources);
  expect(errors).toEqual([]);
  return root;
}

describe("check-constraint-conformance — meta migrate's CHECK names and text", () => {
  for (const c of CASES) {
    test(c.file, async () => {
      const schema = buildExpectedSchema(await load(), { dialect: c.dialect, skipRedundantChecks: c.skipRedundantChecks });
      const actual = Object.fromEntries(
        schema.tables.filter((t) => t.checks.length > 0)
          .map((t) => [t.name, t.checks.map((k) => ({ name: k.name, expression: k.expression }))]),
      );
      const path = join(CORPUS, c.file);
      if (process.env["META_WRITE_CHECKS"] === "1") writeFileSync(path, JSON.stringify(actual, null, 2) + "\n");
      expect(actual).toEqual(JSON.parse(readFileSync(path, "utf8")));
    });
  }
});
