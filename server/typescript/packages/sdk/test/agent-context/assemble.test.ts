// test/agent-context/assemble.test.ts
import { test, expect, describe } from "bun:test";
import { join } from "node:path";
import { assemble } from "../../src/agent-context/assemble.js";
import { makeStack } from "../../src/agent-context/resolve.js";

const CONTENT_ROOT = join(import.meta.dir, "../../../../../../agent-context"); // test/agent-context/ → repo root is 6 levels up

function paths(files: { path: string }[]): string[] {
  return files.map((f) => f.path).sort();
}

describe("assemble", () => {
  test("emits AGENTS.md + CLAUDE.md with the stack line + codegen command substituted", () => {
    const stack = makeStack(["typescript"], ["react"]);
    const files = assemble({ contentRoot: CONTENT_ROOT, stack });
    const agents = files.find((f) => f.path === ".metaobjects/AGENTS.md")!;
    const claude = files.find((f) => f.path === ".metaobjects/CLAUDE.md")!;
    expect(agents).toBeDefined();
    expect(claude.contents).toBe(agents.contents);
    expect(agents.contents).not.toContain("{{stackLine}}");
    expect(agents.contents).not.toContain("{{codegenCommand}}");
    expect(agents.contents).toContain("npx meta gen");
    expect(agents.contents.toLowerCase()).toContain("typescript");
    expect(agents.contents.toLowerCase()).toContain("react");
  });

  test("installs a reference fragment IFF its token is in the stack", () => {
    const stack = makeStack(["typescript"], ["react"]);
    const p = paths(assemble({ contentRoot: CONTENT_ROOT, stack }));
    expect(p).toContain(".claude/skills/metaobjects-codegen/references/typescript.md");
    expect(p).not.toContain(".claude/skills/metaobjects-codegen/references/java.md");
    expect(p).toContain(".claude/skills/metaobjects-runtime-ui/references/typescript.md");
    expect(p).toContain(".claude/skills/metaobjects-runtime-ui/references/react.md");
    expect(p).not.toContain(".claude/skills/metaobjects-runtime-ui/references/java.md");
    expect(p).not.toContain(".claude/skills/metaobjects-runtime-ui/references/tanstack.md");
    expect(p).toContain(".claude/skills/metaobjects-verify/references/migration.md");
    for (const s of ["authoring", "codegen", "runtime-ui", "prompts", "verify"]) {
      expect(p).toContain(`.claude/skills/metaobjects-${s}/SKILL.md`);
    }
    expect(p.some((x) => x.startsWith(".claude/skills/metaobjects-authoring/references/"))).toBe(false);
  });

  test("a java+react stack installs java (not typescript) server refs + react (not tanstack)", () => {
    const p = paths(assemble({ contentRoot: CONTENT_ROOT, stack: makeStack(["java"], ["react"]) }));
    expect(p).toContain(".claude/skills/metaobjects-codegen/references/java.md");
    expect(p).not.toContain(".claude/skills/metaobjects-codegen/references/typescript.md");
    expect(p).toContain(".claude/skills/metaobjects-runtime-ui/references/react.md");
    expect(p).not.toContain(".claude/skills/metaobjects-runtime-ui/references/tanstack.md");
  });

  test("a kotlin-primary stack assembles without throwing and uses the kotlin codegen command", () => {
    const stack = makeStack(["kotlin"], []);
    const files = assemble({ contentRoot: CONTENT_ROOT, stack });
    const agents = files.find((f) => f.path === ".metaobjects/AGENTS.md")!;
    expect(agents.contents.toLowerCase()).toContain("kotlin");
    expect(agents.contents).toContain("mvn metaobjects:generate");
  });

  test("a stack whose primary server has no meta file falls back to a default codegen command (no throw)", () => {
    // csharp.meta.json exists now, but the guard must not throw even if a meta file were absent.
    const stack = makeStack(["csharp"], []);
    expect(() => assemble({ contentRoot: CONTENT_ROOT, stack })).not.toThrow();
  });

  test("output is deterministic (stable order + identical across runs)", () => {
    const stack = makeStack(["typescript"], ["react"]);
    const a = assemble({ contentRoot: CONTENT_ROOT, stack });
    const b = assemble({ contentRoot: CONTENT_ROOT, stack });
    expect(a).toEqual(b);
    expect(a.map((f) => f.path)).toEqual([...a.map((f) => f.path)].sort());
  });
});
