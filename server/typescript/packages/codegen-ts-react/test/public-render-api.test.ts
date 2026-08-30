// FR-040 §4.2(b) — the render layer is public API so an OWNED generator can compose
// the engine and replace only the framework-coupled step, instead of forking it.
//
// A STATIC named import on purpose. Looking the export up by string through a
// `Record<string, unknown>` cast — which is what this file used to do — throws away the
// guarantee it exists to provide: renaming or dropping `renderFormFile` would still
// COMPILE, and this would report a runtime failure instead of a build break. The whole
// point of the promotion is that the name is a compatibility promise, so the check
// belongs at the type level, where breaking the promise cannot be typed.
import { describe, test, expect } from "bun:test";
import { renderFormFile } from "../src/index.js";

describe("codegen-ts-react public render API", () => {
  test("exports renderFormFile", () => {
    expect(typeof renderFormFile).toBe("function");
  });

  test("renderFormFile takes (entity, ctx)", () => {
    // The stable signature the reference template and any owned generator call.
    expect(renderFormFile.length).toBe(2);
  });
});
