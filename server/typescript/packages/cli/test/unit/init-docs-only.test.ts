import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../../src/commands/init.js";

let cwd: string;
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "init-docsonly-")); });
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

describe("init() --docs-only", () => {
  test("scaffolds ONLY the agent-context (no metaobjects/ project scaffold)", async () => {
    await init({ cwd, docsOnly: true, servers: ["java", "kotlin"], clients: ["react", "tanstack"] });
    // agent-context present
    expect(existsSync(join(cwd, ".metaobjects/AGENTS.md"))).toBe(true);
    expect(existsSync(join(cwd, ".claude/skills/metaobjects-authoring/SKILL.md"))).toBe(true);
    expect(existsSync(join(cwd, ".metaobjects/.agent-context.json"))).toBe(true);
    // stack-scoped: only the declared stack's language references install (058be51c);
    // this stack is java + kotlin (+ react/tanstack clients), so both JVM refs install
    // and the other language refs do not.
    expect(existsSync(join(cwd, ".claude/skills/metaobjects-codegen/references/kotlin.md"))).toBe(true);
    expect(existsSync(join(cwd, ".claude/skills/metaobjects-codegen/references/java.md"))).toBe(true);
    expect(existsSync(join(cwd, ".claude/skills/metaobjects-codegen/references/typescript.md"))).toBe(false);
    expect(existsSync(join(cwd, ".claude/skills/metaobjects-codegen/references/csharp.md"))).toBe(false);
    expect(existsSync(join(cwd, ".claude/skills/metaobjects-codegen/references/python.md"))).toBe(false);
    // the project scaffold is NOT created (this is an existing-metaobjects/polyglot repo)
    expect(existsSync(join(cwd, "metaobjects"))).toBe(false);
    expect(existsSync(join(cwd, "metaobjects.config.ts"))).toBe(false);
    expect(existsSync(join(cwd, ".metaobjects/config.json"))).toBe(false);
  });
});
