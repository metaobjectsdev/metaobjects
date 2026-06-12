import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { computeProjectionMigrations } from "../../src/lib/projection-migrations.js";

// ---------------------------------------------------------------------------
// Helper — wrap children in metadata envelope and load.
// ---------------------------------------------------------------------------
async function load(children: unknown[]) {
  const json = JSON.stringify({ "metadata.root": { package: "test", children } });
  const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  if (result.errors.length > 0) {
    throw new Error(
      `Loader errors:\n${result.errors.map((e) => e.message).join("\n")}`,
    );
  }
  return result.root;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const programEntity = {
  "object.entity": {
    name: "Program",
    children: [
      { "source.rdb": { "@table": "programs" } },
      { "field.int": { name: "id", "@column": "id" } },
      { "field.string": { name: "title", "@column": "title" } },
      { "identity.primary": { "name": "id", "@fields": "id" } },
      {
        "relationship.association": {
          name: "weeks",
          "@objectRef": "Week",
          "@cardinality": "many",
        },
      },
    ],
  },
};

const weekEntity = {
  "object.entity": {
    name: "Week",
    children: [
      { "source.rdb": { "@table": "weeks" } },
      { "field.int": { name: "id", "@column": "id" } },
      { "field.int": { name: "programId", "@column": "program_id" } },
      { "identity.primary":   { "name": "id", "@fields": "id" } },
      { "identity.reference": { name: "ref_program", "@fields": "programId", "@references": "Program" } },
    ],
  },
};

const programSummaryProjection = {
  "object.entity": {
    name: "ProgramSummary",
    extends: "Program",
    children: [
      { "source.rdb": { "@kind": "view", "@table": "v_program_summary" } },
      {
        "field.int": {
          name: "weekCount",
          children: [
            {
              "origin.aggregate": {
                "@agg": "count",
                "@of": "Week.id",
                "@via": "Program.weeks",
              },
            },
          ],
        },
      },
      { "identity.primary": { "name": "id", "@fields": "id" } },
    ],
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("computeProjectionMigrations", () => {
  test("returns empty migrations when no projections exist", async () => {
    const metadata = await load([programEntity, weekEntity]);
    const result = computeProjectionMigrations({ metadata, dialect: "sqlite" });
    expect(result.migrations).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  test("emits CREATE VIEW SQL for a projection with aggregate field", async () => {
    const metadata = await load([programEntity, weekEntity, programSummaryProjection]);
    const result = computeProjectionMigrations({ metadata, dialect: "sqlite" });

    expect(result.errors).toHaveLength(0);
    expect(result.migrations).toHaveLength(1);

    const sql = result.migrations[0];
    expect(sql).toBeDefined();
    expect(sql).toMatch(/v_program_summary/);
    expect(sql).toMatch(/CREATE(?:\s+OR\s+REPLACE)?\s+VIEW/i);
    expect(sql).toMatch(/LEFT OUTER JOIN weeks w ON w\.program_id = p\.id/);
    expect(sql).toMatch(/COUNT\(DISTINCT/i);
  });

  test("resolves table name from @table on source.rdb", async () => {
    const metadata = await load([programEntity, weekEntity, programSummaryProjection]);
    const result = computeProjectionMigrations({ metadata, dialect: "sqlite" });

    expect(result.errors).toHaveLength(0);
    const sql = result.migrations[0];
    expect(sql).toMatch(/FROM programs p/);
  });

  test("uses postgres dialect when requested", async () => {
    const metadata = await load([programEntity, weekEntity, programSummaryProjection]);
    const result = computeProjectionMigrations({ metadata, dialect: "postgres" });

    expect(result.errors).toHaveLength(0);
    expect(result.migrations).toHaveLength(1);
    expect(result.migrations[0]).toMatch(/v_program_summary/);
  });

  test("snake_case strategy (default) produces snake_case column aliases", async () => {
    const metadata = await load([programEntity, weekEntity, programSummaryProjection]);
    const result = computeProjectionMigrations({
      metadata,
      dialect: "sqlite",
      columnNamingStrategy: "snake_case",
    });
    expect(result.errors).toHaveLength(0);
    const sql = result.migrations[0];
    // week_count is the snake_case alias for weekCount
    expect(sql).toMatch(/week_count/);
  });

  test("literal strategy preserves camelCase column aliases", async () => {
    const metadata = await load([programEntity, weekEntity, programSummaryProjection]);
    const result = computeProjectionMigrations({
      metadata,
      dialect: "sqlite",
      columnNamingStrategy: "literal",
    });
    expect(result.errors).toHaveLength(0);
    const sql = result.migrations[0];
    // literal strategy must use weekCount, not week_count
    expect(sql).toContain("weekCount");
    expect(sql).not.toMatch(/\bweek_count\b/);
  });

  test("handles email-based join via dotted identity.reference", async () => {
    const customerEntity = {
      "object.entity": {
        name: "Customer",
        children: [
          { "source.rdb": { "@table": "customers" } },
          { "field.int": { name: "id", "@column": "id" } },
          { "field.string": { name: "email", "@column": "email" } },
          { "identity.primary":   { "name": "id", "@fields": "id" } },
          { "identity.secondary": { "name": "byEmail", "@fields": "email" } },
          {
            "relationship.association": {
              name: "purchases",
              "@objectRef": "Purchase",
              "@cardinality": "many",
            },
          },
        ],
      },
    };
    const purchaseEntity = {
      "object.entity": {
        name: "Purchase",
        children: [
          { "source.rdb": { "@table": "purchases" } },
          { "field.int": { name: "id", "@column": "id" } },
          { "field.string": { name: "customerEmail", "@column": "customer_email" } },
          { "identity.primary":   { "name": "id", "@fields": "id" } },
          { "identity.reference": { name: "ref_customer", "@fields": "customerEmail", "@references": "Customer.email" } },
        ],
      },
    };
    const customerSummaryProjection = {
      "object.entity": {
        name: "CustomerSummary",
        extends: "Customer",
        children: [
          { "source.rdb": { "@kind": "view", "@table": "v_customer_summary" } },
          {
            "field.int": {
              name: "purchaseCount",
              children: [
                {
                  "origin.aggregate": {
                    "@agg": "count",
                    "@of": "Purchase.id",
                    "@via": "Customer.purchases",
                  },
                },
              ],
            },
          },
          { "identity.primary": { "name": "id", "@fields": "id" } },
        ],
      },
    };

    const metadata = await load([customerEntity, purchaseEntity, customerSummaryProjection]);
    const result = computeProjectionMigrations({ metadata, dialect: "sqlite" });

    expect(result.errors).toHaveLength(0);
    expect(result.migrations).toHaveLength(1);
    const sql = result.migrations[0];
    // Non-id join: must reference c.email not c.id in the ON clause
    expect(sql).toMatch(/LEFT OUTER JOIN purchases p ON p\.customer_email = c\.email/);
  });
});
