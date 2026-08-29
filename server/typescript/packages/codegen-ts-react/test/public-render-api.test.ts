// FR-040 §4.2(b) — the render layer is public API so an OWNED generator can compose
// the engine and replace only the framework-coupled step, instead of forking it.
import { describe, test, expect } from "bun:test";
import * as pkg from "../src/index.js";

describe("codegen-ts-react public render API", () => {
  test("exports renderFormFile", () => {
    expect(typeof (pkg as Record<string, unknown>).renderFormFile).toBe("function");
  });

  test("renderFormFile takes (entity, ctx)", () => {
    expect((pkg.renderFormFile as (...a: unknown[]) => unknown).length).toBe(2);
  });
});
