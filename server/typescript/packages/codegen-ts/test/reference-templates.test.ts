// ADR-0034 — the reader that `meta init` uses to copy the reference generators into a
// consumer's repo. It must locate src/reference/ and return the raw template source.
import { describe, test, expect } from "bun:test";
import {
  resolveReferenceRoot,
  readReferenceTemplate,
  REFERENCE_GENERATOR_NAMES,
} from "../src/index.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

describe("reference-templates reader", () => {
  test("exposes the four copyable generator names", () => {
    expect([...REFERENCE_GENERATOR_NAMES]).toEqual(["entity", "queries", "routes", "barrel"]);
  });

  test("resolveReferenceRoot points at a dir holding the templates", () => {
    const root = resolveReferenceRoot();
    for (const name of REFERENCE_GENERATOR_NAMES) {
      expect(existsSync(join(root, `${name}.ts`))).toBe(true);
    }
  });

  test("readReferenceTemplate returns owned-template source (engine import, copy header)", () => {
    for (const name of REFERENCE_GENERATOR_NAMES) {
      const src = readReferenceTemplate(name);
      expect(src).toContain("REFERENCE TEMPLATE");
      expect(src).toContain('from "@metaobjectsdev/codegen-ts"');
      // Never the deprecated package `/generators` export.
      expect(src).not.toContain("@metaobjectsdev/codegen-ts/generators");
    }
  });
});
