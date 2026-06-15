// field-definition-embed — gates the generated embedded field-definition module
// (core/field/field-definition.embedded.ts) against the canonical
// spec/metamodel/field.json source.
//
// Two guarantees:
//   1. DRIFT GATE — FIELD_DEFINITION deep-equals the parsed canonical
//      spec/metamodel/field.json (regenerate via
//      scripts/generate-embedded-metamodel.ts when the JSON changes).
//   2. PROVIDER ID — the embedded definition's provider id matches the
//      core-types provider so doc grouping (Task 5) resolves correctly.

import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { FIELD_DEFINITION } from "../src/core/field/field-definition.embedded.js";

function repoRoot(): string {
  let dir = import.meta.dir;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "spec")) && existsSync(join(dir, "server"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("repo root not found");
}
const root = repoRoot();
const canonical = JSON.parse(
  readFileSync(join(root, "spec", "metamodel", "field.json"), "utf-8"),
);

describe("FIELD_DEFINITION — drift gate", () => {
  test("deep-equals canonical spec/metamodel/field.json", () => {
    expect(FIELD_DEFINITION).toEqual(canonical);
  });

  test("provider id is metaobjects-core-types", () => {
    expect(FIELD_DEFINITION.provider).toBe("metaobjects-core-types");
  });
});
