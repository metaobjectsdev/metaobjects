import { test, expect, describe, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import type { SchemaSnapshot, ColumnDescriptor } from "../../src/types.js";

async function loadFixture(name: string) {
  const json = readFileSync(join(import.meta.dir, "..", "fixtures", `${name}.json`), "utf8");
  const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
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

// ---------------------------------------------------------------------------
// @autoSet → DEFAULT now() (FR: auto-stamped timestamp columns)
//
// Regression: @autoSet (onCreate/onUpdate) marks a timestamp column as
// auto-stamped, but buildColumn ignored it — a NOT NULL @autoSet column emitted
// no DEFAULT, so an insert that relied on the DB to stamp it failed the
// not-null constraint. Both onCreate and onUpdate need an insert-time DEFAULT.
// ---------------------------------------------------------------------------

describe("buildExpectedSchema — @autoSet timestamp default", () => {
  async function colsFor(autoSet: string | null, withExplicitDefault = false) {
    const stampField = {
      "field.timestamp": {
        name: "stampedAt",
        "@required": true,
        ...(autoSet ? { "@autoSet": autoSet } : {}),
        ...(withExplicitDefault ? { "@default": "CURRENT_TIMESTAMP" } : {}),
      },
    };
    const doc = { "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Event", children: [
        { "source.rdb": {} },
        { "field.long": { name: "id" } },
        { "identity.primary": { "name": "id", "@fields": "id" } },
        stampField,
      ] } },
    ] } };
    const { root, errors } = await new MetaDataLoader().load([
      new InMemoryStringSource(JSON.stringify(doc)),
    ]);
    expect(errors).toHaveLength(0);
    const cols = buildExpectedSchema(root).tables[0]?.columns ?? [];
    return new Map(cols.map((c) => [c.name, c]));
  }

  test("@autoSet onCreate → DEFAULT now() (expr)", async () => {
    const byName = await colsFor("onCreate");
    expect(byName.get("stamped_at")?.default).toEqual({ kind: "expr", value: "now()" });
    expect(byName.get("stamped_at")?.nullable).toBe(false);
  });

  test("@autoSet onUpdate also gets an insert-time DEFAULT now()", async () => {
    const byName = await colsFor("onUpdate");
    expect(byName.get("stamped_at")?.default).toEqual({ kind: "expr", value: "now()" });
  });

  test("no @autoSet → no default", async () => {
    const byName = await colsFor(null);
    expect(byName.get("stamped_at")?.default).toBeUndefined();
  });

  test("explicit @default wins over @autoSet", async () => {
    const byName = await colsFor("onCreate", /* withExplicitDefault */ true);
    expect(byName.get("stamped_at")?.default).toEqual({ kind: "expr", value: "CURRENT_TIMESTAMP" });
  });
});

// ---------------------------------------------------------------------------
// Native SQL array columns are DERIVED from `isArray` (dbColumnType slim-and-derive
// Phase 1): the array-ness already lives on the field's `isArray` axis, so the DDL
// derives `text[]` / `uuid[]` directly — no `@dbColumnType` escape hatch. The
// removed `uuid_array` / `text_array` values now fail the loader (ERR_BAD_ATTR_VALUE).
// ---------------------------------------------------------------------------

