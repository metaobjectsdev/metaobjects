import { test, expect, describe } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

describe("bundled agent-context content", () => {
  test("the bundle script copies the content into the package", () => {
    const pkgDir = join(import.meta.dir, "../..");
    expect(existsSync(join(pkgDir, "agent-context", "skills", "metaobjects-authoring", "SKILL.md"))).toBe(true);
  });
});
