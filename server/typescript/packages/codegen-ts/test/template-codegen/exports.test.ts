import { describe, test, expect } from "bun:test";
import * as api from "../../src/index.js";

describe("public exports", () => {
  test("scope helpers + template-codegen API are exported", () => {
    for (const name of [
      "perEntity", "perPackage", "perModel", "oncePerRun",
      "expandOutputPattern",
      "buildEntityTemplateData", "buildPackageTemplateData", "buildModelTemplateData",
      "parseTemplateSpec", "templateSpecToGenerators",
    ]) {
      expect(typeof (api as Record<string, unknown>)[name]).toBe("function");
    }
  });
});
