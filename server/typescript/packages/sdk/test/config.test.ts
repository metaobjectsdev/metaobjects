import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema, DEFAULT_CONFIG, loadConfig, saveConfig } from "../src/config.js";

let metaRoot: string;
beforeEach(() => {
  metaRoot = mkdtempSync(join(tmpdir(), "metaobjects-config-"));
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
      sources: [{ path: "../shared/.meta" }],
    });
    expect(parsed.sources).toHaveLength(1);
  });
  test("accepts a package source", () => {
    const parsed = ConfigSchema.parse({
      schema_version: 1,
      sources: [{ package: "@acme/entities" }],
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

describe("ConfigSchema — phase-1 source resolution", () => {
  test("accepts a path source", () => {
    const p = ConfigSchema.parse({ schema_version: 1, sources: [{ path: "../model" }] });
    expect(p.sources).toEqual([{ path: "../model" }]);
  });
  test("accepts resource and package source kinds", () => {
    const p = ConfigSchema.parse({
      schema_version: 1,
      sources: [{ resource: "acme/model" }, { package: "@acme/model" }],
    });
    expect(p.sources).toHaveLength(2);
  });
  test("rejects an unknown source kind", () => {
    expect(() => ConfigSchema.parse({ schema_version: 1, sources: [{ nope: "x" }] })).toThrow();
  });
  test("rejects a source with an unrecognized extra key (fail-closed, not stripped)", () => {
    // A typo'd sibling key must not silently vanish and leave a
    // valid-looking single-key source behind — .strict() on every
    // SourceSpecSchema arm means an unknown key is a hard parse error,
    // matching this project's fail-closed posture elsewhere (ADR-0023).
    expect(() =>
      ConfigSchema.parse({ schema_version: 1, sources: [{ path: "model", pathh: "typo" }] }),
    ).toThrow();
  });
  test("accepts a scope block", () => {
    const p = ConfigSchema.parse({
      schema_version: 1,
      scope: { include: ["acme::**"], exclude: ["acme::internal::**"] },
    });
    expect(p.scope?.include).toEqual(["acme::**"]);
  });
  test("scope defaults to undefined (match everything)", () => {
    expect(ConfigSchema.parse({ schema_version: 1 }).scope).toBeUndefined();
  });
  test("accepts migrate.scope", () => {
    const p = ConfigSchema.parse({
      schema_version: 1,
      migrate: { scope: ["acme::platform::**"] },
    });
    expect(p.migrate?.scope).toEqual(["acme::platform::**"]);
  });
  test("an existing config with no new keys still parses (back-compat)", () => {
    const p = ConfigSchema.parse({
      schema_version: 1, pending_in_git: true,
      confidence_thresholds: { pending_promote: 0.8, drift_warn: 0.7 },
      sources: [], extract: {},
    });
    expect(p.sources).toEqual([]);
    expect(p.scope).toBeUndefined();
  });
});
