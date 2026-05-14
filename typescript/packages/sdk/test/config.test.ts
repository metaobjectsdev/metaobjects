import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema, DEFAULT_CONFIG, loadConfig, saveConfig } from "../src/config.js";

let metaRoot: string;
beforeEach(() => {
  metaRoot = mkdtempSync(join(tmpdir(), "metaforge-config-"));
  mkdirSync(metaRoot, { recursive: true });
});
afterEach(() => {
  rmSync(metaRoot, { recursive: true, force: true });
});

describe("ConfigSchema", () => {
  test("accepts defaults", () => {
    const parsed = ConfigSchema.parse({ schema_version: 1 });
    expect(parsed.pending_in_git).toBe(true);
    expect(parsed.confidence_thresholds.pending_promote).toBe(0.8);
    expect(parsed.sources).toEqual([]);
  });
  test("accepts a path source", () => {
    const parsed = ConfigSchema.parse({
      schema_version: 1,
      sources: [{ kind: "path", path: "../shared/.meta" }],
    });
    expect(parsed.sources).toHaveLength(1);
  });
  test("accepts a package source", () => {
    const parsed = ConfigSchema.parse({
      schema_version: 1,
      sources: [{ kind: "package", package: "@acme/entities" }],
    });
    expect(parsed.sources).toHaveLength(1);
  });
  test("rejects invalid threshold", () => {
    expect(
      ConfigSchema.safeParse({
        schema_version: 1,
        confidence_thresholds: { pending_promote: 5 },
      }).success,
    ).toBe(false);
  });
});

describe("DEFAULT_CONFIG", () => {
  test("is a valid ConfigSchema", () => {
    expect(ConfigSchema.safeParse(DEFAULT_CONFIG).success).toBe(true);
  });
});

describe("loadConfig / saveConfig", () => {
  test("round-trips defaults", async () => {
    await saveConfig(metaRoot, DEFAULT_CONFIG);
    const loaded = await loadConfig(metaRoot);
    expect(loaded).toEqual(DEFAULT_CONFIG);
  });
});

describe("ConfigSchema — migrate block", () => {
  test("accepts a config with full migrate block", () => {
    const parsed = ConfigSchema.parse({
      schema_version: 1,
      migrate: {
        outDir: "./.meta/migrations",
        databaseUrl: "file:./local.db",
        dialect: "sqlite",
        onAmbiguous: "abort",
        allow: ["drop-column", "drop-table"],
      },
    });
    expect(parsed.migrate?.dialect).toBe("sqlite");
    expect(parsed.migrate?.allow).toEqual(["drop-column", "drop-table"]);
  });

  test("rejects invalid migrate.onAmbiguous", () => {
    expect(
      ConfigSchema.safeParse({
        schema_version: 1,
        migrate: { onAmbiguous: "guess" },
      }).success,
    ).toBe(false);
  });

  test("rejects invalid migrate.allow token", () => {
    expect(
      ConfigSchema.safeParse({
        schema_version: 1,
        migrate: { allow: ["drop-column", "burn-everything"] },
      }).success,
    ).toBe(false);
  });

  test("partial migrate block accepted", () => {
    const parsed = ConfigSchema.parse({
      schema_version: 1,
      migrate: { databaseUrl: "postgres://localhost/db" },
    });
    expect(parsed.migrate?.databaseUrl).toBe("postgres://localhost/db");
  });
});
