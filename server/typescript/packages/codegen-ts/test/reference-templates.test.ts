// ADR-0034 — the reader that `meta init` uses to copy the reference generators into a
// consumer's repo. It must locate src/reference/ and return the raw template source.
import { describe, test, expect } from "bun:test";
import {
  resolveReferenceRoot,
  readReferenceTemplate,
  REFERENCE_GENERATOR_NAMES,
  makeReferenceReader,
} from "../src/index.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

describe("reference-templates reader", () => {
  test("exposes the copyable generator names, entity first (reader sentinel)", () => {
    expect([...REFERENCE_GENERATOR_NAMES]).toEqual([
      "entity", "queries", "routes", "routes-hono", "barrel", "names",
    ]);
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

  test("every reference template parses as a module and declares its target", () => {
    for (const name of REFERENCE_GENERATOR_NAMES) {
      const src = readReferenceTemplate(name);
      // A template with no `targets:` line leaves an adopter guessing what it is coupled to.
      expect(src).toContain("// targets:");
      expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(src)).not.toThrow();
    }
  });
});

describe("makeReferenceReader — per-package template hosting", () => {
  test("resolves a reference root relative to the CALLING module's url", () => {
    // Given this package's own module url, the reader finds this package's templates.
    const reader = makeReferenceReader(import.meta.url, ["entity"]);
    expect(existsSync(join(reader.resolveReferenceRoot(), "entity.ts"))).toBe(true);
  });

  test("reads a named template through the reader", () => {
    const reader = makeReferenceReader(import.meta.url, ["entity"]);
    expect(reader.readReferenceTemplate("entity")).toContain("REFERENCE TEMPLATE");
  });

  test("throws a named error when the package hosts no reference dir", () => {
    const reader = makeReferenceReader("file:///nonexistent/pkg/dist/index.js", ["entity"]);
    expect(() => reader.resolveReferenceRoot()).toThrow(/reference templates not found/);
  });
});
