import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init, initCommand } from "../../src/commands/init.js";

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "init-refresh-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

// NOTE: the legacy single-blob AGENT_DOCS_BODY was replaced by the agent-context
// assembler (always-on AGENTS.md/CLAUDE.md + per-stack skill fragments + a manifest).
// The detailed authoring/codegen/tanstack/filter/projection/currency prose now lives
// in the `metaobjects-*` skill reference fragments, NOT in the always-on body — so
// the old content-blob assertions are gone. These tests cover the always-on body and
// the non-destructive refresh contract.

describe("init writes agent docs", () => {
  test("writes AGENTS.md and CLAUDE.md under .metaobjects/", async () => {
    await init({ cwd });
    expect(existsSync(join(cwd, ".metaobjects", "AGENTS.md"))).toBe(true);
    expect(existsSync(join(cwd, ".metaobjects", "CLAUDE.md"))).toBe(true);
  });

  test("AGENTS.md and CLAUDE.md have identical content", async () => {
    await init({ cwd });
    const a = readFileSync(join(cwd, ".metaobjects", "AGENTS.md"), "utf8");
    const c = readFileSync(join(cwd, ".metaobjects", "CLAUDE.md"), "utf8");
    expect(a).toBe(c);
  });

  test("scaffolds the agent-context manifest", async () => {
    await init({ cwd });
    expect(existsSync(join(cwd, ".metaobjects", ".agent-context.json"))).toBe(true);
  });

  test("AGENTS.md mentions key metamodel rules", async () => {
    await init({ cwd });
    const content = readFileSync(join(cwd, ".metaobjects", "AGENTS.md"), "utf8");
    expect(content).toContain("Attribute");
    expect(content).toContain("codegen");
    expect(content).toContain("metadata");
  });
});

describe("init --refresh-docs", () => {
  test("hand-edited AGENTS.md gets .new file (non-destructive)", async () => {
    await init({ cwd });
    writeFileSync(join(cwd, ".metaobjects", "AGENTS.md"), "stale content", "utf8");

    const result = await init({ cwd, refreshDocs: true });
    expect(result.created).toContain(".metaobjects/AGENTS.md.new");
    expect(readFileSync(join(cwd, ".metaobjects", "AGENTS.md"), "utf8")).toBe("stale content");
    expect(existsSync(join(cwd, ".metaobjects", "AGENTS.md.new"))).toBe(true);
  });

  test("refresh overwrites AGENTS.md when it is unmodified since last scaffold", async () => {
    await init({ cwd });
    const result = await init({ cwd, refreshDocs: true });
    expect(result.created).toContain(".metaobjects/AGENTS.md");
    expect(existsSync(join(cwd, ".metaobjects", "AGENTS.md.new"))).toBe(false);
  });

  test("--refresh-docs works on a fresh repo too (full init runs)", async () => {
    await init({ cwd, refreshDocs: true });
    expect(existsSync(join(cwd, ".metaobjects", "AGENTS.md"))).toBe(true);
  });
});

describe("init --refresh-docs --force (issue #163)", () => {
  test("refreshes docs only — does NOT re-scaffold the project", async () => {
    await init({ cwd });
    // Remove scaffold-only artifacts; a refresh must not recreate them.
    rmSync(join(cwd, "metaobjects.config.ts"), { force: true });
    rmSync(join(cwd, "metaobjects"), { recursive: true, force: true });

    await init({ cwd, refreshDocs: true, force: true });

    // Docs refreshed …
    expect(existsSync(join(cwd, ".metaobjects", "AGENTS.md"))).toBe(true);
    // … but the project scaffold is NOT re-created by a docs refresh.
    expect(existsSync(join(cwd, "metaobjects.config.ts"))).toBe(false);
    expect(existsSync(join(cwd, "metaobjects"))).toBe(false);
  });

  test("--force overwrites a hand-edited doc in place (no .new)", async () => {
    await init({ cwd });
    writeFileSync(join(cwd, ".metaobjects", "AGENTS.md"), "stale content", "utf8");

    await init({ cwd, refreshDocs: true, force: true });

    expect(existsSync(join(cwd, ".metaobjects", "AGENTS.md.new"))).toBe(false);
    expect(readFileSync(join(cwd, ".metaobjects", "AGENTS.md"), "utf8")).not.toBe("stale content");
  });
});

describe("init --refresh-docs preserves the persisted stack (issue #163)", () => {
  test("refresh reuses the manifest stack instead of re-detecting from the root", async () => {
    // A multi-package monorepo stack, as an explicit init would record it. The tmp
    // cwd has no package.json / build files, so root-probe detection would yield an
    // empty stack — the refresh must NOT regress to that.
    await init({ cwd, servers: ["java", "kotlin"], clients: ["react", "tanstack"] });
    const before = readFileSync(join(cwd, ".metaobjects", "AGENTS.md"), "utf8");
    expect(before).toContain("java, kotlin server");
    expect(before).toContain("react, tanstack client");

    await init({ cwd, refreshDocs: true });

    const after = readFileSync(join(cwd, ".metaobjects", "AGENTS.md"), "utf8");
    expect(after).toContain("java, kotlin server");
    expect(after).toContain("react, tanstack client");
    // Same stack + unmodified doc → refreshed in place, never a spurious .new.
    expect(existsSync(join(cwd, ".metaobjects", "AGENTS.md.new"))).toBe(false);
  });
});

describe("metaobjects.config.ts wiring still scaffolded", () => {
  test("init writes metaobjects.config.ts with defineConfig wiring", async () => {
    await init({ cwd });
    const configTs = readFileSync(join(cwd, "metaobjects.config.ts"), "utf8");
    expect(configTs).toContain("defineConfig");
    // ADR-0034 — the scaffolded config imports the OWNED local generators, never the
    // deprecated package `/generators` export.
    expect(configTs).toContain('from "./codegen/generators/entity.js"');
    expect(configTs).not.toContain("@metaobjectsdev/codegen-ts/generators");
  });
});

describe("initCommand --refresh-docs argv wrapper", () => {
  test("returns 0", async () => {
    expect(await initCommand([], cwd)).toBe(0);
    expect(await initCommand(["--refresh-docs"], cwd)).toBe(0);
  });
});
