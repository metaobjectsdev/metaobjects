import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, mkdirSync, readdirSync } from "node:fs";
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

  // Same shape as the `--config-only --print-only` bug: the agent-context branches
  // return ABOVE the `--print-only` guard the full-scaffold path checks below them,
  // so a documented dry run silently wrote the real files. Unlike that one, the write
  // set here is DYNAMIC (it depends on the resolved stack), so the guard cannot be a
  // hardcoded path list in `init()` — it belongs inside `writeAgentContext`, which
  // already computes the exact plan before performing a single write.
  test("--docs-only --print-only reports the real write set and writes nothing", async () => {
    const planned = await init({
      cwd, docsOnly: true, printOnly: true, wireRoot: true,
      servers: ["java"], clients: ["react"],
    });

    // Reported set is the REAL one, not a hardcoded guess: it names the docs, the
    // stack-scoped skill reference, and the manifest.
    expect(planned.created).toContain(".metaobjects/AGENTS.md");
    expect(planned.created).toContain(".claude/skills/metaobjects-codegen/references/java.md");
    expect(planned.created).toContain(".metaobjects/.agent-context.json");

    // ...and the directory is untouched.
    expect(readdirSync(cwd)).toEqual([]);

    // Nothing reports in the PAST tense. A dry run claiming it "created" a root
    // CLAUDE.md or "wired" an @import names a side effect on a file the user owns,
    // which they can go look for and will not find — a more expensive lie than the
    // silent write, because it reads as a completed action.
    // Anchored, not `\bcreated with\b` — that also matches the CORRECT "(would be
    // created with …)" and the assertion fails on its own fix.
    const past = [...planned.created, ...planned.warnings].filter(
      (m) => m.includes("(created with") || /^wired /.test(m) || m.includes("version written to"),
    );
    expect(past).toEqual([]);
    expect(planned.created).toContain("CLAUDE.md (would be created with MetaObjects @import)");
  });

  test("--refresh-docs --print-only writes nothing", async () => {
    // The second door onto the same guard: refresh short-circuits on its own branch,
    // which also sat above the --print-only check. It only engages once the project
    // exists, so seed the marker directory first.
    mkdirSync(join(cwd, ".metaobjects"), { recursive: true });

    const planned = await init({ cwd, refreshDocs: true, printOnly: true, servers: ["java"] });

    expect(planned.created).toContain(".metaobjects/AGENTS.md");
    expect(existsSync(join(cwd, ".metaobjects/AGENTS.md"))).toBe(false);
    expect(existsSync(join(cwd, ".metaobjects/.agent-context.json"))).toBe(false);
    expect(readdirSync(join(cwd, ".metaobjects"))).toEqual([]);
  });
});
