import { describe, expect, test } from "bun:test";
import { AI_RUNTIME_PACKAGE } from "../src/index.ts";

describe("ai-runtime package", () => {
  test("resolves", () => {
    expect(AI_RUNTIME_PACKAGE).toBe("@metaobjectsdev/ai-runtime");
  });
});