describe("buildExpectedSchema — native array columns (derived from isArray)", () => {
  async function arrayCols() {
    const doc = { "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Bag", children: [
        { "source.rdb": {} },
        { "field.long": { name: "id" } },
        { "identity.primary": { "name": "id", "@fields": "id" } },
        { "field.uuid": { name: "memberIds", isArray: true } },
        { "field.string": { name: "tags", isArray: true } },
      ] } },
    ] } };
    const { root, errors } = await new MetaDataLoader().load([
      new InMemoryStringSource(JSON.stringify(doc)),
    ]);
    expect(errors).toHaveLength(0);
    return new Map((buildExpectedSchema(root).tables[0]?.columns ?? []).map((c) => [c.name, c]));
  }

  test("field.uuid isArray → uuid[]; field.string isArray → text[]", async () => {
    const byName = await arrayCols();
    expect(byName.get("member_ids")?.sqlType).toEqual({ kind: "array", element: { kind: "uuid" } });
    expect(byName.get("tags")?.sqlType).toEqual({ kind: "array", element: { kind: "text" } });
  });

  test("field.uuid scalar → uuid; field.string scalar (no maxLength) → text", async () => {
    const doc = { "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Scalars", children: [
        { "source.rdb": {} },
        { "field.long": { name: "id" } },
        { "identity.primary": { "name": "id", "@fields": "id" } },
        { "field.uuid": { name: "ownerId" } },
        { "field.string": { name: "label" } },
      ] } },
    ] } };
    const { root, errors } = await new MetaDataLoader().load([
      new InMemoryStringSource(JSON.stringify(doc)),
    ]);
    expect(errors).toHaveLength(0);
    const byName = new Map((buildExpectedSchema(root).tables[0]?.columns ?? []).map((c) => [c.name, c]));
    expect(byName.get("owner_id")?.sqlType).toEqual({ kind: "uuid" });
    expect(byName.get("label")?.sqlType).toEqual({ kind: "text" });
  });

  test("removed @dbColumnType:uuid_array / text_array now fail the loader (ERR_BAD_ATTR_VALUE)", async () => {
    for (const removed of ["uuid_array", "text_array"]) {
      const doc = { "metadata.root": { package: "acme", children: [
        { "object.entity": { name: "Bag", children: [
          { "field.long": { name: "id" } },
          { "identity.primary": { "name": "id", "@fields": "id" } },
          { "field.string": { name: "x", "@dbColumnType": removed } },
        ] } },
      ] } };
      const { errors } = await new MetaDataLoader().load([
        new InMemoryStringSource(JSON.stringify(doc)),
      ]);
      expect(errors.some((e) => (e as { code?: string }).code === "ERR_BAD_ATTR_VALUE")).toBe(true);
    }
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

  test("many-to-one relationship → FK on child table (association → restrict/cascade defaults)", () => {
    const weeks = snapshot.tables.find((t) => t.name === "weeks");
    expect(weeks?.foreignKeys).toEqual([
      {
        name: "weeks_program_id_fk",
        columns: ["program_id"],
        refTable: "programs",
        refColumns: ["id"],
        onDelete: "restrict",
        onUpdate: "cascade",
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

describe("buildExpectedSchema — SQLite float normalization (R6)", () => {
  async function loadInline(children: unknown[]) {
    const json = JSON.stringify({ "metadata.root": { package: "test", children } });
    const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
    if (result.errors.length > 0) {
      throw new Error(`Loader errors:\n${result.errors.map((e) => e.message).join("\n")}`);
    }
    return result.root;
  }

  test("field.float → sqlType {kind:'real'} under sqlite (real4 collapsed, no phantom diff)", async () => {
    const root = await loadInline([
      {
        "object.entity": {
          name: "Measurement",
          children: [
            { "source.rdb": { "@table": "measurements" } },
            { "field.long":  { name: "id" } },
            { "field.float": { name: "score" } },
            { "identity.primary": { "name": "id", "@fields": "id" } },
          ],
        },
      },
    ]);
    const snapshot = buildExpectedSchema(root, { dialect: "sqlite" });
    const scoreCol = snapshot.tables[0]?.columns.find((c) => c.name === "score");
    // SQLite has one float storage class; real4 must be collapsed to real so the
    // expected schema matches what the SQLite introspector produces ({kind:"real"}).
    expect(scoreCol?.sqlType).toEqual({ kind: "real" });
  });

  test("field.double → sqlType {kind:'real'} under sqlite (already real, unaffected)", async () => {
    const root = await loadInline([
      {
        "object.entity": {
          name: "Measurement",
          children: [
            { "source.rdb": { "@table": "measurements" } },
            { "field.long":   { name: "id" } },
            { "field.double": { name: "value" } },
            { "identity.primary": { "name": "id", "@fields": "id" } },
          ],
        },
      },
    ]);
    const snapshot = buildExpectedSchema(root, { dialect: "sqlite" });
    const valueCol = snapshot.tables[0]?.columns.find((c) => c.name === "value");
    expect(valueCol?.sqlType).toEqual({ kind: "real" });
  });

  test("field.float → sqlType {kind:'real4'} under postgres (Postgres fidelity preserved)", async () => {
    const root = await loadInline([
      {
        "object.entity": {
          name: "Measurement",
          children: [
            { "source.rdb": { "@table": "measurements" } },
            { "field.long":  { name: "id" } },
            { "field.float": { name: "score" } },
            { "identity.primary": { "name": "id", "@fields": "id" } },
          ],
        },
      },
    ]);
    const snapshot = buildExpectedSchema(root, { dialect: "postgres" });
    const scoreCol = snapshot.tables[0]?.columns.find((c) => c.name === "score");
    // Postgres can distinguish REAL (single) from DOUBLE PRECISION; real4 must not be collapsed.
    expect(scoreCol?.sqlType).toEqual({ kind: "real4" });
  });
});

describe("buildExpectedSchema — field.uuid (R6 Plan 2a)", () => {
  async function loadInline(children: unknown[]) {
    const json = JSON.stringify({ "metadata.root": { package: "test", children } });
    const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
    if (result.errors.length > 0) {
      throw new Error(`Loader errors:\n${result.errors.map((e) => e.message).join("\n")}`);
    }
    return result.root;
  }

  test("field.uuid → sqlType {kind:'uuid'} under postgres", async () => {
    const root = await loadInline([
      {
        "object.entity": {
          name: "Doc",
          children: [
            { "source.rdb": { "@table": "docs" } },
            { "field.uuid":   { name: "id" } },
            { "field.uuid":   { name: "ownerId" } },
            { "identity.primary": { "name": "id", "@fields": "id" } },
          ],
        },
      },
    ]);
    const snapshot = buildExpectedSchema(root, { dialect: "postgres", columnNamingStrategy: "literal" });
    const cols = snapshot.tables[0]?.columns ?? [];
    expect(cols.find((c) => c.name === "id")?.sqlType).toEqual({ kind: "uuid" });
    expect(cols.find((c) => c.name === "ownerId")?.sqlType).toEqual({ kind: "uuid" });
  });

  test("field.uuid → sqlType {kind:'text'} under sqlite (no native uuid; collapse → text)", async () => {
    const root = await loadInline([
      {
        "object.entity": {
          name: "Doc",
          children: [
            { "source.rdb": { "@table": "docs" } },
            { "field.uuid":   { name: "id" } },
            { "identity.primary": { "name": "id", "@fields": "id" } },
          ],
        },
      },
    ]);
    const snapshot = buildExpectedSchema(root, { dialect: "sqlite" });
    const idCol = snapshot.tables[0]?.columns.find((c) => c.name === "id");
    expect(idCol?.sqlType).toEqual({ kind: "text" });
  });

  test("field.uuid PK with @generation:uuid → identity 'uuid' (server-default gen_random_uuid)", async () => {
    const root = await loadInline([
      {
        "object.entity": {
          name: "Doc",
          children: [
            { "source.rdb": { "@table": "docs" } },
            { "field.uuid":   { name: "id" } },
            { "identity.primary": { "name": "id", "@fields": "id", "@generation": "uuid" } },
          ],
        },
      },
    ]);
    const snapshot = buildExpectedSchema(root, { dialect: "postgres", columnNamingStrategy: "literal" });
    const idCol = snapshot.tables[0]?.columns.find((c) => c.name === "id");
    expect(idCol?.sqlType).toEqual({ kind: "uuid" });
    expect(idCol?.identity).toBe("uuid");
  });
});

describe("buildExpectedSchema — @dbColumnType physical override (R6 Plan 2b)", () => {
  async function loadInline(children: unknown[]) {
    const json = JSON.stringify({ "metadata.root": { package: "test", children } });
    const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
    if (result.errors.length > 0) {
      throw new Error(`Loader errors:\n${result.errors.map((e) => e.message).join("\n")}`);
    }
    return result.root;
  }

  test("@dbColumnType:uuid on field.string → SqlType.uuid (native binding unchanged)", async () => {
    const root = await loadInline([
      {
        "object.entity": {
          name: "A",
          children: [
            { "source.rdb": { "@table": "a" } },
            { "field.long":   { name: "id" } },
            { "field.string": { name: "externalId", "@dbColumnType": "uuid" } },
            { "identity.primary": { "name": "id", "@fields": "id" } },
          ],
        },
      },
    ]);
    const snapshot = buildExpectedSchema(root, { dialect: "postgres", columnNamingStrategy: "literal" });
    const col = snapshot.tables[0]?.columns.find((c) => c.name === "externalId");
    expect(col?.sqlType).toEqual({ kind: "uuid" });
  });

  test("@dbColumnType:jsonb on field.string → SqlType.json", async () => {
    const root = await loadInline([
      {
        "object.entity": {
          name: "A",
          children: [
            { "source.rdb": { "@table": "a" } },
            { "field.long":   { name: "id" } },
            { "field.string": { name: "payload", "@dbColumnType": "jsonb" } },
            { "identity.primary": { "name": "id", "@fields": "id" } },
          ],
        },
      },
    ]);
    const snapshot = buildExpectedSchema(root, { dialect: "postgres", columnNamingStrategy: "literal" });
    const col = snapshot.tables[0]?.columns.find((c) => c.name === "payload");
    expect(col?.sqlType).toEqual({ kind: "json" });
  });

  test("field.map (scalar- and VO-valued) → SqlType.json single column (never text)", async () => {
    const root = await loadInline([
      { "object.value": { name: "Tool", children: [{ "field.string": { name: "n" } }] } },
      {
        "object.entity": {
          name: "A",
          children: [
            { "source.rdb": { "@table": "a" } },
            { "field.long":   { name: "id" } },
            { "field.map": { name: "labels", "@valueType": "string" } },   // scalar-valued
            { "field.map": { name: "tools", "@objectRef": "Tool" } },      // VO-valued
            { "identity.primary": { "name": "id", "@fields": "id" } },
          ],
        },
      },
    ]);
    const snapshot = buildExpectedSchema(root, { dialect: "postgres", columnNamingStrategy: "literal" });
    const cols = snapshot.tables.find((t) => t.name === "a")?.columns ?? [];
    expect(cols.find((c) => c.name === "labels")?.sqlType).toEqual({ kind: "json" });
    expect(cols.find((c) => c.name === "tools")?.sqlType).toEqual({ kind: "json" });
  });

  test("a plain field.timestamp is instant / tz-aware by default → SqlType.timestamp{withTimezone:true} (ADR-0036 Wave 2)", async () => {
    const root = await loadInline([
      {
        "object.entity": {
          name: "A",
          children: [
            { "source.rdb": { "@table": "a" } },
            { "field.long":      { name: "id" } },
            { "field.timestamp": { name: "recordedAt" } },
            { "identity.primary": { "name": "id", "@fields": "id" } },
          ],
        },
      },
    ]);
    const snapshot = buildExpectedSchema(root, { dialect: "postgres", columnNamingStrategy: "literal" });
    const col = snapshot.tables[0]?.columns.find((c) => c.name === "recordedAt");
    expect(col?.sqlType).toEqual({ kind: "timestamp", withTimezone: true });
  });

  test("field.timestamp @localTime:true opts into naive → withTimezone:false", async () => {
    const root = await loadInline([
      {
        "object.entity": {
          name: "A",
          children: [
            { "source.rdb": { "@table": "a" } },
            { "field.long":      { name: "id" } },
            { "field.timestamp": { name: "createdAt", "@localTime": true } },
            { "identity.primary": { "name": "id", "@fields": "id" } },
          ],
        },
      },
    ]);
    const snapshot = buildExpectedSchema(root, { dialect: "postgres", columnNamingStrategy: "literal" });
    const col = snapshot.tables[0]?.columns.find((c) => c.name === "createdAt");
    expect(col?.sqlType).toEqual({ kind: "timestamp", withTimezone: false });
  });
});

describe("buildExpectedSchema — identity.reference @enforce", () => {
  async function loadInline(children: unknown[]) {
    const json = JSON.stringify({ "metadata.root": { package: "test", children } });
    const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
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
            { "source.rdb": { "@table": "programs" } },
            { "field.long": { name: "id" } },
            { "identity.primary": { "name": "id", "@fields": "id" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Purchase",
          children: [
            { "source.rdb": { "@table": "purchases" } },
            { "field.long":   { name: "id" } },
            { "field.long":   { name: "programId" } },
            { "identity.primary":   { "name": "id", "@fields": "id" } },
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
            { "source.rdb": { "@table": "subscribers" } },
            { "field.long":   { name: "id" } },
            { "field.string": { name: "email" } },
            { "identity.primary":   { "name": "id", "@fields": "id" } },
            { "identity.secondary": { "name": "byEmail", "@fields": "email" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Purchase",
          children: [
            { "source.rdb": { "@table": "purchases" } },
            { "field.long":   { name: "id" } },
            { "field.string": { name: "customerEmail" } },
            { "identity.primary":   { "name": "id", "@fields": "id" } },
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
