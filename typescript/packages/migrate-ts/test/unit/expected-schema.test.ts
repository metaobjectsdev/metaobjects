import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Loader } from "@metaobjects/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";

function loadFixture(name: string) {
  const json = readFileSync(join(import.meta.dir, "..", "fixtures", `${name}.json`), "utf8");
  const loader = new Loader();
  const result = loader.loadJson(json);
  return result.root;
}

describe("buildExpectedSchema — single entity", () => {
  const metadata = loadFixture("single-entity");
  const snapshot = buildExpectedSchema(metadata);

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
  const metadata = loadFixture("single-entity");
  const snapshot = buildExpectedSchema(metadata);
  const cols = snapshot.tables[0]?.columns ?? [];
  const byName = new Map(cols.map((c) => [c.name, c]));

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
  const metadata = loadFixture("two-entities-fk");
  const snapshot = buildExpectedSchema(metadata);
  const programs = snapshot.tables.find((t) => t.name === "programs");
  const weeks = snapshot.tables.find((t) => t.name === "weeks");

  test("secondary identity → unique index", () => {
    expect(programs?.indexes).toEqual([
      { name: "programs_unique_slug", columns: ["slug"], unique: true },
    ]);
  });

  test("primary identity does NOT produce a separate index (PK is intrinsic)", () => {
    expect(programs?.indexes.find((i) => i.name === "programs_pk")).toBeUndefined();
  });

  test("many-to-one relationship → FK on child table", () => {
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
    const programIdCol = weeks?.columns.find((c) => c.name === "program_id");
    expect(programIdCol).toBeDefined();
    expect(programIdCol?.sqlType).toEqual({ kind: "integer", bits: 64 });
    expect(programIdCol?.nullable).toBe(false);
  });
});
