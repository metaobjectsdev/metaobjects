// FR-040 §4.2(b) — see the codegen-ts-react sibling for the rationale.
import { describe, test, expect } from "bun:test";
import * as pkg from "../src/index.js";

const RENDERERS = ["renderHooksFile", "renderColumnsFile", "renderGridHookFile"] as const;

describe("codegen-ts-tanstack public render API", () => {
  for (const name of RENDERERS) {
    test(`exports ${name} taking (entity, ctx)`, () => {
      const fn = (pkg as Record<string, unknown>)[name];
      expect(typeof fn).toBe("function");
      expect((fn as (...a: unknown[]) => unknown).length).toBe(2);
    });
  }
});
