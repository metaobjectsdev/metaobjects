import { test, expect, describe } from "bun:test";
import { SERVER_LANGS, CLIENT_FRAMEWORKS, SKILL_NAMES, MIGRATION_TOKEN } from "../../src/agent-context/types.js";

describe("agent-context types", () => {
  test("closed sets have the expected members", () => {
    expect([...SERVER_LANGS]).toEqual(["typescript", "java", "kotlin", "csharp", "python"]);
    expect([...CLIENT_FRAMEWORKS]).toEqual(["react", "tanstack", "angular"]);
    expect(MIGRATION_TOKEN).toBe("migration");
  });
  test("the six skills are named and ordered", () => {
    expect(SKILL_NAMES).toEqual([
      "metaobjects-authoring",
      "metaobjects-codegen",
      "metaobjects-runtime-ui",
      "metaobjects-prompts",
      "metaobjects-verify",
      "metaobjects-audit",
    ]);
  });
});
