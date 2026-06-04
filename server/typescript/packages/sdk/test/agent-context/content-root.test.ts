import { test, expect, describe } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveAgentContextRoot } from "../../src/agent-context/content-root.js";

describe("resolveAgentContextRoot", () => {
  test("locates the monorepo agent-context/ content tree", () => {
    const root = resolveAgentContextRoot();
    expect(existsSync(join(root, "skills", "metaobjects-authoring", "SKILL.md"))).toBe(true);
    expect(existsSync(join(root, "templates", "always-on.md.mustache"))).toBe(true);
  });
  test("a provided override that exists is returned as-is", () => {
    const root = resolveAgentContextRoot();
    expect(resolveAgentContextRoot(root)).toBe(root);
  });
  test("a non-existent override throws a clear error", () => {
    expect(() => resolveAgentContextRoot("/no/such/agent-context")).toThrow(/agent-context content not found/i);
  });
});
