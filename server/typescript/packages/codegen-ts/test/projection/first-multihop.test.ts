// Phase 5, bug first-multihop: an origin.first whose @via walks more than one hop must lower
// along that path. Codegen never read origin.first's @via: it correlated the base directly to
// the @of entity, and with no direct reference it dropped the column from the view, silently.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildProjectionViews } from "../../src/projection/build-projection-views.js";

const MODEL = {
  "metadata.root": {
    package: "acme",
    children: [
      { "object.entity": { name: "Player", children: [
        { "source.rdb": { "@table": "players" } },
        { "field.long": { name: "id" } },
        { "identity.primary": { name: "id", "@fields": "id" } },
      ] } },
      { "object.entity": { name: "Camp", children: [
        { "source.rdb": { "@table": "camps" } },
        { "field.long": { name: "id" } },
        { "field.long": { name: "playerId" } },
        { "field.long": { name: "seasonId" } },
        { "field.boolean": { name: "active" } },
        { "identity.primary": { name: "id", "@fields": "id" } },
        { "identity.reference": { name: "player", "@fields": "playerId", "@references": "Player" } },
      ] } },
      { "object.entity": { name: "Coach", children: [
        { "source.rdb": { "@table": "coaches" } },
        { "field.long": { name: "id" } },
        { "field.long": { name: "playerId" } },
        { "identity.primary": { name: "id", "@fields": "id" } },
        { "identity.reference": { name: "player", "@fields": "playerId", "@references": "Player" } },
      ] } },
      { "object.projection": { name: "CoachExtract", children: [
        { "source.rdb": { "@kind": "view", "@table": "v_coach_extract" } },
        { "field.long": { name: "id", extends: "Coach.id" } },
        { "field.long": { name: "seasonId", children: [{ "origin.first": {
          "@of": "Camp.seasonId", "@via": "Coach.player.camps", "@orderBy": ["id:desc"], "@filter": { active: true },
        } }] } },
        { "identity.primary": { name: "id", extends: "Coach.id" } },
      ] } },
    ],
  },
};

describe("first-multihop — origin.first follows a multi-hop @via", () => {
  test("the column is a subquery along the path, correlated on its first hop", async () => {
    const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(MODEL))]);
    expect(errors).toEqual([]);
    const [v] = buildProjectionViews(root, { dialect: "postgres" });
    expect(v!.sql).toMatch(
      /\(SELECT (\w+)\.season_id FROM public\.players (\w+) INNER JOIN public\.camps \1 ON \1\.player_id = \2\.id WHERE \2\.id = c\.player_id AND \1\.active = TRUE ORDER BY \1\.id DESC NULLS LAST, \1\.id ASC LIMIT 1\) AS season_id/,
    );
    expect([...v!.dependsOn].sort()).toEqual(["camps", "coaches", "players"]);
  });
});
