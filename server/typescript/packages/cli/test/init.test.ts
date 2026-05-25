import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init, initCommand } from "../src/commands/init.js";
import { saveConfig, ConfigSchema } from "@metaobjectsdev/sdk";

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "metaobjects-init-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("init() — happy path", () => {
  test("creates metaobjects/ and .metaobjects/ directory tree", async () => {
    const result = await init({ cwd });
    expect(result.created).toContain("metaobjects");
    expect(result.created).toContain(".metaobjects");
    expect(result.created).toContain(".metaobjects/config.json");
    expect(result.created).toContain(".metaobjects/.gitignore");

    expect(existsSync(join(cwd, "metaobjects"))).toBe(true);
    expect(existsSync(join(cwd, "metaobjects", "meta.common.json"))).toBe(true);
    expect(existsSync(join(cwd, ".metaobjects"))).toBe(true);
    expect(existsSync(join(cwd, ".metaobjects", ".gen-state"))).toBe(true);
  });

  test("scaffolds package.meta.json under .metaobjects/ with three-field manifest", async () => {
    await init({ cwd });
    const manifestPath = join(cwd, ".metaobjects", "package.meta.json");
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.name).toBeDefined();
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.extends).toEqual([]);
  });

  test("writes a valid default config.json under .metaobjects/", async () => {
    await init({ cwd });
    const config = JSON.parse(readFileSync(join(cwd, ".metaobjects", "config.json"), "utf8"));
    expect(config.schema_version).toBe(1);
    expect(config.pending_in_git).toBe(true);
  });

  test("writes a .gitignore under .metaobjects/ that includes .gen-state", async () => {
    await init({ cwd });
    const ignore = readFileSync(join(cwd, ".metaobjects", ".gitignore"), "utf8");
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
    expect(result.created).toContain(".metaobjects/config.json");
    // Records in metaobjects/ are preserved
    expect(existsSync(join(cwd, "metaobjects", "entity-preserve-me.json"))).toBe(true);
  });

  test("--print-only writes nothing to disk", async () => {
    const result = await init({ cwd, printOnly: true });
    expect(result.created.length).toBeGreaterThan(0);
    expect(existsSync(join(cwd, "metaobjects"))).toBe(false);
    expect(existsSync(join(cwd, ".metaobjects"))).toBe(false);
  });
});

describe("initCommand argv wrapper", () => {
  test("returns 0 on success", async () => {
    expect(await initCommand([], cwd)).toBe(0);
  });
  test("returns 1 when metaobjects/ exists without --force", async () => {
    mkdirSync(join(cwd, "metaobjects"));
    expect(await initCommand([], cwd)).toBe(1);
  });
  test("returns 2 on unknown flag", async () => {
    expect(await initCommand(["--foo"], cwd)).toBe(2);
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
    await saveConfig(join(cwd, ".metaobjects"), ConfigSchema.parse(customConfig));

    // Re-init with --force
    const result = await init({ cwd, force: true });
    expect(result.preserved).toContain(".metaobjects/config.json");

    // Customizations survived
    const reloaded = JSON.parse(readFileSync(join(cwd, ".metaobjects", "config.json"), "utf8"));
    expect(reloaded.pending_in_git).toBe(false);
    expect(reloaded.confidence_thresholds.pending_promote).toBe(0.95);
    expect(reloaded.sources).toEqual([{ kind: "package", package: "@acme/entities" }]);
  });

  test("writes fresh defaults when existing config is invalid (and warns)", async () => {
    await init({ cwd });
    // Corrupt the config
    writeFileSync(join(cwd, ".metaobjects", "config.json"), "{ not valid", "utf8");

    const result = await init({ cwd, force: true });

    // Warnings array mentions invalid config
    expect(result.warnings.some((w) => w.toLowerCase().includes("invalid"))).toBe(true);

    // Fresh defaults written
    const reloaded = JSON.parse(readFileSync(join(cwd, ".metaobjects", "config.json"), "utf8"));
    expect(reloaded.schema_version).toBe(1);
    expect(reloaded.pending_in_git).toBe(true); // back to default
  });
});

