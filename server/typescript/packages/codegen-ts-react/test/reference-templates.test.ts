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

  test("imports only this package's public engine, declares its target", () => {
    const src = readReferenceTemplate("form");
    expect(src).toContain("REFERENCE TEMPLATE");
    expect(src).toContain("// targets:");
    expect(src).toContain('from "@metaobjectsdev/codegen-ts-react"');
    // Never a deep path into package internals — that is the fork this FR removes.
    expect(src).not.toContain("src/templates");
    expect(src).not.toContain("./templates/");
  });
});
