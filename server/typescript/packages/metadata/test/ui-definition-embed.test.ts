// ui-definition-embed — gates the generated embedded ui-definition module
// (presentation/ui/ui-definition.embedded.ts) against the canonical
// spec/metamodel/ui.json source (FR-033 S1.5-B).
//
// Two guarantees:
//   1. DRIFT GATE — UI_DEFINITION deep-equals the parsed canonical
//      spec/metamodel/ui.json (regenerate via
//      scripts/generate-embedded-metamodel.ts when the JSON changes).
//   2. PROVIDER ID — the embedded definition's provider id is the ui provider.

import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { UI_DEFINITION } from "../src/presentation/ui/ui-definition.embedded.js";

function repoRoot(): string {
  let dir = import.meta.dir;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "spec")) && existsSync(join(dir, "server"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("repo root not found");
}
const root = repoRoot();
const canonical = JSON.parse(readFileSync(join(root, "spec", "metamodel", "ui.json"), "utf-8"));

describe("UI_DEFINITION — drift gate", () => {
  test("deep-equals canonical spec/metamodel/ui.json", () => {
    expect(UI_DEFINITION).toEqual(canonical);
  });

  test("provider id is metaobjects-ui", () => {
    expect(UI_DEFINITION.provider).toBe("metaobjects-ui");
  });

  test("is an extends-only definition (no `types`)", () => {
    expect(UI_DEFINITION.types).toBeUndefined();
    expect(UI_DEFINITION.extends).toBeDefined();
  });
});
