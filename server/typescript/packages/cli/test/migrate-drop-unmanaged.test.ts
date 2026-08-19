/**
 * `--allow drop-unmanaged` — refuse to AUTHOR a drop for an object the committed
 * snapshot never contained (#313).
 *
 * The live migrate path diffs metadata against introspection and never reads the
 * snapshot, so a table another tool owns reads as "in the DB, not in the model" and
 * is proposed for a drop. The migration that results cannot replay against a database
 * where that object never existed — which is how the reported chain stayed broken for
 * three months. `classify.ts` already stated the doctrine; this is where it is
 * enforced.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { migrateCommand } from "../src/commands/migrate.js";
import { buildKyselyFromUrl } from "../src/lib/kysely.js";
import { ALLOW_TOKENS } from "../src/lib/args.js";
import { ALLOW_TOKEN_MAP, tokensToAllowOptions } from "../src/lib/allow.js";
import { snapshotPath, writeSnapshot, type TableDescriptor } from "@metaobjectsdev/migrate-ts";

const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

const MODEL = JSON.stringify({
  "metadata.root": {
    package: "acme::platform",
    children: [{
      "object.entity": {
        name: "Job",
        children: [
          { "source.rdb": { name: "src", "@table": "jobs" } },
          { "field.long": { name: "id" } },
          { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
        ],
      },
    }],
  },
});

interface Fixture { root: string; db: string }

/**
 * A project modelling only `jobs`, against a database that ALSO holds `theirs` —
 * another tool's table. `seedSnapshot` decides the case: `managed` writes a snapshot
 * containing both (what `baseline --from-db` produces), `unmanaged` writes one
 * containing only `jobs`, and `none` writes no snapshot at all.
 */
async function fixture(seedSnapshot: "managed" | "unmanaged" | "none"): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "drop-unmanaged-"));
  dirs.push(root);
  await mkdir(join(root, "metaobjects"), { recursive: true });
  await writeFile(join(root, "metaobjects", "meta.platform.json"), MODEL, "utf8");
  await mkdir(join(root, ".metaobjects", "migrations"), { recursive: true });
  await writeFile(
    join(root, ".metaobjects", "config.json"),
    JSON.stringify({ schema_version: 1, migrate: { dialect: "sqlite" } }),
    "utf8",
  );

  const db = join(root, "t.db");
  const k = await buildKyselyFromUrl(`file:${db}`, "sqlite");
  try {
    await sql`CREATE TABLE "jobs" (id INTEGER NOT NULL PRIMARY KEY)`.execute(k.db);
    await sql`CREATE TABLE "theirs" (id INTEGER NOT NULL PRIMARY KEY)`.execute(k.db);
  } finally {
    await k.close();
  }

  if (seedSnapshot !== "none") {
    // Written through migrate's own writer, not hand-rolled JSON: the on-disk shape
    // is versioned and nested, and a fixture that guessed it would be testing the
    // guard's error path instead of the guard.
    const t = (name: string): TableDescriptor => ({
      name,
      columns: [{ name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false }],
      indexes: [], foreignKeys: [], checks: [], primaryKey: ["id"],
    });
    await writeSnapshot(snapshotPath(join(root, ".metaobjects", "migrations"), "sqlite"), {
      tables: seedSnapshot === "managed" ? [t("jobs"), t("theirs")] : [t("jobs")],
      views: [],
    });
  }
  return { root, db };
}

const migrationCount = async (root: string): Promise<number> =>
  (await readdir(join(root, ".metaobjects", "migrations")))
    .filter((e) => !e.startsWith(".")).length;

/**
 * `--from-db` is required, not incidental: a bare `meta migrate --db <url>` takes the
 * OFFLINE path, which diffs metadata against the committed snapshot. There, a drop is
 * proposed only for an object the snapshot HAS — so the offline path cannot produce a
 * snapshot-absent drop by construction, and the guard belongs to the live path alone.
 */
const run = (f: Fixture, extra: string[] = []): Promise<number> =>
  migrateCommand(
    ["--from-db", "--db", `file:${f.db}`, "--dialect", "sqlite", "--slug", "x",
     "--allow", ["drop-table", ...extra].join(",")],
    f.root,
  );

describe("drop-unmanaged is wired through every token structure", () => {
  test("is a recognised allow token", () => {
    expect(ALLOW_TOKENS).toContain("drop-unmanaged");
  });

  // A token in ALLOW_TOKENS but absent from the map validates cleanly and then grants
  // NOTHING — the silent-failure mode allow-tokens-pinned.test.ts exists to prevent.
  test("grants a permission rather than validating into nothing", () => {
    expect(ALLOW_TOKEN_MAP["drop-unmanaged"]).toBe("dropUnmanaged");
    expect(tokensToAllowOptions(["drop-unmanaged"]).dropUnmanaged).toBe(true);
  });
});

describe("meta migrate refuses a snapshot-absent drop", () => {
  test("refuses, and writes nothing", async () => {
    const f = await fixture("unmanaged");
    expect(await run(f)).toBe(2);
    expect(await migrationCount(f.root)).toBe(0);
  });

  test("--allow drop-unmanaged lets it through", async () => {
    const f = await fixture("unmanaged");
    expect(await run(f, ["drop-unmanaged"])).toBe(0);
    expect(await migrationCount(f.root)).toBe(1);
  });

  // The brownfield non-false-fire, and the reason the guard is safe to ship on by
  // default: `baseline --from-db` puts the foreign table IN the snapshot, so the
  // guard reads it as managed. Without this case the guard would look correct while
  // breaking every adopted project.
  test("a drop for a table the snapshot DOES contain proceeds without the flag", async () => {
    const f = await fixture("managed");
    expect(await run(f)).toBe(0);
    expect(await migrationCount(f.root)).toBe(1);
  });

  // Fails OPEN: refusing here would break the first `meta migrate` of every
  // greenfield project, which has no snapshot yet by definition.
  test("no snapshot on disk does not trigger the refusal", async () => {
    const f = await fixture("none");
    expect(await run(f)).toBe(0);
  });
});
