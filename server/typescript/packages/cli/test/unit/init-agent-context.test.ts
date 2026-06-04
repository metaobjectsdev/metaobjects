import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../../src/commands/init.js";

let cwd: string;
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "init-ac-")); });
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

const javaReact = { servers: ["java"], clients: ["react"] };

describe("init() — agent-context scaffolding", () => {
  test("scaffolds always-on + skills + only the stack's reference fragments + a manifest", async () => {
    await init({ cwd, servers: javaReact.servers, clients: javaReact.clients });
    expect(existsSync(join(cwd, ".metaobjects/AGENTS.md"))).toBe(true);
    expect(existsSync(join(cwd, ".metaobjects/CLAUDE.md"))).toBe(true);
    expect(existsSync(join(cwd, ".claude/skills/metaobjects-codegen/SKILL.md"))).toBe(true);
    expect(existsSync(join(cwd, ".claude/skills/metaobjects-codegen/references/java.md"))).toBe(true);
    expect(existsSync(join(cwd, ".claude/skills/metaobjects-codegen/references/typescript.md"))).toBe(false);
    expect(existsSync(join(cwd, ".metaobjects/.agent-context.json"))).toBe(true);
    expect(readFileSync(join(cwd, ".metaobjects/AGENTS.md"), "utf8").toLowerCase()).toContain("java");
  });

  test("--no-skills scaffolds the always-on but no skills", async () => {
    await init({ cwd, servers: javaReact.servers, clients: javaReact.clients, noSkills: true });
    expect(existsSync(join(cwd, ".metaobjects/AGENTS.md"))).toBe(true);
    expect(existsSync(join(cwd, ".claude/skills"))).toBe(false);
  });

  test("re-init (refreshDocs) over an unmodified scaffold is idempotent — no .new files", async () => {
    await init({ cwd, servers: javaReact.servers, clients: javaReact.clients });
    const before = readFileSync(join(cwd, ".claude/skills/metaobjects-codegen/SKILL.md"), "utf8");
    await init({ cwd, servers: javaReact.servers, clients: javaReact.clients, refreshDocs: true });
    expect(readFileSync(join(cwd, ".claude/skills/metaobjects-codegen/SKILL.md"), "utf8")).toBe(before);
    expect(existsSync(join(cwd, ".claude/skills/metaobjects-codegen/SKILL.md.new"))).toBe(false);
  });

  test("re-init preserves a hand-edited file by writing .new, never clobbering", async () => {
    await init({ cwd, servers: javaReact.servers, clients: javaReact.clients });
    const p = join(cwd, ".metaobjects/AGENTS.md");
    writeFileSync(p, "MY HAND EDIT", "utf8");
    const r = await init({ cwd, servers: javaReact.servers, clients: javaReact.clients, refreshDocs: true });
    expect(readFileSync(p, "utf8")).toBe("MY HAND EDIT");
    expect(existsSync(`${p}.new`)).toBe(true);
    expect(r.warnings.some((w) => w.includes("AGENTS.md"))).toBe(true);
  });
});
