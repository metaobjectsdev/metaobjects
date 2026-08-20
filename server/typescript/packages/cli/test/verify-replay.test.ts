/**
 * `meta verify --replay` / `--replay-snapshot` (#313).
 *
 * `meta migrate` could write a chain that cannot be replayed — a bare
 * `DROP TABLE "x"` for an object no migration ever created, because another tool
 * owns it — and nothing noticed until someone provisioned a fresh database. These
 * gates replay the committed chain into an empty throwaway engine and say so.
 *
 * The flag-parse cases below are necessary and nowhere near sufficient: a flag that
 * parses correctly and reaches no gate is exactly the failure mode this feature is
 * most exposed to, so every tier has a case that drives `verifyCommand` end to end
 * against a real project on disk.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseVerifyArgs } from "../src/lib/args.js";
import { verifyCommand } from "../src/commands/verify.js";
import { runBaseline, runOfflineGenerate } from "../src/commands/migrate.js";

const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

const MIGRATIONS = "./.metaobjects/migrations";

/** A shape carrying no `source.*`, so it is not persistable and the schema is empty. */
const NO_TABLES = JSON.stringify({
  "metadata.root": {
    package: "acme::platform",
    children: [{
      "object.value": {
        name: "Placeholder",
        children: [{ "field.string": { name: "note" } }],
      },
    }],
  },
});

const MODEL = JSON.stringify({
  "metadata.root": {
    package: "acme::platform",
    children: [{
      "object.entity": {
        name: "Job",
        children: [
          { "source.rdb": { name: "src", "@table": "jobs" } },
          { "field.long": { name: "id" } },
          { "field.string": { name: "title", "@maxLength": 80 } },
          { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
        ],
      },
    }],
  },
});

const cfg = () =>
  ({ dialect: "sqlite", outDir: MIGRATIONS, onAmbiguous: "abort",
     allow: [], slug: "init", dryRun: false } as never);

/** A project with metadata and a declared sqlite dialect, but no migrations yet. */
async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "verify-replay-"));
  dirs.push(root);
  await mkdir(join(root, "metaobjects"), { recursive: true });
  await writeFile(join(root, "metaobjects", "meta.platform.json"), MODEL, "utf8");
  await mkdir(join(root, ".metaobjects", "migrations"), { recursive: true });
  await writeFile(
    join(root, ".metaobjects", "config.json"),
    JSON.stringify({ schema_version: 1, migrate: { dialect: "sqlite", outDir: MIGRATIONS } }),
    "utf8",
  );
  return root;
}

/**
 * A genuine greenfield chain: baseline against a model declaring NO tables (so the
 * reference snapshot starts empty, as a fresh project's does), then generate. The
 * result is a chain that BUILDS the schema — which is the population `--replay` and
 * `--replay-snapshot` are for, and the opposite of a `baseline --from-db` adoption
 * whose snapshot is the whole database against an empty chain.
 */
async function withGeneratedChain(root: string): Promise<void> {
  await writeFile(join(root, "metaobjects", "meta.platform.json"), NO_TABLES, "utf8");
  expect(await runBaseline(cfg(), root)).toBe(0);
  await writeFile(join(root, "metaobjects", "meta.platform.json"), MODEL, "utf8");
  expect(await runOfflineGenerate(cfg(), root)).toBe(0);
}

/** A hand-written chain that applies cleanly. */
async function withApplyingChain(root: string): Promise<void> {
  const dir = join(root, ".metaobjects", "migrations", "20260101000000-init");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "up.sql"), 'CREATE TABLE "jobs" (id INTEGER NOT NULL PRIMARY KEY);', "utf8");
  await writeFile(join(dir, "down.sql"), 'DROP TABLE "jobs";', "utf8");
}

/** Hand-write a migration whose up.sql drops something the chain never creates. */
async function withBrokenChain(root: string): Promise<void> {
  const dir = join(root, ".metaobjects", "migrations", "20260101000000-init");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "up.sql"),
    'CREATE TABLE "jobs" (id INTEGER NOT NULL PRIMARY KEY);\n\nDROP TABLE "theirs";',
    "utf8",
  );
  await writeFile(join(dir, "down.sql"), 'DROP TABLE "jobs";', "utf8");
}

describe("verify --replay / --replay-snapshot flags", () => {
  test("both are parsed", () => {
    expect(parseVerifyArgs(["--replay"]).replay).toBe(true);
    expect(parseVerifyArgs(["--replay-snapshot"]).replaySnapshot).toBe(true);
  });

  test("both default off", () => {
    expect(parseVerifyArgs([]).replay).toBe(false);
    expect(parseVerifyArgs([]).replaySnapshot).toBe(false);
  });

  // Without this, `meta verify --replay` would ALSO run the template gate as the
  // bare-verify default, and report drift the user never asked about.
  test("each counts as an explicit subverb", () => {
    expect(parseVerifyArgs(["--replay"]).anyExplicit).toBe(true);
    expect(parseVerifyArgs(["--replay-snapshot"]).anyExplicit).toBe(true);
  });

  // `--lax` is ADR-0023 attribute strictness — a different axis entirely, which is
  // why the second tier is its own subverb and not `--strict`.
  test("does not collide with --lax", () => {
    const f = parseVerifyArgs(["--replay-snapshot", "--lax"]);
    expect(f.replaySnapshot).toBe(true);
    expect(f.lax).toBe(true);
  });
});

