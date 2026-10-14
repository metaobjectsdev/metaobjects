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

  // ADR-0034 Amendment 8: the renderer is reached by a path `meta eject` copies beside the
  // generator (`../templates/`), not through the package entry, which would leave it packaged.
  test("imports its renderer by path and the engine by the engine entry, declares its target", () => {
    for (const name of REFERENCE_GENERATOR_NAMES) {
      const src = readReferenceTemplate(name);
      expect(src).toContain("REFERENCE TEMPLATE");
      expect(src).toContain("// targets:");
      expect(src).toContain('from "@metaobjectsdev/codegen-ts/engine"');
      expect(src).toMatch(/from "\.\.\/templates\/[\w-]+\.js"/);
      expect(src).not.toContain("src/templates");
    }
  });

  test("the hooks template names the client-component coupling", () => {
    const src = readReferenceTemplate("hooks");
    expect(src).toContain("useEntityPathFetcher()");
    expect(src).toContain("@metaobjectsdev/tanstack");
  });

  // FR-040 §4.2(b) — the data-grid opt-in gate is a STEP in the pipeline grid.ts and
  // grid-hook.ts compose, not an internal detail either template may fork. Regression
  // guard for a real defect: both templates once carried their own inlined copy of
  // `hasDataGridLayout`/`warnMissingDataGridLayout` instead of importing the one
  // implementation — a happy-path "does it work" test would not have caught that.
  test("grid and grid-hook import the data-grid gate, never fork it", () => {
    for (const name of ["grid", "grid-hook"] as const) {
      const src = readReferenceTemplate(name);
      expect(src).not.toContain("function hasDataGridLayout");
      expect(src).not.toContain("function warnMissingDataGridLayout");
      expect(src).not.toContain("data-grid-gate");
      expect(src).toContain("hasDataGridLayout");
      expect(src).toContain("warnMissingDataGridLayout");
      // The gate is ENGINE: it stays in the package and is imported from its public entry —
      // never a deeper specifier, and never copied (it is not in the template closure).
      expect(src).toContain('from "@metaobjectsdev/codegen-ts-tanstack";');
    }
  });
});
