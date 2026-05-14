import { describe, test, expect } from "bun:test";
import { Loader } from "@metaobjects/metadata";
import { computeProjectionMigrations } from "../../src/lib/projection-migrations.js";

// ---------------------------------------------------------------------------
// Helper — wrap children in metadata envelope and load.
// ---------------------------------------------------------------------------
function load(children: unknown[]) {
  const loader = new Loader();
  const json = JSON.stringify({ metadata: { package: "test", children } });
  const result = loader.loadJson(json);
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
  object: {
    name: "Program",
    subType: "entity",
    "@dbTable": "programs",
    children: [
      { field: { name: "id", subType: "int", "@dbColumn": "id" } },
      { field: { name: "title", subType: "string", "@dbColumn": "title" } },
      { identity: { subType: "primary", "@fields": "id" } },
      {
        relationship: {
          subType: "association",
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
  object: {
    name: "Week",
    subType: "entity",
    "@dbTable": "weeks",
    children: [
      { field: { name: "id", subType: "int", "@dbColumn": "id" } },
      { field: { name: "programId", subType: "int", "@dbColumn": "program_id" } },
      { identity: { subType: "primary", "@fields": "id" } },
    ],
  },
};

const programSummaryProjection = {
  object: {
    name: "ProgramSummary",
    subType: "entity",
    extends: "Program",
    children: [
      { source: { subType: "dbView", "@name": "v_program_summary" } },
      {
        field: {
          name: "weekCount",
          subType: "int",
          children: [
            {
              origin: {
                subType: "aggregate",
                "@agg": "count",
                "@of": "Week.id",
                "@via": "Program.weeks",
              },
            },
          ],
        },
      },
      { identity: { subType: "primary", "@fields": "id" } },
    ],
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("computeProjectionMigrations", () => {
  test("returns empty migrations when no projections exist", () => {
    const metadata = load([programEntity, weekEntity]);
    const result = computeProjectionMigrations({ metadata, dialect: "sqlite" });
    expect(result.migrations).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  test("emits CREATE VIEW SQL for a projection with aggregate field", () => {
    const metadata = load([programEntity, weekEntity, programSummaryProjection]);
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

  test("resolves table name from @dbTable attr", () => {
    const metadata = load([programEntity, weekEntity, programSummaryProjection]);
    const result = computeProjectionMigrations({ metadata, dialect: "sqlite" });

    expect(result.errors).toHaveLength(0);
    const sql = result.migrations[0];
    expect(sql).toMatch(/FROM programs p/);
  });

  test("uses postgres dialect when requested", () => {
    const metadata = load([programEntity, weekEntity, programSummaryProjection]);
    const result = computeProjectionMigrations({ metadata, dialect: "postgres" });

    expect(result.errors).toHaveLength(0);
    expect(result.migrations).toHaveLength(1);
    expect(result.migrations[0]).toMatch(/v_program_summary/);
  });

  test("snake_case strategy (default) produces snake_case column aliases", () => {
    const metadata = load([programEntity, weekEntity, programSummaryProjection]);
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

  test("literal strategy preserves camelCase column aliases", () => {
    const metadata = load([programEntity, weekEntity, programSummaryProjection]);
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

  test("handles email-based join via @parentField", () => {
    const customerEntity = {
      object: {
        name: "Customer",
        subType: "entity",
        "@dbTable": "customers",
        children: [
          { field: { name: "id", subType: "int", "@dbColumn": "id" } },
          { field: { name: "email", subType: "string", "@dbColumn": "email" } },
          { identity: { subType: "primary", "@fields": "id" } },
          {
            relationship: {
              subType: "association",
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
      object: {
        name: "Purchase",
        subType: "entity",
        "@dbTable": "purchases",
        children: [
          { field: { name: "id", subType: "int", "@dbColumn": "id" } },
          { field: { name: "customerEmail", subType: "string", "@dbColumn": "customer_email" } },
          { identity: { subType: "primary", "@fields": "id" } },
        ],
      },
    };
    const customerSummaryProjection = {
      object: {
        name: "CustomerSummary",
        subType: "entity",
        extends: "Customer",
        children: [
          { source: { subType: "dbView", "@name": "v_customer_summary" } },
          {
            field: {
              name: "purchaseCount",
              subType: "int",
              children: [
                {
                  origin: {
                    subType: "aggregate",
                    "@agg": "count",
                    "@of": "Purchase.id",
                    "@via": "Customer.purchases",
                  },
                },
              ],
            },
          },
          { identity: { subType: "primary", "@fields": "id" } },
        ],
      },
    };

    const metadata = load([customerEntity, purchaseEntity, customerSummaryProjection]);
    const result = computeProjectionMigrations({ metadata, dialect: "sqlite" });

    expect(result.errors).toHaveLength(0);
    expect(result.migrations).toHaveLength(1);
    const sql = result.migrations[0];
    // Non-id join: must reference c.email not c.id in the ON clause
    expect(sql).toMatch(/LEFT OUTER JOIN purchases p ON p\.customer_email = c\.email/);
  });
});
