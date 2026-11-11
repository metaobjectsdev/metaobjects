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

// rc.20: the aggregate arms (any, whole-object collect, collect @of, the @of reduces) take the
// same alias rule. A Project's accounts each name an owner and an approver (two references onto
// User), so an aggregate over `Project.accounts.owner` and one over `Project.accounts.approver`
// reach User through two joins, and each must read its own.
const AGGREGATES = {
  "metadata.root": {
    package: "acme",
    children: [
      { "object.entity": { name: "User", children: [
        { "source.rdb": { "@table": "users" } },
        { "field.long": { name: "id" } },
        { "field.string": { name: "name", "@required": true } },
        { "identity.primary": { name: "id", "@fields": "id" } },
      ] } },
      { "object.entity": { name: "Project", children: [
        { "source.rdb": { "@table": "projects" } },
        { "field.long": { name: "id" } },
        { "identity.primary": { name: "id", "@fields": "id" } },
      ] } },
      { "object.entity": { name: "Account", children: [
        { "source.rdb": { "@table": "accounts" } },
        { "field.long": { name: "id" } },
        { "field.long": { name: "projectId", "@required": true } },
        { "field.long": { name: "ownerId", "@required": true } },
        { "field.long": { name: "approverId" } },
        { "identity.primary": { name: "id", "@fields": "id" } },
        { "identity.reference": { name: "project", "@fields": "projectId", "@references": "Project" } },
        { "identity.reference": { name: "owner", "@fields": "ownerId", "@references": "User" } },
        { "identity.reference": { name: "approver", "@fields": "approverId", "@references": "User" } },
      ] } },
      { "object.value": { name: "UserBrief", children: [{ "field.string": { name: "name" } }] } },
      { "object.projection": { name: "ProjectView", children: [
        { "source.rdb": { "@kind": "view", "@view": "v_projects" } },
        { "field.long": { name: "id", extends: "Project.id" } },
        ...(["owner", "approver"] as const).flatMap((ref) => {
          const via = `Project.accounts.${ref}`;
          const agg = (kind: string, name: string, origin: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
            ({ [kind]: { name, ...extra, children: [{ "origin.aggregate": { "@via": via, ...origin } }] } });
          return [
            agg("field.int", `${ref}Count`, { "@agg": "count", "@of": "User.id" }),
            agg("field.string", `${ref}Max`, { "@agg": "max", "@of": "User.name" }),
            agg("field.boolean", `${ref}IsAnn`, { "@agg": "any", "@filter": { name: "ann" } }),
            agg("field.string", `${ref}Names`, { "@agg": "collect", "@of": "User.name" }, { isArray: true }),
            agg("field.object", `${ref}Briefs`, { "@agg": "collect" }, { isArray: true, "@objectRef": "UserBrief" }),
          ];
        }),
        { "identity.primary": { name: "id", extends: "Project.id" } },
      ] } },
    ],
  },
};

async function aggregateView(dialect: "postgres" | "sqlite") {
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(AGGREGATES))]);
  expect(errors).toEqual([]);
  const [v] = buildProjectionViews(root, { dialect });
  return v!;
}

const COLUMNS = ["count", "max", "is_ann", "names", "briefs"] as const;

describe("two references onto one target entity — aggregates", () => {
  test("each aggregate reads the join its own @via names", async () => {
    const sql = (await aggregateView("postgres")).sql;
    const owner = /JOIN public\.users (\w+) ON \1\.id = \w+\.owner_id/.exec(sql)?.[1];
    const approver = /JOIN public\.users (\w+) ON \1\.id = \w+\.approver_id/.exec(sql)?.[1];
    expect(owner).toBeDefined();
    expect(approver).toBeDefined();
    expect(owner).not.toBe(approver);
    for (const col of COLUMNS) {
      const ownerExpr = new RegExp(`([^\\n]*) AS owner_${col}\\b`).exec(sql)?.[1] ?? "";
      const approverExpr = new RegExp(`([^\\n]*) AS approver_${col}\\b`).exec(sql)?.[1] ?? "";
      expect(ownerExpr).toMatch(new RegExp(`\\b${owner}\\.`));
      expect(ownerExpr).not.toMatch(new RegExp(`\\b${approver}\\.`));
      expect(approverExpr).toMatch(new RegExp(`\\b${approver}\\.`));
      expect(approverExpr).not.toMatch(new RegExp(`\\b${owner}\\.`));
    }
  });

  test("each aggregate reads the rows its own reference names", async () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE projects (id INTEGER PRIMARY KEY);
      CREATE TABLE accounts (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, owner_id INTEGER NOT NULL, approver_id INTEGER);
      INSERT INTO users VALUES (1, 'ann'), (2, 'bob');
      INSERT INTO projects VALUES (100), (101);
      INSERT INTO accounts VALUES (10, 100, 1, 2), (11, 101, 2, NULL);
    `);
    db.exec(`CREATE VIEW v_projects AS ${(await aggregateView("sqlite")).sql}`);
    const rows = db.query(
      "SELECT id, owner_count, approver_count, owner_max, approver_max, owner_is_ann, approver_is_ann, owner_names, approver_names, owner_briefs, approver_briefs FROM v_projects ORDER BY id",
    ).all() as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ id: 100, owner_count: 1, approver_count: 1, owner_max: "ann", approver_max: "bob", owner_is_ann: 1, approver_is_ann: 0 });
    expect(rows[1]).toMatchObject({ id: 101, owner_count: 1, approver_count: 0, owner_max: "bob", approver_max: null, owner_is_ann: 0 });
    for (const [col, has, lacks] of [["owner_names", "ann", "bob"], ["approver_names", "bob", "ann"], ["owner_briefs", "ann", "bob"], ["approver_briefs", "bob", "ann"]] as const) {
      expect(String(rows[0]![col])).toContain(has);
      expect(String(rows[0]![col])).not.toContain(lacks);
    }
  });
});
