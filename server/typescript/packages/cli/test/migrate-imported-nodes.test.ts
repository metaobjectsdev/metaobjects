/**
 * FR-023 §11.1 item 2 — `meta migrate` never touches a dependency's tables.
 *
 * A consumer loads a dependency's nodes so its OWN model can resolve against them.
 * Those nodes are load-only: the publisher owns their tables, and this consumer
 * never declared them. So the suppression has to be two-sided, exactly as
 * `migrate.scope`'s is — the imported table leaves the EXPECTED side (no CREATE,
 * no ALTER) and is suppressed on the ACTUAL side (no DROP).
 *
 * Doing only the first half is strictly worse than doing nothing: the publisher's
 * table exists in the shared database, so removing it from `expected` alone turns
 * it into a proposed `DROP TABLE` — against data this consumer does not own. Case
 * (b) is that hazard.
 *
 * The opt-in is the declaration that already exists: naming the dependency's
 * package in `migrate.scope` says "I own these tables here" (case (c)).
 */
import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { METAMODEL_VERSION } from "@metaobjectsdev/metadata";
import { sha256Integrity } from "@metaobjectsdev/sdk";
import { snapshotPath, writeSnapshot } from "@metaobjectsdev/migrate-ts";
import { runBaseline, runOfflineGenerate } from "../src/commands/migrate.js";

const DEP_NAME = "acme-common";
const ARTIFACT_BASENAME = "acme-common.metaobjects.json";
const MIGRATIONS_DIR = ".metaobjects/migrations";

/** The dependency's synced snapshot — the publisher's `customers` table. */
const SNAP = JSON.stringify({
  "metadata.root": {
    children: [
      {
        "object.entity": {
          name: "Customer",
          package: "acme::common",
          children: [
            { "source.rdb": { "@table": "customers" } },
            { "field.long": { name: "id" } },
            { "field.string": { name: "email", "@maxLength": 120 } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
    ],
  },
});

/** The consumer's own model. */
const APP = JSON.stringify({
  "metadata.root": {
    package: "app",
    children: [
      {
        "object.entity": {
          name: "Order",
          children: [
            { "source.rdb": { "@table": "orders" } },
            { "field.long": { name: "id" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
    ],
  },
});

const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

/** A consumer of `acme-common`, optionally declaring `migrate.scope`. */
async function project(opts: { migrateScope?: string[] } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "migrate-imported-"));
  dirs.push(root);

  await mkdir(join(root, "metaobjects"), { recursive: true });
  await writeFile(join(root, "metaobjects", "meta.app.json"), APP, "utf8");

  const depDir = join(root, ".metaobjects", "deps", DEP_NAME);
  await mkdir(depDir, { recursive: true });
  await writeFile(join(depDir, ARTIFACT_BASENAME), SNAP, "utf8");

  const config: Record<string, unknown> = {
    schema_version: 1,
    sources: [],
    dependencies: [{ name: DEP_NAME, path: "../acme-common/metaobjects" }],
  };
  if (opts.migrateScope) config["migrate"] = { scope: opts.migrateScope };
  await writeFile(join(root, ".metaobjects", "config.json"), JSON.stringify(config), "utf8");

  await writeFile(
    join(root, ".metaobjects", "deps.lock.json"),
    JSON.stringify({
      schema_version: 1,
      dependencies: {
        [DEP_NAME]: {
          version: "1.0.0",
          metamodelVersion: METAMODEL_VERSION,
          resolvedFrom: { path: "../acme-common/metaobjects" },
          artifact: ARTIFACT_BASENAME,
          integrity: sha256Integrity(SNAP),
          packages: ["acme::common"],
          nodes: ["acme::common::Customer"],
        },
      },
    }),
    "utf8",
  );
  return root;
}

/** A greenfield reference snapshot: the file exists and records nothing. */
async function emptySnapshot(root: string): Promise<void> {
  await writeSnapshot(snapshotPath(join(root, MIGRATIONS_DIR), "sqlite"), { tables: [], views: [] });
}

const cfg = () =>
  ({ dialect: "sqlite", outDir: `./${MIGRATIONS_DIR}`, onAmbiguous: "abort",
     allow: [], slug: "auto", dryRun: false } as never);

const migrationDirs = async (root: string): Promise<string[]> =>
  (await readdir(join(root, MIGRATIONS_DIR))).filter((e) => !e.startsWith("."));

async function upSql(root: string): Promise<string> {
  const [dir] = await migrationDirs(root);
  expect(dir).toBeDefined();
  return await readFile(join(root, MIGRATIONS_DIR, dir!, "up.sql"), "utf8");
}

let out: string[];
let err: string[];
let origLog: typeof console.log;
let origErr: typeof console.error;

beforeEach(() => {
  out = [];
  err = [];
  origLog = console.log;
  origErr = console.error;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(" ")); };
});
afterEach(() => {
  console.log = origLog;
  console.error = origErr;
});

describe("meta migrate — imported tables are not governed (FR-023)", () => {
  test("(a) the consumer's own table is created; the import is neither created nor named as drift", async () => {
    const root = await project();
    await emptySnapshot(root);

    expect(await runOfflineGenerate(cfg(), root)).toBe(0);
    const up = await upSql(root);
    expect(up).toContain(`CREATE TABLE "orders"`);
    expect(up).not.toContain("customers");

    // The exclusion is REPORTED: an object silently dropped from the comparison is
    // indistinguishable from one that was checked and found clean. (Which STREAM it
    // lands on is the output format's decision, not this feature's — `logOutOfScope`
    // puts narration on stdout in text format and on stderr in the structured ones,
    // where stdout must carry exactly one document.)
    const reported = [...out, ...err].join("\n");
    expect(reported).toContain("1 object(s) from dependencies not governed here");
    expect(reported).toContain("public.customers");
    // ...and it is NOT reported as a `migrate.scope` exclusion: this project declares
    // no such key, so naming one would send the reader to a setting that isn't there.
    expect(reported).not.toContain("outside migrate.scope");
  });

  test("(b) the publisher's existing table is NOT proposed for drop", async () => {
    const root = await project();
    // An unscoped baseline records what the shared database holds — both owners'
    // tables — exactly as `baseline --from-db` would.
    expect(await runBaseline(cfg(), root)).toBe(0);
    out = [];
    err = [];

    // Nothing changed, and `customers` must not become a DROP just because this
    // consumer does not govern it. A proposed drop would be blocked (`allow` is
    // empty) and exit 1; an unsuppressed ACTUAL side is what would produce it.
    expect(await runOfflineGenerate(cfg(), root)).toBe(0);
    expect(await migrationDirs(root)).toHaveLength(0);
  });

  test("(c) naming the dependency's package in migrate.scope opts INTO owning its tables", async () => {
    const root = await project({ migrateScope: ["app::**", "acme::common::**"] });
    await emptySnapshot(root);

    expect(await runOfflineGenerate(cfg(), root)).toBe(0);
    const up = await upSql(root);
    expect(up).toContain(`CREATE TABLE "orders"`);
    expect(up).toContain(`CREATE TABLE "customers"`);
    // Nothing was excluded, so there is nothing to report.
    expect([...out, ...err].join("\n")).not.toContain("from dependencies not governed here");
  });
});