describe("init --d1", () => {
  test("scaffolds config with migrate.dialect = 'd1' and prefilled binding from wrangler.toml", async () => {
    writeFileSync(join(cwd, "wrangler.toml"), [
      `name = "myapp"`,
      ``,
      `[[d1_databases]]`,
      `binding = "DB"`,
      `database_name = "myapp-prod"`,
      `database_id = "abc-123"`,
    ].join("\n"));
    const code = await initCommand(["--d1"], cwd);
    expect(code).toBe(0);
    const cfg = JSON.parse(readFileSync(join(cwd, ".metaobjects", "config.json"), "utf8"));
    expect(cfg.migrate.dialect).toBe("d1");
    expect(cfg.migrate.d1.binding).toBe("DB");
  });

  test("scaffolds config with migrate.dialect = 'd1' but no binding when wrangler.toml absent", async () => {
    const code = await initCommand(["--d1"], cwd);
    expect(code).toBe(0);
    const cfg = JSON.parse(readFileSync(join(cwd, ".metaobjects", "config.json"), "utf8"));
    expect(cfg.migrate.dialect).toBe("d1");
    expect(cfg.migrate.d1?.binding).toBeUndefined();
  });

  test("without --d1, existing init behavior is unchanged", async () => {
    const code = await initCommand([], cwd);
    expect(code).toBe(0);
    const cfg = JSON.parse(readFileSync(join(cwd, ".metaobjects", "config.json"), "utf8"));
    // DEFAULT_CONFIG has no migrate block; the d1 path must not pollute the default path
    expect(cfg.migrate?.dialect ?? "sqlite").toBe("sqlite");
  });

  test("--force --d1 on a valid existing config preserves existing config (does not retro-fit d1)", async () => {
    // First init without --d1 — produces sqlite-default config.
    await initCommand([], cwd);
    const before = JSON.parse(readFileSync(join(cwd, ".metaobjects", "config.json"), "utf8"));
    expect(before.migrate?.dialect ?? "sqlite").toBe("sqlite");

    // Re-init with --force --d1 — existing config is preserved, --d1 is ignored.
    const code = await initCommand(["--force", "--d1"], cwd);
    expect(code).toBe(0);
    const after = JSON.parse(readFileSync(join(cwd, ".metaobjects", "config.json"), "utf8"));
    expect(after.migrate?.dialect ?? "sqlite").toBe("sqlite");  // unchanged
  });

  test("scaffolds config with migrate.dialect = 'd1' but no d1 block when wrangler.toml has multiple bindings", async () => {
    writeFileSync(join(cwd, "wrangler.toml"), [
      `name = "myapp"`,
      ``,
      `[[d1_databases]]`,
      `binding = "DB"`,
      `database_name = "myapp-prod"`,
      `database_id = "abc-123"`,
      ``,
      `[[d1_databases]]`,
      `binding = "CACHE"`,
      `database_name = "myapp-cache"`,
      `database_id = "def-456"`,
    ].join("\n"));
    const code = await initCommand(["--d1"], cwd);
    expect(code).toBe(0);
    const cfg = JSON.parse(readFileSync(join(cwd, ".metaobjects", "config.json"), "utf8"));
    expect(cfg.migrate.dialect).toBe("d1");
    expect(cfg.migrate.d1).toBeUndefined();
  });

  test("scaffolds metaobjects.config.ts with dialect = 'd1' when --d1 is passed", async () => {
    const code = await initCommand(["--d1"], cwd);
    expect(code).toBe(0);
    const configTs = readFileSync(join(cwd, "metaobjects.config.ts"), "utf8");
    expect(configTs).toContain('dialect:   "d1"');
  });

  test("scaffolds metaobjects.config.ts with dialect = 'sqlite' when --d1 is not passed", async () => {
    const code = await initCommand([], cwd);
    expect(code).toBe(0);
    const configTs = readFileSync(join(cwd, "metaobjects.config.ts"), "utf8");
    expect(configTs).toContain('dialect:   "sqlite"');
  });
});
