// Every generated view join is LEFT OUTER. An INNER join silently dropped a base row whose reference
// named no row - possible for an `@enforce: false` reference, and for a TPH-subtype target whose
// discriminator the join carries. "Require a related row" is written explicitly, as a projection
// @filter on the related key: `{ "<hop>.id": { isNull: false } }`.

import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildProjectionViews } from "../../src/projection/build-projection-views.js";

const model = (filter: unknown) => ({ "metadata.root": { package: "acme", children: [
  { "object.entity": { name: "User", children: [
    { "source.rdb": { "@table": "users" } },
    { "field.long": { name: "id" } },
    { "field.string": { name: "name", "@required": true } },
    { "identity.primary": { name: "id", "@fields": "id" } },
  ] } },
  { "object.entity": { name: "Member", children: [
    { "source.rdb": { "@table": "members" } },
    { "field.long": { name: "id" } },
    { "field.string": { name: "name", "@required": true } },
    { "identity.primary": { name: "id", "@fields": "id" } },
  ] } },
  { "object.entity": { name: "Account", children: [
    { "source.rdb": { "@table": "accounts" } },
    { "field.long": { name: "id" } },
    { "field.long": { name: "ownerId", "@required": true } },
    { "field.long": { name: "refId", "@required": true } },
    { "identity.primary": { name: "id", "@fields": "id" } },
    { "identity.reference": { name: "owner", "@fields": "ownerId", "@references": "User" } },
    // A legacy column that holds either a member id or a group id: not a real foreign key.
    { "identity.reference": { name: "ref", "@fields": "refId", "@references": "Member", "@enforce": false } },
  ] } },
  { "object.projection": { name: "AccountView", ...(filter !== undefined ? { "@filter": filter } : {}), children: [
    { "source.rdb": { "@kind": "view", "@view": "v_accounts" } },
    { "field.long": { name: "id", extends: "Account.id" } },
    { "field.string": { name: "ownerName", children: [{ "origin.passthrough": { "@from": "User.name", "@via": "Account.owner" } }] } },
    { "field.string": { name: "refName", children: [{ "origin.passthrough": { "@from": "Member.name", "@via": "Account.ref" } }] } },
    { "identity.primary": { name: "id", extends: "Account.id" } },
  ] } },
] } });

async function views(filter: unknown, dialect: "postgres" | "sqlite") {
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(model(filter)))]);
  expect(errors).toEqual([]);
  return buildProjectionViews(root, { dialect });
}

function run(sql: string): { id: number; ref_name: string | null }[] {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE members (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO members VALUES (2, 'bob');
    CREATE TABLE accounts (id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL, ref_id INTEGER NOT NULL);
    INSERT INTO users VALUES (1, 'ann'), (2, 'bob');
    -- account 11's ref_id names a group, not a user
    INSERT INTO accounts VALUES (10, 1, 2), (11, 2, 999);
  `);
  db.exec(`CREATE VIEW v_accounts AS ${sql}`);
  return db.query("SELECT id, ref_name FROM v_accounts ORDER BY id").all() as { id: number; ref_name: string | null }[];
}

describe("generated view joins are LEFT OUTER", () => {
  test("a required, enforced hop and an unenforced one are both LEFT OUTER", async () => {
    const [v] = await views(undefined, "postgres");
    expect(v!.sql).not.toContain("INNER JOIN");
    expect(v!.sql.match(/LEFT OUTER JOIN/g)?.length).toBe(2);
  });

  test("an unmatched reference keeps its base row, null-extended", async () => {
    const [v] = await views(undefined, "sqlite");
    expect(run(v!.sql)).toEqual([{ id: 10, ref_name: "bob" }, { id: 11, ref_name: null }]);
  });

  test("an explicit isNull: false filter on the related key drops the unmatched rows", async () => {
    const [v] = await views({ "ref.id": { isNull: false } }, "sqlite");
    expect(run(v!.sql)).toEqual([{ id: 10, ref_name: "bob" }]);
  });
});
