// db-definition-embed — gates the generated embedded db-definition module
// (persistence/db/db-definition.embedded.ts) against the canonical
// spec/metamodel/db.json source (FR-033 S1.5-A).
//
// Two guarantees:
//   1. DRIFT GATE — DB_DEFINITION deep-equals the parsed canonical
//      spec/metamodel/db.json (regenerate via
//      scripts/generate-embedded-metamodel.ts when the JSON changes).
//   2. PROVIDER ID — the embedded definition's provider id is the db provider.

import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { DB_DEFINITION } from "../src/persistence/db/db-definition.embedded.js";

function repoRoot(): string {
  let dir = import.meta.dir;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "spec")) && existsSync(join(dir, "server"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("repo root not found");
}
const root = repoRoot();
const canonical = JSON.parse(readFileSync(join(root, "spec", "metamodel", "db.json"), "utf-8"));

describe("DB_DEFINITION — drift gate", () => {
  test("deep-equals canonical spec/metamodel/db.json", () => {
    expect(DB_DEFINITION).toEqual(canonical);
  });

  test("provider id is metaobjects-db", () => {
    expect(DB_DEFINITION.provider).toBe("metaobjects-db");
  });

  test("is an extends-only definition (no `types`)", () => {
    expect(DB_DEFINITION.types).toBeUndefined();
    expect(DB_DEFINITION.extends).toBeDefined();
  });
});
