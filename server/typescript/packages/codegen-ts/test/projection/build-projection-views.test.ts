// buildProjectionViews — the single source of expected view DDL. Regression coverage
// for the two own-vs-effective bugs that made a 1:1 contract projection emit only its
// PK (the platform AgentConfigView case):
//   1. `@from` is package-qualified ("pkg::Entity.field") but the joinTree + findObject
//      key on the BARE name — must stripPackage.
//   2. the source field may be INHERITED via `extends` (e.g. an audited base's columns)
//      — must resolve via effective fields(), not ownChildren().
// Also pins the `extends`-base-link PK projecting as an implicit passthrough alongside
// `origin.passthrough` renames, and the bodyOnly emit shape consumed by migrate-ts.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildProjectionViews } from "../../src/projection/build-projection-views.js";

async function load(children: unknown[]) {
  const json = JSON.stringify({ "metadata.root": { package: "acme", children } });
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  expect(errors).toEqual([]);
  return root;
}

describe("buildProjectionViews — package-qualified @from + inherited source fields", () => {
  test("extends-PK passthrough + renamed origin + INHERITED column all project", async () => {
    const root = await load([
      // Abstract base contributes an inherited column (createdAt → created_at).
      {
        "object.entity": {
          name: "Audited",
          abstract: true,
          children: [
            { "field.long": { name: "id" } },
            { "field.timestamp": { name: "createdAt", "@column": "created_at" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Program",
          extends: "acme::Audited",
          children: [
            { "source.rdb": { "@table": "programs" } },
            { "field.string": { name: "rawTitle", "@column": "raw_title" } },
          ],
        },
      },
      {
        "object.projection": {
          name: "ProgramView",
          children: [
            { "source.rdb": { "@kind": "view", "@view": "v_program" } },
            // extends base-link PK → implicit passthrough.
            { "field.long": { name: "id", extends: "acme::Program.id" } },
            // rename via origin.passthrough (FQ @from).
            { "field.string": { name: "title", children: [{ "origin.passthrough": { "@from": "acme::Program.rawTitle" } }] } },
            // INHERITED source column (created_at lives on the Audited base).
            { "field.timestamp": { name: "created_at", children: [{ "origin.passthrough": { "@from": "acme::Program.createdAt" } }] } },
            { "identity.primary": { extends: "acme::Program.pk" } },
          ],
        },
      },
    ]);

    const views = buildProjectionViews(root, { dialect: "postgres", columnNamingStrategy: "snake_case" });
    expect(views.length).toBe(1);
    const v = views[0]!;
    expect(v.name).toBe("v_program");
    // bodyOnly: no CREATE VIEW wrapper, no trailing ';'.
    expect(v.sql).not.toMatch(/CREATE\s+VIEW/i);
    expect(v.sql.trimEnd()).not.toMatch(/;$/);
    // All three columns present (PK passthrough + rename + inherited).
    expect(v.sql).toContain("id AS id");
    expect(v.sql).toContain("raw_title AS title");
    expect(v.sql).toContain("created_at AS created_at");
    expect(v.sql).toContain("FROM programs");
  });
});

describe("buildProjectionViews — scoped aggregate (origin.aggregate @filter)", () => {
  // Program 1→many Week (FK on Week). A projection counts all weeks and takes the
  // max ordinal over only the 'active' weeks — the filtered-scalar pattern that a
  // plain aggregate can't express.
  const model = (filter: unknown) => [
    {
      "object.entity": {
        name: "Program",
        children: [
          { "source.rdb": { "@table": "programs" } },
          { "field.int": { name: "id" } },
          { "field.string": { name: "title" } },
          { "identity.primary": { name: "id", "@fields": "id" } },
          { "relationship.association": { name: "weeks", "@objectRef": "Week", "@cardinality": "many" } },
        ],
      },
    },
    {
      "object.entity": {
        name: "Week",
        children: [
          { "source.rdb": { "@table": "weeks" } },
          { "field.int": { name: "id" } },
          { "field.int": { name: "programId" } },
          { "field.int": { name: "ordinal" } },
          { "field.string": { name: "status" } },
          { "identity.primary": { name: "id", "@fields": "id" } },
          { "identity.reference": { name: "ref_program", "@fields": "programId", "@references": "Program" } },
        ],
      },
    },
    {
      "object.projection": {
        name: "ProgramSummary",
        children: [
          { "source.rdb": { "@kind": "view", "@table": "v_program_summary" } },
          { "field.int": { name: "id", extends: "Program.id" } },
          { "field.int": { name: "weekCount", children: [{ "origin.aggregate": { "@agg": "count", "@of": "Week.id", "@via": "Program.weeks" } }] } },
          {
            "field.int": {
              name: "activeMax",
              children: [{ "origin.aggregate": { "@agg": "max", "@of": "Week.ordinal", "@via": "Program.weeks", "@filter": filter } }],
            },
          },
          { "identity.primary": { name: "id", extends: "Program.id" } },
        ],
      },
    },
  ];

  test("postgres: filtered max renders FILTER (WHERE …); plain count unaffected", async () => {
    const root = await load(model({ status: { eq: "active" } }));
    const [v] = buildProjectionViews(root, { dialect: "postgres", columnNamingStrategy: "snake_case" });
    expect(v!.sql).toContain("COUNT(DISTINCT");          // plain count still emits
    expect(v!.sql).toMatch(/MAX\([a-z0-9]+\.ordinal\) FILTER \(WHERE [a-z0-9]+\.status = 'active'\) AS active_max/);
    expect(v!.sql).toContain("LEFT OUTER JOIN weeks");   // inverse-FK join present
  });

  test("scalar filter desugars to eq (status: 'active')", async () => {
    const root = await load(model({ status: "active" }));
    const [v] = buildProjectionViews(root, { dialect: "postgres", columnNamingStrategy: "snake_case" });
    expect(v!.sql).toMatch(/FILTER \(WHERE [a-z0-9]+\.status = 'active'\)/);
  });

  test("sqlite: filtered max renders the portable CASE WHEN form", async () => {
    const root = await load(model({ status: { eq: "active" } }));
    const [v] = buildProjectionViews(root, { dialect: "sqlite", columnNamingStrategy: "snake_case" });
    expect(v!.sql).toMatch(/MAX\(CASE WHEN [a-z0-9]+\.status = 'active' THEN [a-z0-9]+\.ordinal END\) AS active_max/);
    expect(v!.sql).not.toContain("FILTER (WHERE");
  });
});

describe("buildProjectionViews — package-qualified relationship @objectRef", () => {
  // A relationship's @objectRef is package-qualified ("acme::Week") — the shape the
  // directory loader produces for a same-package objectRef authored bare. The join
  // resolver keyed findObject on the RAW objectRef while findObject keys on the BARE
  // name, so the join (and every aggregate that traverses it) was silently dropped —
  // the view degraded to PK + passthroughs only. Must stripPackage before findObject,
  // exactly as the @via/@of/@from paths already do.
  const model = [
    {
      "object.entity": {
        name: "Program",
        children: [
          { "source.rdb": { "@table": "programs" } },
          { "field.int": { name: "id" } },
          { "identity.primary": { name: "id", "@fields": "id" } },
          { "relationship.composition": { name: "weeks", "@objectRef": "acme::Week", "@cardinality": "many" } },
        ],
      },
    },
    {
      "object.entity": {
        name: "Week",
        children: [
          { "source.rdb": { "@table": "weeks" } },
          { "field.int": { name: "id" } },
          { "field.int": { name: "programId" } },
          { "identity.primary": { name: "id", "@fields": "id" } },
          { "identity.reference": { name: "ref_program", "@fields": "programId", "@references": "Program" } },
        ],
      },
    },
    {
      "object.projection": {
        name: "ProgramSummary",
        children: [
          { "source.rdb": { "@kind": "view", "@table": "v_program_summary" } },
          { "field.int": { name: "id", extends: "acme::Program.id" } },
          { "field.int": { name: "weekCount", children: [{ "origin.aggregate": { "@agg": "count", "@of": "acme::Week.id", "@via": "Program.weeks" } }] } },
          { "identity.primary": { name: "id", extends: "acme::Program.id" } },
        ],
      },
    },
  ];

  test("qualified @objectRef still resolves the inverse-FK join + aggregate", async () => {
    const root = await load(model);
    const [v] = buildProjectionViews(root, { dialect: "postgres", columnNamingStrategy: "snake_case" });
    expect(v!.sql).toContain("LEFT OUTER JOIN weeks"); // join present, not dropped
    expect(v!.sql).toContain("COUNT(DISTINCT");        // aggregate emitted, not degraded away
    expect(v!.sql).toMatch(/COUNT\(DISTINCT [a-z0-9]+\.id\) AS week_count/);
  });
});

describe("buildProjectionViews — #208 @sql / @unmanaged DDL-ownership escape valves", () => {
  // A recursive read-model that origin.* cannot express: the projection carries an
  // extends-bound identity (row identity for the read model) + an extends-bound field
  // (pure shape), which historically flips viewIsDerived() true and makes the tool
  // synthesize a trivial base-table passthrough SELECT — the silent-wrong-synthesis
  // hole (§1.2). The suppression rule (§6) classifies DDL-ownership BEFORE viewIsDerived.
  const RECURSIVE_BODY =
    "WITH RECURSIVE t AS (SELECT id, parent_id FROM nodes WHERE parent_id IS NULL " +
    "UNION ALL SELECT n.id, n.parent_id FROM nodes n JOIN t ON n.parent_id = t.id) SELECT * FROM t";

  const model = (source: Record<string, unknown>) => [
    {
      "object.entity": {
        name: "Node",
        children: [
          { "source.rdb": { "@table": "nodes" } },
          { "field.int": { name: "id" } },
          { "field.int": { name: "parentId", "@column": "parent_id" } },
          { "identity.primary": { name: "pk", "@fields": "id" } },
        ],
      },
    },
    {
      "object.projection": {
        name: "NodeTree",
        children: [
          { "source.rdb": source },
          { "field.int": { name: "id", extends: "Node.id" } },
          { "identity.primary": { extends: "Node.pk" } },
        ],
      },
    },
  ];

  test("an @sql projection with extends-bound identity gets its verbatim body, not a synthesized SELECT", async () => {
    const root = await load(model({ "@kind": "view", "@view": "v_node_tree", "@sql": RECURSIVE_BODY }));
    const views = buildProjectionViews(root, { dialect: "postgres", columnNamingStrategy: "snake_case" });
    const v = views.find((vv) => vv.name === "v_node_tree");
    expect(v).toBeDefined();
    expect(v!.sql).toBe(RECURSIVE_BODY);       // verbatim body, NOT a synthesized "SELECT nodes.id AS id …"
    expect(v!.sql).toContain("WITH RECURSIVE");
    expect(v!.columns).toBeUndefined();        // opaque — column list unknown → diff fails safe to drop+create
    // dependsOn is derived from the extends-bound anchor entity (Node → nodes), D7.
    expect(v!.dependsOn).toEqual(["nodes"]);
  });

  test("an @unmanaged projection produces no ExpectedView (skipped entirely)", async () => {
    const root = await load(model({ "@kind": "view", "@view": "v_node_tree", "@unmanaged": true }));
    const views = buildProjectionViews(root, { dialect: "postgres", columnNamingStrategy: "snake_case" });
    expect(views.find((vv) => vv.name === "v_node_tree")).toBeUndefined();
  });
});
