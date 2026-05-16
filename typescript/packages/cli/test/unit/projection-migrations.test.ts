import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemorySource } from "@metaobjects/metadata";
import { computeProjectionMigrations } from "../../src/lib/projection-migrations.js";

// ---------------------------------------------------------------------------
// Helper — wrap children in metadata envelope and load.
// ---------------------------------------------------------------------------
async function load(children: unknown[]) {
  const json = JSON.stringify({ "metadata.root": { package: "test", children } });
  const result = await new MetaDataLoader().load([new InMemorySource(json)]);
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
      { "source.dbTable": { "@name": "programs" } },
      { "field.int": { name: "id", "@dbColumn": "id" } },
      { "field.string": { name: "title", "@dbColumn": "title" } },
      { "identity.primary": { "@fields": "id" } },
      {
        "relationship.association": {
          name: "weeks",
          "@objectRef": "Week",
          "@cardinality": "many",
          "@fkField": "programId",
        },
      },
    ],
  },
};

const weekEntity = {
  "object.entity": {
    name: "Week",
    children: [
      { "source.dbTable": { "@name": "weeks" } },
      { "field.int": { name: "id", "@dbColumn": "id" } },
      { "field.int": { name: "programId", "@dbColumn": "program_id" } },
      { "identity.primary": { "@fields": "id" } },
    ],
  },
};

const programSummaryProjection = {
  "object.entity": {
    name: "ProgramSummary",
    extends: "Program",
    children: [
      { "source.dbView": { "@name": "v_program_summary" } },
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
      { "identity.primary": { "@fields": "id" } },
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

  test("resolves table name from @dbTable attr", async () => {
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

  test("handles email-based join via @parentField", async () => {
    const customerEntity = {
      "object.entity": {
        name: "Customer",
        children: [
          { "source.dbTable": { "@name": "customers" } },
          { "field.int": { name: "id", "@dbColumn": "id" } },
          { "field.string": { name: "email", "@dbColumn": "email" } },
          { "identity.primary": { "@fields": "id" } },
          {
            "relationship.association": {
              name: "purchases",
              "@objectRef": "Purchase",
              "@cardinality": "many",
              "@fkField": "customerEmail",
              "@parentField": "email",
            },
          },
        ],
      },
    };
    const purchaseEntity = {
      "object.entity": {
        name: "Purchase",
        children: [
          { "source.dbTable": { "@name": "purchases" } },
          { "field.int": { name: "id", "@dbColumn": "id" } },
          { "field.string": { name: "customerEmail", "@dbColumn": "customer_email" } },
          { "identity.primary": { "@fields": "id" } },
        ],
      },
    };
    const customerSummaryProjection = {
      "object.entity": {
        name: "CustomerSummary",
        extends: "Customer",
        children: [
          { "source.dbView": { "@name": "v_customer_summary" } },
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
          { "identity.primary": { "@fields": "id" } },
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
