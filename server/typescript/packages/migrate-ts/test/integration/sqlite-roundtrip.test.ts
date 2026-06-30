/**
 * SQLite round-trip integration test — trainer-website fixture (load-bearing).
 *
 * Per spec §8.3 / §9 #4. Mirrors Tasks 27–28 for SQLite via libsql tmp
 * file (mkdtemp + rm pattern — :memory: would lose connection state if
 * recreate-and-copy ran). Two scenarios: initial create from empty, and
 * add-field on an already-applied schema. Recreate-and-copy data
 * preservation tested separately in Task 30.
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely, sql } from "kysely";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { introspectSqlite } from "../../src/introspect/sqlite.js";
import { diff } from "../../src/diff/index.js";
import { emit } from "../../src/emit/index.js";

let tmpDir: string;
let k: Kysely<Record<string, unknown>>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "migrate-ts-roundtrip-sqlite-"));
  const url = `file:${join(tmpDir, "test.db")}`;
  k = new Kysely({ dialect: new LibsqlDialect({ url }) });
});

afterEach(async () => {
  await k.destroy();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function loadFixture(name: string) {
  const json = readFileSync(
    join(import.meta.dir, "..", "fixtures", `${name}.json`),
    "utf8",
  );
  return (await new MetaDataLoader().load([new InMemoryStringSource(json)])).root;
}

/**
 * Execute a multi-statement SQL string against SQLite via libsql.
 *
 * libsql's execute() is single-statement-only — multi-statement strings
 * silently stop after the first statement. Always split on ";" and execute
 * each statement individually. This works for both plain DDL and
 * recreate-and-copy blocks (PRAGMA / BEGIN TRANSACTION / DDL / COMMIT).
 */
async function applyRaw(kysely: Kysely<Record<string, unknown>>, sqlText: string): Promise<void> {
  for (const stmt of sqlText.trim().split(";").map((s) => s.trim()).filter((s) => s.length > 0)) {
    await sql.raw(stmt).execute(kysely);
  }
}

describe("SQLite round-trip — trainer-website fixture", () => {
  test("create from empty: apply → re-diff yields no changes", async () => {
    const metadata = await loadFixture("trainer-website-entities");
    // dialect:"sqlite" normalizes SqlTypes to what SQLite introspection sees
    // (boolean→integer, timestamp/date/time→text, etc.). Required since ADR-0036
    // Wave 2 made field.timestamp tz-aware by default: SQLite has no tz concept,
    // so without this the expected `timestamp{withTimezone:true}` could never
    // equal the introspected `timestamp{withTimezone:false}`.
    const expected = buildExpectedSchema(metadata, { dialect: "sqlite" });
    const actual0 = await introspectSqlite(k);
    const initial = await diff(expected, actual0);
    expect(initial.blocked).toEqual([]);

    const { up } = emit(initial.changes, {
      dialect: "sqlite",
      expectedSchema: expected,
      ...(actual0.meta !== undefined && { actualMeta: actual0.meta }),
    });
    await applyRaw(k, up);

    const actual1 = await introspectSqlite(k);
    const followup = await diff(expected, actual1);
    if (followup.changes.length > 0) {
      console.error("ROUND-TRIP FAILURE — remaining changes:");
      for (const c of followup.changes) console.error(`  - ${c.kind}:`, JSON.stringify(c, null, 2));
    }
    expect(followup.changes).toEqual([]);
  });

  test("add a field → migration applies → re-diff yields no changes", async () => {
    const metadata1 = await loadFixture("trainer-website-entities");
    const expected1 = buildExpectedSchema(metadata1, { dialect: "sqlite" });
    {
      const initial = await diff(expected1, await introspectSqlite(k));
      const { up } = emit(initial.changes, { dialect: "sqlite", expectedSchema: expected1 });
      await applyRaw(k, up);
    }

    // Mutation: parse the fixture JSON and append a `phone` field to Subscriber.
    const json = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "fixtures", "trainer-website-entities.json"), "utf8"),
    );
    const subscriber = json["metadata.root"].children.find(
      (c: { "object.entity"?: { name: string } }) => c["object.entity"]?.name === "Subscriber",
    )["object.entity"];
    subscriber.children.push({ "field.string": { name: "phone" } });
    const metadata2 = (await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(json))])).root;
    const expected2 = buildExpectedSchema(metadata2, { dialect: "sqlite" });

    const second = await diff(expected2, await introspectSqlite(k));
    expect(second.blocked).toEqual([]);
    const { up: up2 } = emit(second.changes, { dialect: "sqlite", expectedSchema: expected2 });
    await applyRaw(k, up2);

    const followup = await diff(expected2, await introspectSqlite(k));
    if (followup.changes.length > 0) {
      console.error("ROUND-TRIP FAILURE (add-column) — remaining changes:");
      for (const c of followup.changes) console.error(`  - ${c.kind}:`, JSON.stringify(c, null, 2));
    }
    expect(followup.changes).toEqual([]);
  });
});
