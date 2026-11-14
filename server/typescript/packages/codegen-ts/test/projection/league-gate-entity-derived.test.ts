// rc.19 Phase 6 — the league-gate shape end to end: a segment.filter on Contract that uses `now`
// (rc.19 `now`), a derived boolean declared ONCE on Player as origin.first over that segment
// (origin-segment) along the reverse of Contract.playerId (R-walk), and other projections that
// filter on it without outputting it — through a to-one path (entity-derived + G7 joined) or on
// their base. The SQL is built, then run on SQLite against rows that exercise the reset point.

import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildProjectionViews } from "../../src/projection/build-projection-views.js";

const MODEL = {
  "metadata.root": {
    package: "acme",
    children: [
      { "object.entity": { name: "Player", children: [
        { "source.rdb": { "@table": "players" } },
        { "field.long": { name: "id" } },
        { "field.boolean": { name: "hasActiveLeagueContract", children: [
          { "origin.first": {
            "@via": "Player.contracts", "@of": "Contract.contractIsOnFile",
            "@orderBy": ["id:desc"], "@segment": "leagueDecisive",
          } },
        ] } },
        { "identity.primary": { name: "id", "@fields": "id" } },
      ] } },
      { "object.entity": { name: "Contract", children: [
        { "source.rdb": { "@table": "contracts" } },
        { "field.long": { name: "id" } },
        { "field.long": { name: "playerId", "@required": true } },
        { "field.int": { name: "contractTypeId" } },
        { "field.boolean": { name: "contractIsOnFile" } },
        { "field.boolean": { name: "playerContract" } },
        { "field.date": { name: "dateReceived" } },
        { "field.date": { name: "effectiveEndDate" } },
        { "identity.primary": { name: "id", "@fields": "id" } },
        { "identity.reference": { name: "playerId", "@fields": "playerId", "@references": "Player" } },
        { "segment.filter": { name: "leagueDecisive", "@filter": {
          contractTypeId: 1,
          or: [
            { contractIsOnFile: false },
            { and: [
              { contractIsOnFile: true },
              { or: [{ playerContract: null }, { playerContract: true }] },
              { dateReceived: { lte: { now: "P0D" } } },
              { or: [{ effectiveEndDate: null }, { effectiveEndDate: { gte: { now: "P0D" } } }] },
            ] },
          ],
        } } },
      ] } },
      { "object.entity": { name: "Camp", children: [
        { "source.rdb": { "@table": "camps" } },
        { "field.long": { name: "id" } },
        { "field.long": { name: "playerId", "@required": true } },
        { "identity.primary": { name: "id", "@fields": "id" } },
        { "identity.reference": { name: "playerId", "@fields": "playerId", "@references": "Player" } },
      ] } },
      { "object.entity": { name: "Authorization", children: [
        { "source.rdb": { "@table": "authorizations" } },
        { "field.long": { name: "id" } },
        { "field.long": { name: "campId", "@required": true } },
        { "field.string": { name: "code" } },
        { "identity.primary": { name: "id", "@fields": "id" } },
        { "identity.reference": { name: "campId", "@fields": "campId", "@references": "Camp" } },
      ] } },
      { "object.projection": { name: "AuthorizationExtract", "@filter": { "campId.playerId.hasActiveLeagueContract": true }, children: [
        { "source.rdb": { "@kind": "view", "@table": "v_authorization_extract" } },
        { "field.long": { name: "id", extends: "Authorization.id" } },
        { "field.string": { name: "code", extends: "Authorization.code" } },
        { "identity.primary": { name: "id", extends: "Authorization.id" } },
      ] } },
      { "object.projection": { name: "PlayerExtract", "@filter": { hasActiveLeagueContract: true }, children: [
        { "source.rdb": { "@kind": "view", "@table": "v_player_extract" } },
        { "field.long": { name: "id", extends: "Player.id" } },
        { "identity.primary": { name: "id", extends: "Player.id" } },
      ] } },
    ],
  },
};

async function load() {
  const result = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(MODEL))]);
  expect(result.errors).toEqual([]);
  return result.root;
}

