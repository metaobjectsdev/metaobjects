// A projection row-scope `@filter` (#207) on an INT-BACKED field.enum (@intValueMap,
// design D5) must lower to the INTEGER literal, not the member symbol.
//
// The column is `integer`, so `WHERE p.status = 'PUBLISHED'` is not merely wrong rows —
// on Postgres it is `invalid input syntax for type integer`, raised at CREATE VIEW time,
// which aborts the whole migration. This is the same defect class as Task 7's `@default`
// (`DEFAULT 'DRAFT'` on an integer column): everywhere metadata puts an enum member into
// SQL, the member has to go through @intValueMap first.
//
// The Drizzle customType covers the RUNTIME query path for free, but view DDL is emitted
// as literal SQL text and never touches Drizzle — so it needs its own encoding.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { extractViewSpec } from "../../src/projection/extract-view-spec.js";
import { emitViewDdl } from "../../src/projection/view-ddl-emit.js";
import { buildProjectionViews } from "../../src/projection/build-projection-views.js";

type CodedError = Error & { readonly code?: string };
const codeOf = (e: Error): string | undefined => (e as CodedError).code;

async function load(children: unknown[]) {
  const json = JSON.stringify({ "metadata.root": { package: "test", children } });
  const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  if (result.errors.length > 0) {
    throw new Error(
      `Loader errors:\n${result.errors.map((e) => `${codeOf(e)}: ${e.message}`).join("\n")}`,
    );
  }
  return result.root;
}

/** `Program` with one int-backed enum + one string-backed enum (the control). */
function programEntity() {
  return {
    "object.entity": {
      name: "Program",
      children: [
        { "source.rdb": { "@table": "programs" } },
        { "field.int": { name: "id" } },
        {
          "field.enum": {
            name: "status",
            "@values": ["DRAFT", "PUBLISHED", "ARCHIVED"],
            "@intValueMap": { DRAFT: 0, PUBLISHED: 5, ARCHIVED: 9 },
          },
        },
        { "field.enum": { name: "tier", "@values": ["FREE", "PAID"] } },
        { "identity.primary": { name: "id", "@fields": "id" } },
      ],
    },
  };
}

function projection(name: string, view: string, filter: unknown) {
  return {
    "object.projection": {
      name,
      "@filter": filter,
      children: [
        { "source.rdb": { "@kind": "view", "@view": view } },
        { "field.int": { name: "id", extends: "test::Program.id" } },
        { "field.enum": { name: "status", extends: "test::Program.status" } },
        { "field.enum": { name: "tier", extends: "test::Program.tier" } },
        { "identity.primary": { extends: "test::Program.id" } },
      ],
    },
  };
}

async function sqlFor(filter: unknown): Promise<string> {
  const root = await load([programEntity(), projection("P", "v_p", filter)]);
  const proj = root.objects().find((o) => o.name === "P")!;
  const spec = extractViewSpec(proj, root, { columnNamingStrategy: "snake_case" });
  return emitViewDdl(spec, {
    dialect: "postgres",
    baseTableName: "programs",
    joinTables: {},
    bodyOnly: true,
  });
}

