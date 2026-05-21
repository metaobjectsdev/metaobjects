import { test, expect, describe, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MetaDataLoader, InMemorySource } from "@metaobjects/metadata";
import type { MetaData } from "@metaobjects/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import type { SchemaSnapshot, ColumnDescriptor } from "../../src/types.js";

async function loadFixture(name: string) {
  const json = readFileSync(join(import.meta.dir, "..", "fixtures", `${name}.json`), "utf8");
  const result = await new MetaDataLoader().load([new InMemorySource(json)]);
  return result.root;
}

describe("buildExpectedSchema — single entity", () => {
  let metadata: MetaData;
  let snapshot: SchemaSnapshot;

  beforeAll(async () => {
    metadata = await loadFixture("single-entity");
    snapshot = buildExpectedSchema(metadata);
  });

  test("produces one table with snake_case + pluralized name", () => {
    expect(snapshot.tables).toHaveLength(1);
    expect(snapshot.tables[0]?.name).toBe("users");
  });

  test("columns are snake_cased and in metadata order", () => {
    const cols = snapshot.tables[0]?.columns ?? [];
    expect(cols.map((c) => c.name)).toEqual(["id", "email", "first_name", "is_active", "created_at"]);
  });

  test("string field → text(unbounded), boolean → boolean, long → integer{64}", () => {
    const cols = snapshot.tables[0]?.columns ?? [];
    expect(cols[0]?.sqlType).toEqual({ kind: "integer", bits: 64 });
    expect(cols[1]?.sqlType).toEqual({ kind: "text" });
    expect(cols[3]?.sqlType).toEqual({ kind: "boolean" });
  });

  test("primary key reflects identity record", () => {
    expect(snapshot.tables[0]?.primaryKey).toEqual(["id"]);
  });

  test("views array always empty in v0.1", () => {
    expect(snapshot.views).toEqual([]);
  });

  test("no indexes / FKs yet (Task 8)", () => {
    expect(snapshot.tables[0]?.indexes).toEqual([]);
    expect(snapshot.tables[0]?.foreignKeys).toEqual([]);
  });
});

describe("buildExpectedSchema — nullable / default / identity", () => {
  let snapshot: SchemaSnapshot;
  let byName: Map<string, ColumnDescriptor>;

  beforeAll(async () => {
    const metadata = await loadFixture("single-entity");
    snapshot = buildExpectedSchema(metadata);
    const cols = snapshot.tables[0]?.columns ?? [];
    byName = new Map(cols.map((c) => [c.name, c]));
  });

  test("PK column is non-nullable even without explicit required attr", () => {
    expect(byName.get("id")?.nullable).toBe(false);
  });

  test("required=true → nullable=false", () => {
    expect(byName.get("email")?.nullable).toBe(false);
  });

  test("no required attr → nullable=true", () => {
    expect(byName.get("first_name")?.nullable).toBe(true);
  });

  test("default literal (boolean true)", () => {
    expect(byName.get("is_active")?.default).toEqual({ kind: "literal", value: "true" });
  });

  test("default expression (CURRENT_TIMESTAMP detected as expr, not literal)", () => {
    expect(byName.get("created_at")?.default).toEqual({
      kind: "expr",
      value: "CURRENT_TIMESTAMP",
    });
  });

  test("PK column with generation=increment gets identity=increment", () => {
    expect(byName.get("id")?.identity).toBe("increment");
  });
});

describe("buildExpectedSchema — indexes + FKs", () => {
  let snapshot: SchemaSnapshot;

  beforeAll(async () => {
    const metadata = await loadFixture("two-entities-fk");
    snapshot = buildExpectedSchema(metadata);
  });

  test("secondary identity → unique index (name uses identity.name as-is — matches Drizzle emit)", () => {
    const programs = snapshot.tables.find((t) => t.name === "programs");
    expect(programs?.indexes).toEqual([
      { name: "uniqueSlug", columns: ["slug"], unique: true },
    ]);
  });

  test("primary identity does NOT produce a separate index (PK is intrinsic)", () => {
    const programs = snapshot.tables.find((t) => t.name === "programs");
    expect(programs?.indexes.find((i) => i.name === "programs_pk")).toBeUndefined();
  });

  test("many-to-one relationship → FK on child table", () => {
    const weeks = snapshot.tables.find((t) => t.name === "weeks");
    expect(weeks?.foreignKeys).toEqual([
      {
        name: "weeks_program_id_fk",
        columns: ["program_id"],
        refTable: "programs",
        refColumns: ["id"],
      },
    ]);
  });

  test("FK column on child is also present as a regular column", () => {
    const weeks = snapshot.tables.find((t) => t.name === "weeks");
    const programIdCol = weeks?.columns.find((c) => c.name === "program_id");
    expect(programIdCol).toBeDefined();
    expect(programIdCol?.sqlType).toEqual({ kind: "integer", bits: 64 });
    expect(programIdCol?.nullable).toBe(false);
  });
});

describe("buildExpectedSchema — identity.reference @enforce", () => {
  async function loadInline(children: unknown[]) {
    const json = JSON.stringify({ "metadata.root": { package: "test", children } });
    const result = await new MetaDataLoader().load([new InMemorySource(json)]);
    if (result.errors.length > 0) {
      throw new Error(`Loader errors:\n${result.errors.map((e) => e.message).join("\n")}`);
    }
    return result.root;
  }

  test("hard reference produces an FkDescriptor", async () => {
    const root = await loadInline([
      {
        "object.entity": {
          name: "Program",
          children: [
            { "source.dbTable": { "@name": "programs" } },
            { "field.long": { name: "id" } },
            { "identity.primary": { "@fields": "id" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Purchase",
          children: [
            { "source.dbTable": { "@name": "purchases" } },
            { "field.long":   { name: "id" } },
            { "field.long":   { name: "programId" } },
            { "identity.primary":   { "@fields": "id" } },
            { "identity.reference": { name: "ref_program", "@fields": "programId", "@references": "Program" } },
          ],
        },
      },
    ]);
    const snapshot = buildExpectedSchema(root);
    const purchases = snapshot.tables.find((t) => t.name === "purchases");
    expect(purchases?.foreignKeys.length).toBe(1);
    expect(purchases?.foreignKeys[0]).toMatchObject({
      columns: ["program_id"],
      refTable: "programs",
    });
  });

  test("soft reference (@enforce: false) omits the FkDescriptor", async () => {
    const root = await loadInline([
      {
        "object.entity": {
          name: "Subscriber",
          children: [
            { "source.dbTable": { "@name": "subscribers" } },
            { "field.long":   { name: "id" } },
            { "field.string": { name: "email" } },
            { "identity.primary":   { "@fields": "id" } },
            { "identity.secondary": { "@fields": "email" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Purchase",
          children: [
            { "source.dbTable": { "@name": "purchases" } },
            { "field.long":   { name: "id" } },
            { "field.string": { name: "customerEmail" } },
            { "identity.primary":   { "@fields": "id" } },
            {
              "identity.reference": {
                name: "ref_subscriber",
                "@fields": "customerEmail",
                "@references": "Subscriber.email",
                "@enforce": false,
              },
            },
          ],
        },
      },
    ]);
    const snapshot = buildExpectedSchema(root);
    const purchases = snapshot.tables.find((t) => t.name === "purchases");
    expect(purchases?.foreignKeys.length).toBe(0);
    // The FK column itself is still present.
    expect(purchases?.columns.find((c) => c.name === "customer_email")).toBeDefined();
  });
});
