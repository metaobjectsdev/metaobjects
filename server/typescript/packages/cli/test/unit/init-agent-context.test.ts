import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../../src/commands/init.js";

let cwd: string;
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "init-ac-")); });
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

const javaReact = { servers: ["java"], clients: ["react"] };

describe("init() — agent-context scaffolding", () => {
  test("scaffolds always-on + skills + the stack's language reference fragments + a manifest", async () => {
    await init({ cwd, servers: javaReact.servers, clients: javaReact.clients });
    expect(existsSync(join(cwd, ".metaobjects/AGENTS.md"))).toBe(true);
    // One always-on file: the root AGENTS.md / CLAUDE.md import it, so no duplicate is written.
    expect(existsSync(join(cwd, ".metaobjects/CLAUDE.md"))).toBe(false);
    expect(existsSync(join(cwd, ".claude/skills/metaobjects-codegen/SKILL.md"))).toBe(true);
    // stack-scoped: only the declared stack's language references install (058be51c);
    // this stack is java + react, so java.md installs and the other language refs do not.
    expect(existsSync(join(cwd, ".claude/skills/metaobjects-codegen/references/java.md"))).toBe(true);
    expect(existsSync(join(cwd, ".claude/skills/metaobjects-codegen/references/typescript.md"))).toBe(false);
    expect(existsSync(join(cwd, ".claude/skills/metaobjects-codegen/references/kotlin.md"))).toBe(false);
    expect(existsSync(join(cwd, ".claude/skills/metaobjects-codegen/references/csharp.md"))).toBe(false);
    expect(existsSync(join(cwd, ".claude/skills/metaobjects-codegen/references/python.md"))).toBe(false);
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

  test("--wire-root appends the @import to an existing root CLAUDE.md (idempotent)", async () => {
    writeFileSync(join(cwd, "CLAUDE.md"), "# my project\n", "utf8");
    await init({ cwd, servers: javaReact.servers, clients: javaReact.clients, wireRoot: true });
    const body = readFileSync(join(cwd, "CLAUDE.md"), "utf8");
    expect(body).toContain("@.metaobjects/AGENTS.md");
    expect(body).toContain("# my project");                 // original preserved
    await init({ cwd, servers: javaReact.servers, clients: javaReact.clients, wireRoot: true, refreshDocs: true });
    const after = readFileSync(join(cwd, "CLAUDE.md"), "utf8");
    expect(after.match(/@\.metaobjects\/AGENTS\.md/g)?.length).toBe(1);  // not double-added
  });
  test("--wire-root creates a root AGENTS.md and CLAUDE.md with the @import when neither exists", async () => {
    await init({ cwd, servers: javaReact.servers, clients: javaReact.clients, wireRoot: true });
    for (const root of ["AGENTS.md", "CLAUDE.md"]) {
      const body = readFileSync(join(cwd, root), "utf8");
      expect(body).toContain("@.metaobjects/AGENTS.md");
      // The plain sentence is what an assistant that does not expand `@` imports acts on.
      expect(body).toContain("Read `.metaobjects/AGENTS.md` before changing");
    }
  });
  test("--wire-root with only a root AGENTS.md wires that and creates no CLAUDE.md", async () => {
    writeFileSync(join(cwd, "AGENTS.md"), "# team rules\n", "utf8");
    await init({ cwd, servers: javaReact.servers, clients: javaReact.clients, wireRoot: true });
    expect(readFileSync(join(cwd, "AGENTS.md"), "utf8")).toContain("@.metaobjects/AGENTS.md");
    expect(existsSync(join(cwd, "CLAUDE.md"))).toBe(false);
  });

  test("--wire-root with only a root CLAUDE.md on a first init also creates AGENTS.md", async () => {
    // A repo that predates the assistant-neutral layout: CLAUDE.md only. Assistants that
    // read AGENTS.md would miss the context, so the first init brings the second file.
    writeFileSync(join(cwd, "CLAUDE.md"), "# my notes\n\nUse pnpm.\n", "utf8");
    await init({ cwd, servers: javaReact.servers, clients: javaReact.clients, wireRoot: true });
    const claude = readFileSync(join(cwd, "CLAUDE.md"), "utf8");
    expect(claude).toContain("# my notes");                    // hand-written content kept
    expect(claude.match(/@\.metaobjects\/AGENTS\.md/g)?.length).toBe(1);  // import appended once
    const agents = readFileSync(join(cwd, "AGENTS.md"), "utf8");
    expect(agents).toContain("@.metaobjects/AGENTS.md");
    expect(agents).toContain("Read `.metaobjects/AGENTS.md` before changing");
  });

  test("a refresh over a repo with only a root CLAUDE.md creates no AGENTS.md and advises once", async () => {
    // Established project (no root files yet), then the legacy-layout CLAUDE.md appears.
    await init({ cwd, servers: javaReact.servers, clients: javaReact.clients });
    writeFileSync(join(cwd, "CLAUDE.md"), "# my notes\n", "utf8");
    const r = await init({ cwd, servers: javaReact.servers, clients: javaReact.clients, wireRoot: true, refreshDocs: true });
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(false);    // a refresh creates no root file
    expect(readFileSync(join(cwd, "CLAUDE.md"), "utf8")).toContain("@.metaobjects/AGENTS.md");  // still wired
    const advisories = r.warnings.filter((w) => w.includes("no root AGENTS.md"));
    expect(advisories.length).toBe(1);                          // exactly once, naming the remedy
    expect(advisories[0]).toContain("add a root AGENTS.md containing @.metaobjects/AGENTS.md");
  });

  test("--skills-dir installs the skills there, names it in the always-on, and a refresh keeps it", async () => {
    await init({ cwd, servers: ["python"], clients: [], skillsDir: ".agents/skills" });
    expect(existsSync(join(cwd, ".agents/skills/metaobjects-codegen/SKILL.md"))).toBe(true);
    expect(existsSync(join(cwd, ".claude/skills"))).toBe(false);
    expect(readFileSync(join(cwd, ".metaobjects/AGENTS.md"), "utf8")).toContain("`.agents/skills/<skill>/SKILL.md`");
    // No flag on the refresh: the manifest's recorded directory wins over the default.
    await init({ cwd, refreshDocs: true, docsOnly: true });
    expect(existsSync(join(cwd, ".claude/skills"))).toBe(false);
    expect(existsSync(join(cwd, ".agents/skills/metaobjects-codegen/SKILL.md"))).toBe(true);
  });

  test("moving the skills with --skills-dir prunes the untouched copies at the old path", async () => {
    await init({ cwd, servers: ["python"], clients: [] });
    expect(existsSync(join(cwd, ".claude/skills/metaobjects-codegen/SKILL.md"))).toBe(true);
    await init({ cwd, refreshDocs: true, docsOnly: true, skillsDir: ".agents/skills" });
    expect(existsSync(join(cwd, ".agents/skills/metaobjects-codegen/SKILL.md"))).toBe(true);
    expect(existsSync(join(cwd, ".claude/skills/metaobjects-codegen/SKILL.md"))).toBe(false);
  });

  test("moving the skills leaves no empty skill directories behind at the old path", async () => {
    await init({ cwd, servers: ["python"], clients: [] });
    expect(readdirSync(join(cwd, ".claude/skills")).length).toBeGreaterThan(0);
    await init({ cwd, refreshDocs: true, docsOnly: true, skillsDir: ".agents/skills" });
    // Every skill directory (and its references/) is gone; the skills directory itself stays,
    // since it may hold the user's own skills.
    expect(readdirSync(join(cwd, ".claude/skills"))).toEqual([]);
    expect(existsSync(join(cwd, ".agents/skills/metaobjects-codegen/SKILL.md"))).toBe(true);
  });

  test("a skill directory that still holds a file of the user's is kept with that file", async () => {
    await init({ cwd, servers: ["python"], clients: [] });
    writeFileSync(join(cwd, ".claude/skills/metaobjects-codegen/my-notes.md"), "mine\n", "utf8");
    await init({ cwd, refreshDocs: true, docsOnly: true, skillsDir: ".agents/skills" });
    expect(readdirSync(join(cwd, ".claude/skills"))).toEqual(["metaobjects-codegen"]);
    expect(readdirSync(join(cwd, ".claude/skills/metaobjects-codegen"))).toEqual(["my-notes.md"]);
  });

  test("a --skills-dir outside the project is refused before anything is written", async () => {
    await expect(init({ cwd, servers: ["python"], clients: [], skillsDir: "../elsewhere" })).rejects.toThrow(/--skills-dir/);
    expect(existsSync(join(cwd, ".metaobjects"))).toBe(false);
  });

  test("a refresh removes the duplicate .metaobjects/CLAUDE.md an earlier release wrote", async () => {
    await init({ cwd, servers: ["python"], clients: [] });
    // Simulate the earlier layout: the duplicate on disk and tracked in the manifest.
    const agents = readFileSync(join(cwd, ".metaobjects/AGENTS.md"), "utf8");
    writeFileSync(join(cwd, ".metaobjects/CLAUDE.md"), agents, "utf8");
    const mPath = join(cwd, ".metaobjects/.agent-context.json");
    const m = JSON.parse(readFileSync(mPath, "utf8"));
    m.files[".metaobjects/CLAUDE.md"] = m.files[".metaobjects/AGENTS.md"];
    writeFileSync(mPath, JSON.stringify(m, null, 2), "utf8");
    const r = await init({ cwd, refreshDocs: true, docsOnly: true });
    expect(existsSync(join(cwd, ".metaobjects/CLAUDE.md"))).toBe(false);
    expect(r.removed).toContain(".metaobjects/CLAUDE.md");
  });
});
