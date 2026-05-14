import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init, initCommand } from "../src/commands/init.js";
import { saveConfig, ConfigSchema } from "@metaforge/sdk";

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "metaforge-init-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("init() — happy path", () => {
  test("creates metaobjects/ and .metaforge/ directory tree", async () => {
    const result = await init({ cwd });
    expect(result.created).toContain("metaobjects");
    expect(result.created).toContain(".metaforge");
    expect(result.created).toContain(".metaforge/config.json");
    expect(result.created).toContain(".metaforge/.gitignore");

    expect(existsSync(join(cwd, "metaobjects"))).toBe(true);
    expect(existsSync(join(cwd, "metaobjects", "meta.common.json"))).toBe(true);
    expect(existsSync(join(cwd, ".metaforge"))).toBe(true);
    expect(existsSync(join(cwd, ".metaforge", ".gen-state"))).toBe(true);
  });

  test("scaffolds package.meta.json under .metaforge/ with three-field manifest", async () => {
    await init({ cwd });
    const manifestPath = join(cwd, ".metaforge", "package.meta.json");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.name).toBeDefined();
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.extends).toEqual([]);
  });

  test("writes a valid default config.json under .metaforge/", async () => {
    await init({ cwd });
    const config = JSON.parse(readFileSync(join(cwd, ".metaforge", "config.json"), "utf8"));
    expect(config.schema_version).toBe(1);
    expect(config.pending_in_git).toBe(true);
  });

  test("writes a .gitignore under .metaforge/ that includes .gen-state", async () => {
    await init({ cwd });
    const ignore = readFileSync(join(cwd, ".metaforge", ".gitignore"), "utf8");
    expect(ignore).toContain(".gen-state/");
  });

  test("does NOT create legacy .meta/ directory", async () => {
    await init({ cwd });
    expect(existsSync(join(cwd, ".meta"))).toBe(false);
  });
});

describe("init() — re-run safety", () => {
  test("throws when metaobjects/ exists and --force is not set", async () => {
    mkdirSync(join(cwd, "metaobjects"));
    await expect(init({ cwd })).rejects.toThrow(/already exists/);
  });

  test("succeeds when --force is set", async () => {
    mkdirSync(join(cwd, "metaobjects"), { recursive: true });
    writeFileSync(join(cwd, "metaobjects", "entity-preserve-me.json"), "{}");
    const result = await init({ cwd, force: true });
    expect(result.created).toContain(".metaforge/config.json");
    // Records in metaobjects/ are preserved
    expect(existsSync(join(cwd, "metaobjects", "entity-preserve-me.json"))).toBe(true);
  });

  test("--print-only writes nothing to disk", async () => {
    const result = await init({ cwd, printOnly: true });
    expect(result.created.length).toBeGreaterThan(0);
    expect(existsSync(join(cwd, "metaobjects"))).toBe(false);
    expect(existsSync(join(cwd, ".metaforge"))).toBe(false);
  });
});

describe("initCommand argv wrapper", () => {
  test("returns 0 on success", async () => {
    const orig = process.cwd();
    process.chdir(cwd);
    try {
      expect(await initCommand([])).toBe(0);
    } finally {
      process.chdir(orig);
    }
  });
  test("returns 1 when metaobjects/ exists without --force", async () => {
    mkdirSync(join(cwd, "metaobjects"));
    const orig = process.cwd();
    process.chdir(cwd);
    try {
      expect(await initCommand([])).toBe(1);
    } finally {
      process.chdir(orig);
    }
  });
  test("returns 2 on unknown flag", async () => {
    const orig = process.cwd();
    process.chdir(cwd);
    try {
      expect(await initCommand(["--foo"])).toBe(2);
    } finally {
      process.chdir(orig);
    }
  });
});

describe("init() --force config preservation", () => {
  test("preserves existing valid config when --force is set", async () => {
    // First init
    await init({ cwd });
    // User customizes config
    const customConfig = {
      schema_version: 1 as const,
      pending_in_git: false,                    // changed from default
      confidence_thresholds: { pending_promote: 0.95, drift_warn: 0.8 },
      sources: [{ kind: "package" as const, package: "@acme/entities" }],
      extract: {},
    };
    await saveConfig(join(cwd, ".metaforge"), ConfigSchema.parse(customConfig));

    // Re-init with --force
    const result = await init({ cwd, force: true });
    expect(result.preserved).toContain(".metaforge/config.json");

    // Customizations survived
    const reloaded = JSON.parse(readFileSync(join(cwd, ".metaforge", "config.json"), "utf8"));
    expect(reloaded.pending_in_git).toBe(false);
    expect(reloaded.confidence_thresholds.pending_promote).toBe(0.95);
    expect(reloaded.sources).toEqual([{ kind: "package", package: "@acme/entities" }]);
  });

  test("writes fresh defaults when existing config is invalid (and warns)", async () => {
    await init({ cwd });
    // Corrupt the config
    writeFileSync(join(cwd, ".metaforge", "config.json"), "{ not valid", "utf8");

    const result = await init({ cwd, force: true });

    // Warnings array mentions invalid config
    expect(result.warnings.some((w) => w.toLowerCase().includes("invalid"))).toBe(true);

    // Fresh defaults written
    const reloaded = JSON.parse(readFileSync(join(cwd, ".metaforge", "config.json"), "utf8"));
    expect(reloaded.schema_version).toBe(1);
    expect(reloaded.pending_in_git).toBe(true); // back to default
  });
});
