// template-definition-embed — gates the generated embedded template-definition
// module (template/template-definition.embedded.ts) against the canonical
// spec/metamodel/template.json source.
//
// Two guarantees:
//   1. DRIFT GATE — TEMPLATE_DEFINITION deep-equals the parsed canonical
//      spec/metamodel/template.json (regenerate via
//      scripts/generate-embedded-metamodel.ts when the JSON changes).
//   2. PROVIDER ID — the embedded definition's provider id matches the
//      core-types provider so doc grouping resolves correctly.

import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { TEMPLATE_DEFINITION } from "../src/template/template-definition.embedded.js";

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
  readFileSync(join(root, "spec", "metamodel", "template.json"), "utf-8"),
);

describe("TEMPLATE_DEFINITION — drift gate", () => {
  test("deep-equals canonical spec/metamodel/template.json", () => {
    expect(TEMPLATE_DEFINITION).toEqual(canonical);
  });

  test("provider id is metaobjects-core-types", () => {
    expect(TEMPLATE_DEFINITION.provider).toBe("metaobjects-core-types");
  });

  test("declares exactly the 4 template subtypes", () => {
    const subTypes = TEMPLATE_DEFINITION.types.map((t) => t.subType).sort();
    expect(subTypes).toEqual(["base", "output", "prompt", "toolcall"]);
  });
});
