import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGenConfig, resolveMigrateConfig } from "../../src/lib/config.js";

function makeRoot(configBody?: object): string {
  const root = mkdtempSync(join(tmpdir(), "config-resolver-"));
  mkdirSync(join(root, ".metaobjects"), { recursive: true });
  if (configBody !== undefined) {
    writeFileSync(
      join(root, ".metaobjects", "config.json"),
      JSON.stringify({ schema_version: 1, ...configBody }, null, 2),
    );
  }
  return root;
}

describe("resolveGenConfig", () => {
  // resolveGenConfig is now synchronous and minimal: metaobjects.config.ts owns
  // outDir/dialect/dbImport/extStyle. Only dryRun + entities come from flags.

  test("passes dryRun and entities through", () => {
    const resolved = resolveGenConfig({ dryRun: true, entities: ["User", "Post"] });
    expect(resolved.dryRun).toBe(true);
    expect(resolved.entities).toEqual(["User", "Post"]);
  });

  test("defaults: dryRun false, entities empty", () => {
    const resolved = resolveGenConfig({ dryRun: false, entities: [] });
    expect(resolved.dryRun).toBe(false);
    expect(resolved.entities).toEqual([]);
  });
});

describe("resolveMigrateConfig", () => {
  let root: string;
  const origEnv = process.env.DATABASE_URL;
  beforeEach(() => {
    delete process.env.DATABASE_URL;
  });
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    if (origEnv === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = origEnv;
  });

  const defaultD1Flags = {
    d1Binding: undefined,
    remote: false,
    apply: false,
    yes: false,
  } as const;

  test("built-in defaults when no flag/env/config", async () => {
    root = makeRoot();
    const resolved = await resolveMigrateConfig({
      db: undefined,
      dialect: undefined,
      outDir: undefined,
      slug: undefined,
      allow: [],
      onAmbiguous: undefined,
      dryRun: false,
      ...defaultD1Flags,
    }, root);
    expect(resolved.outDir).toBe("./.metaobjects/migrations");
    expect(resolved.databaseUrl).toBeUndefined();
    expect(resolved.onAmbiguous).toBe("abort");
    expect(resolved.allow).toEqual([]);
  });

  test("DATABASE_URL env wins over config", async () => {
    process.env.DATABASE_URL = "env://from-env";
    root = makeRoot({
      migrate: { databaseUrl: "config://from-config" },
    });
    const resolved = await resolveMigrateConfig({
      db: undefined,
      dialect: undefined,
      outDir: undefined,
      slug: undefined,
      allow: [],
      onAmbiguous: undefined,
      dryRun: false,
      ...defaultD1Flags,
    }, root);
    expect(resolved.databaseUrl).toBe("env://from-env");
  });

  test("--db flag wins over env", async () => {
    process.env.DATABASE_URL = "env://from-env";
    root = makeRoot();
    const resolved = await resolveMigrateConfig({
      db: "flag://from-flag",
      dialect: undefined,
      outDir: undefined,
      slug: undefined,
      allow: [],
      onAmbiguous: undefined,
      dryRun: false,
      ...defaultD1Flags,
    }, root);
    expect(resolved.databaseUrl).toBe("flag://from-flag");
  });

  test("config allow + flag allow concatenate is NOT the behavior — flag replaces", async () => {
    root = makeRoot({
      migrate: { allow: ["drop-column"] },
    });
    const resolved = await resolveMigrateConfig({
      db: undefined,
      dialect: undefined,
      outDir: undefined,
      slug: undefined,
      allow: ["drop-table"],
      onAmbiguous: undefined,
      dryRun: false,
      ...defaultD1Flags,
    }, root);
    expect(resolved.allow).toEqual(["drop-table"]);
  });

  test("empty .metaobjects/ (config.json missing) is allowed", async () => {
    root = mkdtempSync(join(tmpdir(), "config-resolver-empty-"));
    try {
      mkdirSync(join(root, ".metaobjects"), { recursive: true });
      const resolved = await resolveMigrateConfig({
        db: "file:./x.db",
        dialect: undefined,
        outDir: undefined,
        slug: undefined,
        allow: [],
        onAmbiguous: undefined,
        dryRun: false,
        ...defaultD1Flags,
      }, root);
      expect(resolved.databaseUrl).toBe("file:./x.db");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
