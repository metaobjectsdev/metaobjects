// ui-web-definition-embed — gates the generated embedded ui-web-definition
// module (presentation/ui-web/ui-web-definition.embedded.ts) against the
// canonical spec/metamodel/ui-web.json source.
//
// Two guarantees:
//   1. DRIFT GATE — UI_WEB_DEFINITION deep-equals the parsed canonical
//      spec/metamodel/ui-web.json (regenerate via
//      scripts/generate-embedded-metamodel.ts when the JSON changes).
//   2. PROVIDER ID — the embedded definition's provider id is the ui-web
//      provider.

import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { UI_WEB_DEFINITION } from "../src/presentation/ui-web/ui-web-definition.embedded.js";

function repoRoot(): string {
  let dir = import.meta.dir;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "spec")) && existsSync(join(dir, "server"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("repo root not found");
}
const root = repoRoot();
const canonical = JSON.parse(readFileSync(join(root, "spec", "metamodel", "ui-web.json"), "utf-8"));

describe("UI_WEB_DEFINITION — drift gate", () => {
  test("deep-equals canonical spec/metamodel/ui-web.json", () => {
    expect(UI_WEB_DEFINITION).toEqual(canonical);
  });

  test("provider id is metaobjects-ui-web", () => {
    expect(UI_WEB_DEFINITION.provider).toBe("metaobjects-ui-web");
  });

  test("is an extends-only definition (no `types`)", () => {
    expect(UI_WEB_DEFINITION.types).toBeUndefined();
    expect(UI_WEB_DEFINITION.extends).toBeDefined();
  });
});
