// documentation-definition-embed — gates the generated embedded
// documentation-definition module
// (core/documentation/documentation-definition.embedded.ts) against the canonical
// spec/metamodel/documentation.json source.
//
// Two guarantees:
//   1. DRIFT GATE — DOCUMENTATION_DEFINITION deep-equals the parsed canonical
//      spec/metamodel/documentation.json (regenerate via
//      scripts/generate-embedded-metamodel.ts when the JSON changes).
//   2. PROVIDER ID — the embedded definition's provider id matches the
//      documentation provider so doc grouping resolves correctly.

import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { DOCUMENTATION_DEFINITION } from "../src/core/documentation/documentation-definition.embedded.js";

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
  readFileSync(join(root, "spec", "metamodel", "documentation.json"), "utf-8"),
);

describe("DOCUMENTATION_DEFINITION — drift gate", () => {
  test("deep-equals canonical spec/metamodel/documentation.json", () => {
    expect(DOCUMENTATION_DEFINITION).toEqual(canonical);
  });

  test("provider id is metaobjects-documentation", () => {
    expect(DOCUMENTATION_DEFINITION.provider).toBe("metaobjects-documentation");
  });

  test("declares exactly the universal `*.*` entry carrying the 8 doc attrs", () => {
    expect(DOCUMENTATION_DEFINITION.types).toHaveLength(1);
    const universal = DOCUMENTATION_DEFINITION.types[0]!;
    expect(universal.type).toBe("*");
    expect(universal.subType).toBe("*");
    const attrChildren = (universal.children ?? []).filter((c) => c.type === "attr");
    expect(attrChildren).toHaveLength(8);
  });
});
