// FR-040 §4.1 — the UI tier is where frameworks diverge most, so it must be ownable.
import { describe, test, expect } from "bun:test";
import { REFERENCE_GENERATOR_NAMES, readReferenceTemplate, resolveReferenceRoot } from "../src/index.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

describe("codegen-ts-react reference templates", () => {
  test("exposes the form template", () => {
    expect([...REFERENCE_GENERATOR_NAMES]).toEqual(["form"]);
  });

  test("the asset exists on disk", () => {
    expect(existsSync(join(resolveReferenceRoot(), "form.ts"))).toBe(true);
  });

  // ADR-0034 Amendment 8: an owned generator owns the code that writes its output. The
  // reference reaches the renderer by a path `meta eject` copies beside it (`../templates/`),
  // and the engine by the package entry — never the renderer through the package entry, which
  // would leave it packaged.
  test("imports its renderer by path and the engine by the engine entry, declares its target", () => {
    const src = readReferenceTemplate("form");
    expect(src).toContain("REFERENCE TEMPLATE");
    expect(src).toContain("// targets:");
    expect(src).toContain('from "../templates/form-file.js"');
    expect(src).toContain('from "@metaobjectsdev/codegen-ts/engine"');
    expect(src).not.toContain('from "@metaobjectsdev/codegen-ts-react"');
    expect(src).not.toContain("src/templates");
  });
});
