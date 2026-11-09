// Phase 5, bug multi-op: an origin @filter clause with several operators on one field
// (`{ ordinal: { gte: 1, lte: 5 } }`) keeps every one of them. resolveAggregateFilter kept only
// the first, so the aggregate silently spanned a wider row set than declared.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildProjectionViews } from "../../src/projection/build-projection-views.js";

const MODEL = {
  "metadata.root": { package: "acme", children: [
    { "object.entity": { name: "Program", children: [
      { "source.rdb": { "@table": "programs" } },
      { "field.long": { name: "id" } },
      { "identity.primary": { name: "id", "@fields": "id" } },
    ] } },
    { "object.entity": { name: "Week", children: [
      { "source.rdb": { "@table": "weeks" } },
      { "field.long": { name: "id" } },
      { "field.long": { name: "programId" } },
      { "field.int": { name: "ordinal" } },
      { "identity.primary": { name: "id", "@fields": "id" } },
      { "identity.reference": { name: "program", "@fields": "programId", "@references": "Program" } },
    ] } },
    { "object.projection": { name: "ProgramWeeks", children: [
      { "source.rdb": { "@kind": "view", "@table": "v_program_weeks" } },
      { "field.long": { name: "id", extends: "Program.id" } },
      { "field.int": { name: "early", children: [{ "origin.aggregate": {
        "@agg": "count", "@of": "Week.id", "@via": "Program.weeks", "@filter": { ordinal: { gte: 1, lte: 5 } },
      } }] } },
      { "identity.primary": { name: "id", extends: "Program.id" } },
    ] } },
  ] },
};

describe("multi-op — every operator of an origin @filter field clause is kept", () => {
  test("a range keeps both bounds", async () => {
    const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(MODEL))]);
    expect(errors).toEqual([]);
    const [v] = buildProjectionViews(root, { dialect: "postgres" });
    expect(v!.sql).toContain("FILTER (WHERE (w.ordinal >= 1 AND w.ordinal <= 5)) AS early");
  });
});
