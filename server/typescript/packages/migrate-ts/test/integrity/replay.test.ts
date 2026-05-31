// test/integrity/replay.test.ts
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely } from "kysely";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import type { SchemaSnapshot } from "../../src/types.js";
import { verifyReplay } from "../../src/verify/replay.js";

const tmps: string[] = [];
async function tmpRoot(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "replay-"));
  tmps.push(d);
  return d;
}
async function writeMigration(root: string, name: string, up: string): Promise<void> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "up.sql"), up, "utf8");
  await writeFile(join(dir, "down.sql"), "-- n/a", "utf8");
}
function db(file: string): Kysely<Record<string, unknown>> {
  return new Kysely({ dialect: new LibsqlDialect({ url: `file:${file}` }) });
}

afterAll(async () => { for (const d of tmps) await rm(d, { recursive: true, force: true }); });

// The snapshot the migrations are SUPPOSED to produce.
const ordersSnapshot = (withRef: boolean): SchemaSnapshot => ({
  tables: [{
    name: "orders",
    columns: [
      { name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false },
      ...(withRef ? [{ name: "ref", sqlType: { kind: "text" as const }, nullable: false }] : []),
    ],
    indexes: [], foreignKeys: [], checks: [], primaryKey: ["id"],
  }],
  views: [],
});

describe("verifyReplay", () => {
  test("replayed schema matching the snapshot → no drift", async () => {
    const root = await tmpRoot();
    await writeMigration(root, "20260101000000-init",
      `CREATE TABLE orders ( id INTEGER NOT NULL PRIMARY KEY, ref TEXT NOT NULL );`);
    const k = db(join(root, "rep1.db"));
    try {
      const r = await verifyReplay({ db: k, dialect: "sqlite", migrationsDir: root, snapshot: ordersSnapshot(true) });
      expect(r.ok).toBe(true);
      expect(r.drift).toEqual([]);
    } finally { await k.destroy(); }
  });

  test("snapshot missing a column the migrations create → drift detected", async () => {
    const root = await tmpRoot();
    await writeMigration(root, "20260101000000-init",
      `CREATE TABLE orders ( id INTEGER NOT NULL PRIMARY KEY, ref TEXT NOT NULL );`);
    const k = db(join(root, "rep2.db"));
    try {
      // snapshot lacks `ref` → the replayed DB has it → diff sees an unmanaged column,
      // but the SNAPSHOT-as-expected is missing nothing the DB lacks; the divergence is
      // a column in the DB the snapshot doesn't model → classified as drift-or-unmanaged.
      const r = await verifyReplay({ db: k, dialect: "sqlite", migrationsDir: root, snapshot: ordersSnapshot(false) });
      expect(r.ok).toBe(false);
    } finally { await k.destroy(); }
  });
});
