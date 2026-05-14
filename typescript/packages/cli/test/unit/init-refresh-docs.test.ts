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

describe("init writes agent docs", () => {
  test("writes AGENTS.md and CLAUDE.md under .metaforge/", async () => {
    await init({ cwd });
    expect(existsSync(join(cwd, ".metaforge", "AGENTS.md"))).toBe(true);
    expect(existsSync(join(cwd, ".metaforge", "CLAUDE.md"))).toBe(true);
  });

  test("AGENTS.md and CLAUDE.md have identical content", async () => {
    await init({ cwd });
    const a = readFileSync(join(cwd, ".metaforge", "AGENTS.md"), "utf8");
    const c = readFileSync(join(cwd, ".metaforge", "CLAUDE.md"), "utf8");
    expect(a).toBe(c);
  });

  test("AGENTS.md contains content-hash comment", async () => {
    await init({ cwd });
    const content = readFileSync(join(cwd, ".metaforge", "AGENTS.md"), "utf8");
    expect(content).toMatch(/<!-- metaforge-content-hash: [a-f0-9]{64} -->/);
  });

  test("AGENTS.md mentions key metamodel rules", async () => {
    await init({ cwd });
    const content = readFileSync(join(cwd, ".metaforge", "AGENTS.md"), "utf8");
    expect(content).toContain("attribute");
    expect(content).toContain("@forge");
    expect(content).toContain("decision");
  });
});

describe("init --refresh-docs", () => {
  test("hand-edited AGENTS.md gets .new file (non-destructive)", async () => {
    await init({ cwd });
    writeFileSync(join(cwd, ".metaforge", "AGENTS.md"), "stale content", "utf8");

    const result = await init({ cwd, refreshDocs: true });
    expect(result.created).toContain(".metaforge/AGENTS.md.new");
    expect(readFileSync(join(cwd, ".metaforge", "AGENTS.md"), "utf8")).toBe("stale content");
    expect(existsSync(join(cwd, ".metaforge", "AGENTS.md.new"))).toBe(true);
  });

  test("refresh overwrites AGENTS.md when content-hash matches", async () => {
    await init({ cwd });
    const result = await init({ cwd, refreshDocs: true });
    expect(result.created).toContain(".metaforge/AGENTS.md");
    expect(existsSync(join(cwd, ".metaforge", "AGENTS.md.new"))).toBe(false);
  });

  test("--refresh-docs works on a fresh repo too (full init runs)", async () => {
    await init({ cwd, refreshDocs: true });
    expect(existsSync(join(cwd, ".metaforge", "AGENTS.md"))).toBe(true);
  });
});

describe("metaobjects.config.ts section in refreshed docs", () => {
  test("refreshed CLAUDE.md describes metaobjects.config.ts as the wiring file", async () => {
    await init({ cwd });
    const claudeMd = readFileSync(join(cwd, ".metaobjects", "CLAUDE.md"), "utf8");
    expect(claudeMd).toContain("metaobjects.config.ts");
    expect(claudeMd).toContain("defineConfig");
    expect(claudeMd).toContain("@metaobjects/codegen-ts/generators");
    expect(claudeMd).not.toContain("--out-dir");
  });
});

describe("TanStack hooks + grid metadata in refreshed docs", () => {
  test("refreshed CLAUDE.md describes TanStack hooks + grid metadata", async () => {
    await init({ cwd });
    const claudeMd = readFileSync(join(cwd, ".metaforge", "CLAUDE.md"), "utf-8");
    expect(claudeMd).toContain("tanstackQuery");
    expect(claudeMd).toContain("tanstackGrid");
    expect(claudeMd).toContain("layout[dataGrid]");
    expect(claudeMd).toContain("EntityFetcherProvider");
    expect(claudeMd).toContain("CellRendererProvider");
    expect(claudeMd).toContain("@emitTanstack");
  });
});

describe("filter syntax + @filterable in refreshed docs", () => {
  test("refreshed CLAUDE.md describes filter syntax + @filterable", async () => {
    await init({ cwd });
    await init({ cwd, refreshDocs: true });
    const claudeMd = readFileSync(join(cwd, ".metaforge", "CLAUDE.md"), "utf-8");
    expect(claudeMd).toContain("@filterable");
    expect(claudeMd).toContain("useSubscribers(filter)");
    expect(claudeMd).toContain("filter[email][like]");
  });
});

describe("projection authoring in refreshed docs", () => {
  test("refreshed CLAUDE.md describes projection authoring", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "init-projection-docs-"));
    try {
      await init({ cwd: tmp, quiet: true });
      await init({ cwd: tmp, refreshDocs: true, quiet: true });
      const claudeMd = readFileSync(join(tmp, ".metaforge", "CLAUDE.md"), "utf-8");
      expect(claudeMd).toContain("Projections");
      expect(claudeMd).toContain("dbView");
      expect(claudeMd).toContain("useProgramSummaries");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("currency fields in refreshed docs", () => {
  test("refreshed CLAUDE.md describes currency fields", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "init-currency-docs-"));
    try {
      await init({ cwd: tmp, quiet: true });
      await init({ cwd: tmp, refreshDocs: true, quiet: true });
      const claudeMd = readFileSync(join(tmp, ".metaforge", "CLAUDE.md"), "utf-8");
      expect(claudeMd).toContain("Currency fields");
      expect(claudeMd).toContain("CurrencyInput");
      expect(claudeMd).toContain("@metaobjects/runtime-ts-client");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("initCommand --refresh-docs argv wrapper", () => {
  test("returns 0", async () => {
    const orig = process.cwd();
    process.chdir(cwd);
    try {
      expect(await initCommand([])).toBe(0);
      expect(await initCommand(["--refresh-docs"])).toBe(0);
    } finally {
      process.chdir(orig);
    }
  });
});
