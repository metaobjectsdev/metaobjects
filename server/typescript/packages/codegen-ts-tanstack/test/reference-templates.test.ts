// FR-040 §4.1 — the UI tier is where frameworks diverge most, so it must be ownable.
import { describe, test, expect } from "bun:test";
import { REFERENCE_GENERATOR_NAMES, readReferenceTemplate, resolveReferenceRoot } from "../src/index.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

describe("codegen-ts-tanstack reference templates", () => {
  test("exposes the hooks, grid and grid-hook templates", () => {
    expect([...REFERENCE_GENERATOR_NAMES]).toEqual(["hooks", "grid", "grid-hook"]);
  });

  test("every asset exists on disk", () => {
    const root = resolveReferenceRoot();
    for (const name of REFERENCE_GENERATOR_NAMES) {
      expect(existsSync(join(root, `${name}.ts`))).toBe(true);
    }
  });

  test("imports only this package's public engine, declares its target", () => {
    for (const name of REFERENCE_GENERATOR_NAMES) {
      const src = readReferenceTemplate(name);
      expect(src).toContain("REFERENCE TEMPLATE");
      expect(src).toContain("// targets:");
      expect(src).toContain('from "@metaobjectsdev/codegen-ts-tanstack"');
      // Never a deep path into package internals — that is the fork this FR removes.
      expect(src).not.toContain("src/templates");
      expect(src).not.toContain("./templates/");
    }
  });

  test("the hooks template names the client-component coupling", () => {
    const src = readReferenceTemplate("hooks");
    expect(src).toContain("useEntityFetcher()");
    expect(src).toContain("@metaobjectsdev/tanstack");
  });
});
