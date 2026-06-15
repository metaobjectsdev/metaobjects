// layout-definition-embed — gates the generated embedded layout-definition
// module (presentation/layout/layout-definition.embedded.ts) against the
// canonical spec/metamodel/layout.json source.
//
// Two guarantees:
//   1. DRIFT GATE — LAYOUT_DEFINITION deep-equals the parsed canonical
//      spec/metamodel/layout.json (regenerate via
//      scripts/generate-embedded-metamodel.ts when the JSON changes).
//   2. PROVIDER ID — the embedded definition's provider id matches the
//      core-types provider so doc grouping (Task 5) resolves correctly.

import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { LAYOUT_DEFINITION } from "../src/presentation/layout/layout-definition.embedded.js";

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
  readFileSync(join(root, "spec", "metamodel", "layout.json"), "utf-8"),
);

describe("LAYOUT_DEFINITION — drift gate", () => {
  test("deep-equals canonical spec/metamodel/layout.json", () => {
    expect(LAYOUT_DEFINITION).toEqual(canonical);
  });

  test("provider id is metaobjects-core-types", () => {
    expect(LAYOUT_DEFINITION.provider).toBe("metaobjects-core-types");
  });
});
