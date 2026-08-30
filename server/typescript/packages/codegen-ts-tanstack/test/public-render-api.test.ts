// FR-040 §4.2(b) — see the codegen-ts-react sibling for the rationale.
//
// These are STATIC named imports on purpose. Looking the exports up by string through
// a `Record<string, unknown>` cast — which is what this file used to do — throws away
// the guarantee it exists to provide: renaming or dropping `renderColumnsFile` would
// still COMPILE, and the suite would report a runtime failure instead of a build break.
// The whole point of the promotion is that these names are a compatibility promise, so
// the check belongs at the type level, where breaking the promise cannot be typed.
import { describe, test, expect } from "bun:test";
import {
  renderHooksFile,
  renderColumnsFile,
  renderGridHookFile,
} from "../src/index.js";

const RENDERERS = { renderHooksFile, renderColumnsFile, renderGridHookFile };

describe("codegen-ts-tanstack public render API", () => {
  for (const [name, fn] of Object.entries(RENDERERS)) {
    test(`exports ${name} taking (entity, ctx)`, () => {
      expect(typeof fn).toBe("function");
      // The stable signature the reference templates and any owned generator call.
      expect(fn.length).toBe(2);
    });
  }
});
