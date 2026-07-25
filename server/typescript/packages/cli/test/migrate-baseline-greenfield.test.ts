/**
 * Launch-blocker B1: the `meta migrate baseline` greenfield trap.
 *
 * Offline `baseline` (from metadata, no --from-db) records the entity's DESIRED
 * schema as the already-applied baseline. On a brand-new / empty database this is
 * exactly wrong: no CREATE TABLE is ever emitted, every later `migrate` reports
 * "no changes", and the generated server 500s "no such table" — while the tool
 * reported success at every step.
 *
 * These tests pin the source fix: when an offline baseline can see that its target
 * --db has no tables, it must REFUSE and point at the working greenfield path
 * (`--from-db … --apply`); when it can't see a DB at all, it must still work but
 * WARN that it emits no CREATE TABLE and name the greenfield path.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotPath } from "@metaobjectsdev/migrate-ts";
import { runBaseline } from "../src/commands/migrate.js";

const dirs: string[] = [];

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mts-greenfield-"));
  dirs.push(root);
  await mkdir(join(root, "metaobjects"), { recursive: true });
  await writeFile(
    join(root, "metaobjects", "meta.orders.json"),
    JSON.stringify({
      "metadata.root": {
        children: [
          {
            "object.entity": {
              name: "Order",
              children: [
                { "field.long": { name: "id" } },
                { "field.string": { name: "ref" } },
                { "source.rdb": { name: "src", "@table": "orders" } },
                { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
              ],
            },
          },
        ],
      },
    }),
    "utf8",
  );
  return root;
}

afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function captureStderr(
  fn: () => Promise<number>,
): Promise<{ code: number; stderr: string }> {
  const captured: string[] = [];
  const origErr = console.error;
  console.error = (...a: unknown[]) => {
    captured.push(a.map(String).join(" "));
  };
  let code: number;
  try {
    code = await fn();
  } finally {
    console.error = origErr;
  }
  return { code, stderr: captured.join("\n") };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe("runBaseline greenfield trap guard", () => {
  test("refuses an offline baseline when the target --db has no tables, and writes no snapshot", async () => {
    const root = await project();
    // A fresh file: sqlite URL — the DB does not exist yet, so it has no tables.
    const dbUrl = `file:${join(root, "dev.sqlite")}`;
    const { code, stderr } = await captureStderr(() =>
      runBaseline(
        { dialect: "sqlite", outDir: "./.metaobjects/migrations", fromDb: false, databaseUrl: dbUrl } as never,
        root,
      ),
    );

    // Must refuse — not silently seed the trap snapshot.
    expect(code).not.toBe(0);
    // No snapshot must have been written.
    const snap = snapshotPath(join(root, ".metaobjects/migrations"), "sqlite");
    expect(await fileExists(snap)).toBe(false);
    // Guidance must point at the working greenfield path, not at itself.
    expect(stderr).toContain("--from-db");
    expect(stderr).toContain("--apply");
  });

  test("offline baseline with no --db still writes the snapshot but warns it emits no CREATE TABLE", async () => {
    const root = await project();
    const { code, stderr } = await captureStderr(() =>
      runBaseline(
        { dialect: "sqlite", outDir: "./.metaobjects/migrations", fromDb: false } as never,
        root,
      ),
    );

    // Legit offline case (adopting a DB that already matches metadata) still works.
    expect(code).toBe(0);
    const snap = snapshotPath(join(root, ".metaobjects/migrations"), "sqlite");
    expect(await fileExists(snap)).toBe(true);
    // But it must educate: name the greenfield path so a trapped newcomer recovers.
    expect(stderr.toLowerCase()).toContain("--from-db");
  });

  test("offline baseline against a --db that ALREADY has tables proceeds (adopting an existing DB)", async () => {
    const root = await project();
    // Seed a real table into the sqlite DB so it is non-empty.
    const { buildKyselyFromUrl } = await import("../src/lib/kysely.js");
    const dbUrl = `file:${join(root, "existing.sqlite")}`;
    const k = await buildKyselyFromUrl(dbUrl, "sqlite");
    await k.db.schema
      .createTable("orders")
      .addColumn("id", "integer", (c) => c.primaryKey())
      .addColumn("ref", "text")
      .execute();
    await k.close();

    const { code, stderr } = await captureStderr(() =>
      runBaseline(
        { dialect: "sqlite", outDir: "./.metaobjects/migrations", fromDb: false, databaseUrl: dbUrl } as never,
        root,
      ),
    );

    // A non-empty DB is not the trap — offline baseline is allowed to proceed.
    expect(code).toBe(0);
    const snap = snapshotPath(join(root, ".metaobjects/migrations"), "sqlite");
    expect(await fileExists(snap)).toBe(true);
    // But it still warns: an offline baseline emits no DDL, so every non-refused
    // path (non-empty --db here; also a --db it couldn't reach) must educate.
    expect(stderr.toLowerCase()).toContain("--from-db");
  });
});