describe("#207 view @filter on an int-backed enum lowers to the integer", () => {
  test("eq encodes the member symbol to its integer", async () => {
    const sql = await sqlFor({ status: { eq: "PUBLISHED" } });
    expect(sql).toContain("WHERE p.status = 5");
    // The member symbol must NOT survive into the SQL.
    expect(sql).not.toContain("'PUBLISHED'");
  });

  test("ne encodes too", async () => {
    const sql = await sqlFor({ status: { ne: "ARCHIVED" } });
    expect(sql).toContain("WHERE p.status <> 9");
  });

  test("in encodes element-wise", async () => {
    const sql = await sqlFor({ status: { in: ["DRAFT", "ARCHIVED"] } });
    expect(sql).toContain("WHERE p.status IN (0, 9)");
  });

  test("the zero member encodes as 0, not dropped as falsy", async () => {
    // DRAFT → 0. A truthiness-guarded encode would leave 'DRAFT' here; #235 is the
    // precedent for a falsy-value bug in exactly this shape.
    const sql = await sqlFor({ status: { eq: "DRAFT" } });
    expect(sql).toContain("WHERE p.status = 0");
  });

  test("isNull is untouched by the encoding", async () => {
    const sql = await sqlFor({ status: { isNull: true } });
    expect(sql).toContain("WHERE p.status IS NULL");
  });

  test("a STRING-backed enum is byte-identical to before (quoted symbol)", async () => {
    const sql = await sqlFor({ tier: { eq: "PAID" } });
    expect(sql).toContain("WHERE p.tier = 'PAID'");
  });

  test("a composed and/or filter encodes inside both arms", async () => {
    const sql = await sqlFor({
      or: [{ status: { eq: "DRAFT" } }, { status: { eq: "PUBLISHED" } }],
    });
    expect(sql).toContain("(p.status = 0 OR p.status = 5)");
  });

  test("the map is read RESOLVING — an inherited @intValueMap still encodes", async () => {
    // The canonical post-#246 shape: the map on a shared root-level abstract enum,
    // inherited by the consuming field. An own-only read would emit 'PUBLISHED'.
    const root = await load([
      {
        "field.enum": {
          name: "SharedStatus",
          abstract: true,
          "@values": ["DRAFT", "PUBLISHED"],
          "@intValueMap": { DRAFT: 0, PUBLISHED: 5 },
        },
      },
      {
        "object.entity": {
          name: "Program",
          children: [
            { "source.rdb": { "@table": "programs" } },
            { "field.int": { name: "id" } },
            { "field.enum": { name: "status", extends: "test::SharedStatus" } },
            { "identity.primary": { name: "id", "@fields": "id" } },
          ],
        },
      },
      {
        "object.projection": {
          name: "P",
          "@filter": { status: { eq: "PUBLISHED" } },
          children: [
            { "source.rdb": { "@kind": "view", "@view": "v_p" } },
            { "field.int": { name: "id", extends: "test::Program.id" } },
            { "field.enum": { name: "status", extends: "test::Program.status" } },
            { "identity.primary": { extends: "test::Program.id" } },
          ],
        },
      },
    ]);
    const proj = root.objects().find((o) => o.name === "P")!;
    const spec = extractViewSpec(proj, root, { columnNamingStrategy: "snake_case" });
    const sql = emitViewDdl(spec, {
      dialect: "postgres",
      baseTableName: "programs",
      joinTables: {},
      bodyOnly: true,
    });
    expect(sql).toContain("WHERE p.status = 5");
    expect(sql).not.toContain("'PUBLISHED'");
  });
});

// The `origin.aggregate @filter` scoping filter is a SEPARATE resolver
// (resolveAggregateFilter) from the row-scope one, and renders as a SQL literal too —
// `FILTER (WHERE …)` on Postgres, `CASE WHEN` on SQLite. Assume a sibling code path
// exists: the row-scope fix above does not reach this one.
describe("origin.aggregate @filter on an int-backed enum lowers to the integer", () => {
  const model = () => [
    {
      "object.entity": {
        name: "Program",
        children: [
          { "source.rdb": { "@table": "programs" } },
          { "field.int": { name: "id" } },
          { "identity.primary": { name: "id", "@fields": "id" } },
          {
            "relationship.association": {
              name: "weeks", "@objectRef": "Week", "@cardinality": "many",
            },
          },
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
          {
            "field.enum": {
              name: "status",
              "@values": ["DRAFT", "ACTIVE"],
              "@intValueMap": { DRAFT: 0, ACTIVE: 7 },
            },
          },
          { "identity.primary": { name: "id", "@fields": "id" } },
          {
            "identity.reference": {
              name: "ref_program", "@fields": "programId", "@references": "Program",
            },
          },
        ],
      },
    },
    {
      "object.projection": {
        name: "ProgramSummary",
        children: [
          { "source.rdb": { "@kind": "view", "@table": "v_program_summary" } },
          { "field.int": { name: "id", extends: "Program.id" } },
          {
            "field.int": {
              name: "activeMax",
              children: [{
                "origin.aggregate": {
                  "@agg": "max", "@of": "Week.ordinal", "@via": "Program.weeks",
                  "@filter": { status: { eq: "ACTIVE" } },
                },
              }],
            },
          },
          { "identity.primary": { name: "id", extends: "Program.id" } },
        ],
      },
    },
  ];

  test("postgres FILTER (WHERE …) compares the integer", async () => {
    const root = await load(model());
    const [v] = buildProjectionViews(root, {
      dialect: "postgres", columnNamingStrategy: "snake_case",
    });
    expect(v!.sql).toMatch(/FILTER \(WHERE [a-z0-9]+\.status = 7\)/);
    expect(v!.sql).not.toContain("'ACTIVE'");
  });

  test("sqlite CASE WHEN compares the integer", async () => {
    const root = await load(model());
    const [v] = buildProjectionViews(root, {
      dialect: "sqlite", columnNamingStrategy: "snake_case",
    });
    expect(v!.sql).toMatch(/CASE WHEN [a-z0-9]+\.status = 7 THEN/);
    expect(v!.sql).not.toContain("'ACTIVE'");
  });
});
