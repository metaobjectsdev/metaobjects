// rc.19 fix round 2: two references from the base onto the SAME target entity are two joins with
// two aliases, and each origin reads from the join its own @via names. The alias used to be looked
// up by target entity, so both passthroughs selected from the first join's alias and the second
// column silently read the wrong row (`u.name AS approver_name` while `approver` joined as `u0`).

import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildProjectionViews } from "../../src/projection/build-projection-views.js";

// The shared loader fixture every port loads; this test is its view-SQL half (meta migrate is TS).
const FIXTURE = join(import.meta.dir, "../../../../../../fixtures/conformance/origin-passthrough-two-references-one-target/input/meta.json");


async function view(dialect: "postgres" | "sqlite") {
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(readFileSync(FIXTURE, "utf8"))]);
  expect(errors).toEqual([]);
  const [v] = buildProjectionViews(root, { dialect });
  return v!;
}

type Row = { id: number; owner_name: string | null; approver_name: string | null };

function run(sql: string): Row[] {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE accounts (id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL, approver_id INTEGER);
    INSERT INTO users VALUES (1, 'ann'), (2, 'bob');
    INSERT INTO accounts VALUES (10, 1, 2), (11, 2, NULL);
  `);
  db.exec(`CREATE VIEW v_accounts AS ${sql}`);
  return db.query("SELECT id, owner_name, approver_name FROM v_accounts ORDER BY id").all() as Row[];
}

describe("two references onto one target entity", () => {
  test("each reference is its own join with its own alias", async () => {
    const sql = (await view("postgres")).sql;
    expect(sql).toContain("LEFT OUTER JOIN public.users u ON u.id = a.owner_id");
    expect(sql).toContain("LEFT OUTER JOIN public.users u0 ON u0.id = a.approver_id");
    expect(sql).toContain("u.name AS owner_name");
    expect(sql).toContain("u0.name AS approver_name");
  });

  test("each column reads the row its own reference names", async () => {
    expect(run((await view("sqlite")).sql)).toEqual([
      { id: 10, owner_name: "ann", approver_name: "bob" },
      { id: 11, owner_name: "bob", approver_name: null },
    ]);
  });
});