describe("the league gate: an entity-derived boolean over a segment, used in other projections' @filter", () => {
  test("loads: Player needs no read source for a derived field projections reach", async () => {
    await load();
  });

  test("the path filter inlines the player's correlated subquery on the joined player", async () => {
    const views = buildProjectionViews(await load(), { dialect: "postgres" });
    const auth = views.find((v) => v.name === "v_authorization_extract")!;
    expect(auth.sql).toContain("LEFT OUTER JOIN public.camps c ON c.id = a.camp_id");
    expect(auth.sql).toContain("LEFT OUTER JOIN public.players p ON p.id = c.player_id");
    // The segment's predicate (with `now` of the date kind) scopes the subquery; it is ordered id:desc.
    expect(auth.sql).toMatch(/WHERE \(\(SELECT (\w+)\.contract_is_on_file FROM public\.contracts \1 WHERE \1\.player_id = p\.id AND \(\1\.contract_type_id = 1 AND/);
    expect(auth.sql).toContain(".date_received <= CAST(((now() AT TIME ZONE 'UTC') + INTERVAL 'P0D') AS DATE)");
    expect(auth.sql).toMatch(/ORDER BY \w+\.id DESC NULLS LAST, \w+\.id ASC LIMIT 1\)\) = TRUE/);
    expect(auth.sql).not.toContain("has_active_league_contract");
    expect(auth.dependsOn).toEqual(expect.arrayContaining(["authorizations", "camps", "players", "contracts"]));
  });

  test("on the base row, the same predicate filters the players", async () => {
    const views = buildProjectionViews(await load(), { dialect: "postgres" });
    const pat = views.find((v) => v.name === "v_player_extract")!;
    expect(pat.sql).toMatch(/WHERE \(\(SELECT \w+\.contract_is_on_file FROM public\.contracts \w+ WHERE \w+\.player_id = p\.id/);
  });

  test("runs: the latest decisive row decides, an opt-out resets, future and expired rows do not count", async () => {
    const views = buildProjectionViews(await load(), { dialect: "sqlite" });
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE players (id INTEGER PRIMARY KEY);
      CREATE TABLE contracts (id INTEGER PRIMARY KEY, player_id INTEGER, contract_type_id INTEGER, contract_is_on_file INTEGER,
        player_contract INTEGER, date_received TEXT, effective_end_date TEXT);
      CREATE TABLE camps (id INTEGER PRIMARY KEY, player_id INTEGER);
      CREATE TABLE authorizations (id INTEGER PRIMARY KEY, camp_id INTEGER, code TEXT);
    `);
    for (const v of views) db.exec(`CREATE VIEW ${v.name} AS ${v.sql}`);
    // 1: live contract. 2: contract, then an opt-out after it. 3: opt-out, then a contract after it.
    // 4: only a future-dated contract. 5: only an expired contract. 6: a live non-league contract.
    // 7: live contract with playerContract = false (refused).
    db.exec(`
      INSERT INTO players (id) VALUES (1), (2), (3), (4), (5), (6), (7);
      INSERT INTO contracts VALUES
        (10, 1, 1, 1, NULL, '2020-01-01', NULL),
        (20, 2, 1, 1, 1, '2020-01-01', NULL), (21, 2, 1, 0, NULL, NULL, NULL),
        (30, 3, 1, 0, NULL, NULL, NULL), (31, 3, 1, 1, 1, '2020-01-01', '2999-01-01'),
        (40, 4, 1, 1, 1, '2999-01-01', NULL),
        (50, 5, 1, 1, 1, '2020-01-01', '2020-06-01'),
        (60, 6, 2, 1, 1, '2020-01-01', NULL),
        (70, 7, 1, 1, 0, '2020-01-01', NULL);
      INSERT INTO camps (id, player_id) VALUES (100, 1), (200, 2), (300, 3), (400, 4), (500, 5), (600, 6), (700, 7);
      INSERT INTO authorizations (id, camp_id, code) VALUES (1000, 100, 'a'), (2000, 200, 'b'), (3000, 300, 'c'),
        (4000, 400, 'd'), (5000, 500, 'e'), (6000, 600, 'f'), (7000, 700, 'g');
    `);
    const ids = (sql: string) => (db.query(sql).all() as { id: number }[]).map((r) => r.id);
    expect(ids("SELECT id FROM v_player_extract ORDER BY id")).toEqual([1, 3]);
    expect(ids("SELECT id FROM v_authorization_extract ORDER BY id")).toEqual([1000, 3000]);
  });
});
