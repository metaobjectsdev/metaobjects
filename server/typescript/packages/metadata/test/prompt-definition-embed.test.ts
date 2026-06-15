// prompt-definition-embed — gates the generated embedded prompt-definition module
// (template/prompt-definition.embedded.ts) against the canonical
// spec/metamodel/prompt.json source (FR-033 S1.5-B).
//
// Two guarantees:
//   1. DRIFT GATE — PROMPT_DEFINITION deep-equals the parsed canonical
//      spec/metamodel/prompt.json (regenerate via
//      scripts/generate-embedded-metamodel.ts when the JSON changes).
//   2. PROVIDER ID — the embedded definition's provider id is the prompt provider.

import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { PROMPT_DEFINITION } from "../src/template/prompt-definition.embedded.js";

function repoRoot(): string {
  let dir = import.meta.dir;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "spec")) && existsSync(join(dir, "server"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("repo root not found");
}
const root = repoRoot();
const canonical = JSON.parse(readFileSync(join(root, "spec", "metamodel", "prompt.json"), "utf-8"));

describe("PROMPT_DEFINITION — drift gate", () => {
  test("deep-equals canonical spec/metamodel/prompt.json", () => {
    expect(PROMPT_DEFINITION).toEqual(canonical);
  });

  test("provider id is metaobjects-prompt", () => {
    expect(PROMPT_DEFINITION.provider).toBe("metaobjects-prompt");
  });

  test("is an extends-only definition (no `types`)", () => {
    expect(PROMPT_DEFINITION.types).toBeUndefined();
    expect(PROMPT_DEFINITION.extends).toBeDefined();
  });
});