describe("verify --replay runs the gate", () => {
  test("a chain that drops an object it never creates fails", async () => {
    const root = await project();
    await withBrokenChain(root);
    expect(await verifyCommand(["--replay"], root)).toBe(1);
  });

  test("a generated chain applies to an empty database", async () => {
    const root = await project();
    await withGeneratedChain(root);
    expect(await verifyCommand(["--replay"], root)).toBe(0);
  });

  // Not a silent pass: a run over an empty chain proves nothing, and a gate that is
  // quiet when it checked nothing cannot be told from one that passed.
  test("no committed migrations reports that, and passes", async () => {
    const root = await project();
    expect(await verifyCommand(["--replay"], root)).toBe(0);
  });

  // `migrate.dialect` genuinely defaults to undefined, so this refusal is reachable
  // rather than dead code — with no --db there is no URL to infer from, and guessing
  // would replay a postgres chain through sqlite.
  test("no dialect anywhere is refused, operationally", async () => {
    const root = await project();
    await withApplyingChain(root);
    await writeFile(
      join(root, ".metaobjects", "config.json"),
      JSON.stringify({ schema_version: 1, migrate: { outDir: MIGRATIONS } }),
      "utf8",
    );
    expect(await verifyCommand(["--replay", "--skip-schema"], root)).toBe(2);
    // The control: naming the dialect on the command line makes the same run pass.
    expect(await verifyCommand(["--replay", "--dialect", "sqlite", "--skip-schema"], root)).toBe(0);
  });

  // `--skip-schema` is load-bearing here, not incidental: without it the D1 SCHEMA
  // gate also returns 2 (no wrangler.toml), so the assertion would pass whether or
  // not the replay gate refuses at all.
  test("d1 is refused, operationally", async () => {
    const root = await project();
    await withApplyingChain(root);
    expect(await verifyCommand(["--replay", "--dialect", "d1", "--skip-schema"], root)).toBe(2);
    // The control: the same run on the project's real dialect passes, so the 2 above
    // is the d1 refusal and not something wrong with the fixture.
    expect(await verifyCommand(["--replay", "--skip-schema"], root)).toBe(0);
  });
});

describe("verify --replay-snapshot runs BOTH tiers", () => {
  // The regression that would let the flag ship dead: --replay-snapshot implies
  // --replay's work, so a broken chain must fail under it even though --replay was
  // never passed.
  test("a broken chain fails under --replay-snapshot alone", async () => {
    const root = await project();
    await withBrokenChain(root);
    expect(await verifyCommand(["--replay-snapshot"], root)).toBe(1);
  });

  test("a generated chain reproduces its own committed snapshot", async () => {
    const root = await project();
    await withGeneratedChain(root);
    expect(await verifyCommand(["--replay-snapshot"], root)).toBe(0);
  });

  // Tier 2's whole reason for existing, and what keeps the case above honest: a chain
  // that APPLIES but no longer produces the schema the snapshot records. This is the
  // hand-edited-structural-DDL case — tier 1 cannot see it.
  test("a chain that applies but diverges from the snapshot fails", async () => {
    const root = await project();
    await withGeneratedChain(root);
    expect(await verifyCommand(["--replay"], root)).toBe(0);      // tier 1 is blind to it
    const extra = join(root, ".metaobjects", "migrations", "29991231000000-hand-edit");
    await mkdir(extra, { recursive: true });
    await writeFile(join(extra, "up.sql"), 'CREATE TABLE "unrecorded" (id INTEGER NOT NULL PRIMARY KEY);', "utf8");
    await writeFile(join(extra, "down.sql"), 'DROP TABLE "unrecorded";', "utf8");
    expect(await verifyCommand(["--replay"], root)).toBe(0);      // still applies fine
    expect(await verifyCommand(["--replay-snapshot"], root)).toBe(1);
  });

  // Fails OPEN: a project that has never generated a snapshot offline is not in an
  // error state — but the tier says so rather than passing in silence.
  test("no committed snapshot is not a failure", async () => {
    const root = await project();
    // A chain that APPLIES, so tier 1 passes and this isolates the snapshot half.
    await withApplyingChain(root);
    expect(await verifyCommand(["--replay-snapshot"], root)).toBe(0);
  });

  // F6 — the empty-chain early return in runReplayVerify fired unconditionally,
  // before runReplaySnapshotTier ever ran — so `--replay-snapshot` against an
  // EMPTY chain reported success having compared NOTHING, even when a real
  // committed snapshot on disk records tables the (empty) replay could never
  // produce. Reproduces both hazards the surrounding comment names: a
  // `migrate.outDir` that no longer points at the real chain, and a project
  // adopted via `migrate baseline --from-db` (whose own chain is empty by
  // construction). Tier 1 (`--replay`) is right to pass here — an empty chain
  // trivially "applies" — but tier 2 owes a real answer, and that answer must be
  // "does not reproduce the snapshot", not silence mistaken for a pass.
  test("an empty chain with a real committed snapshot fails under --replay-snapshot", async () => {
    const root = await project();
    await withGeneratedChain(root); // writes a chain AND a snapshot recording "jobs"

    // Empty the chain while leaving the committed snapshot (a sibling file, not
    // inside any migration folder) untouched — the exact shape of a stale
    // `migrate.outDir` or a baseline-from-db adoption.
    const migrationsDir = join(root, ".metaobjects", "migrations");
    for (const entry of await readdir(migrationsDir)) {
      if ((await stat(join(migrationsDir, entry))).isDirectory()) {
        await rm(join(migrationsDir, entry), { recursive: true, force: true });
      }
    }

    expect(await verifyCommand(["--replay"], root)).toBe(0); // tier 1: trivially applies
    expect(await verifyCommand(["--replay-snapshot"], root)).toBe(1); // tier 2: must not pass vacuously
  });
});
