import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGenConfig, resolveMigrateConfig, resolveD1Config } from "../../src/lib/config.js";
import { DEFAULT_ADVISORY_LIMIT } from "../../src/lib/advisory.js";

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
    const resolved = resolveGenConfig({ dryRun: true, entities: ["User", "Post"], baseline: "default", list: false, noAntipatterns: false, limit: DEFAULT_ADVISORY_LIMIT });
    expect(resolved.dryRun).toBe(true);
    expect(resolved.entities).toEqual(["User", "Post"]);
  });

  test("defaults: dryRun false, entities empty", () => {
    const resolved = resolveGenConfig({ dryRun: false, entities: [], baseline: "default", list: false, noAntipatterns: false, limit: DEFAULT_ADVISORY_LIMIT });
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
    format: undefined,
    d1Binding: undefined,
    remote: false,
    apply: false,
    rollback: undefined,
    yes: false,
    fromDb: false,
    baseline: false,
    applyPending: false,
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

  test("d1 block: flag wins for binding; config wins for remote when flag is false", async () => {
    root = makeRoot({
      migrate: { d1: { remote: true, autoApply: false, wranglerConfigPath: "./wrangler.toml" } },
    });
    const resolved = await resolveMigrateConfig({
      db: undefined,
      dialect: "d1",
      format: undefined,
      outDir: undefined,
      slug: undefined,
      allow: [],
      onAmbiguous: undefined,
      dryRun: false,
      d1Binding: "MYDB",
      remote: false,
      apply: false,
      rollback: undefined,
      yes: false,
      fromDb: false,
      baseline: false,
      applyPending: false,
    }, root);
    expect(resolved.d1?.binding).toBe("MYDB");
    expect(resolved.d1?.remote).toBe(true);
    expect(resolved.d1?.autoApply).toBe(false);
    expect(resolved.d1?.wranglerConfigPath).toBe("./wrangler.toml");
  });

  test("d1 block: flag remote=true beats config remote=false", async () => {
    root = makeRoot({ migrate: { d1: { remote: false } } });
    const resolved = await resolveMigrateConfig({
      db: undefined,
      dialect: "d1",
      format: undefined,
      outDir: undefined,
      slug: undefined,
      allow: [],
      onAmbiguous: undefined,
      dryRun: false,
      d1Binding: undefined,
      remote: true,
      apply: false,
      rollback: undefined,
      yes: false,
      fromDb: false,
      baseline: false,
      applyPending: false,
    }, root);
    expect(resolved.d1?.remote).toBe(true);
  });
});

// #225 — resolveD1Config is the D1-block resolution factored out of
// resolveMigrateConfig so `meta verify --dialect d1` honors the SAME
// local-vs-remote / binding / wranglerConfigPath precedence `meta migrate
// --dialect d1` does, without a second divergent implementation.
describe("resolveD1Config", () => {
  let root: string;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("no config file: flags pass straight through, autoApply defaults false", async () => {
    root = makeRoot();
    const resolved = await resolveD1Config({ d1Binding: "DB", remote: false }, root);
    expect(resolved).toEqual({
      binding: "DB",
      remote: false,
      autoApply: false,
      wranglerConfigPath: undefined,
    });
  });

  test("flag wins for binding; config wins for remote when flag is false", async () => {
    root = makeRoot({
      migrate: { d1: { remote: true, autoApply: false, wranglerConfigPath: "./wrangler.toml" } },
    });
    const resolved = await resolveD1Config({ d1Binding: "MYDB", remote: false }, root);
    expect(resolved.binding).toBe("MYDB");
    expect(resolved.remote).toBe(true);
    expect(resolved.autoApply).toBe(false);
    expect(resolved.wranglerConfigPath).toBe("./wrangler.toml");
  });

  test("flag remote=true beats config remote=false", async () => {
    root = makeRoot({ migrate: { d1: { remote: false } } });
    const resolved = await resolveD1Config({ d1Binding: undefined, remote: true }, root);
    expect(resolved.remote).toBe(true);
  });

  test("binding falls back to the config block when no flag is given", async () => {
    root = makeRoot({ migrate: { d1: { binding: "FROM_CONFIG" } } });
    const resolved = await resolveD1Config({ d1Binding: undefined, remote: false }, root);
    expect(resolved.binding).toBe("FROM_CONFIG");
  });

  test("matches resolveMigrateConfig's d1 block for the same inputs", async () => {
    root = makeRoot({
      migrate: { d1: { remote: true, autoApply: true, wranglerConfigPath: "./wrangler.toml" } },
    });
    const viaMigrate = await resolveMigrateConfig({
      db: undefined,
      dialect: "d1",
      format: undefined,
      outDir: undefined,
      slug: undefined,
      allow: [],
      onAmbiguous: undefined,
      dryRun: false,
      d1Binding: "DB",
      remote: false,
      apply: false,
      rollback: undefined,
      yes: false,
      fromDb: false,
      baseline: false,
      applyPending: false,
    }, root);
    const viaVerify = await resolveD1Config({ d1Binding: "DB", remote: false }, root);
    expect(viaVerify).toEqual(viaMigrate.d1);
  });
});
