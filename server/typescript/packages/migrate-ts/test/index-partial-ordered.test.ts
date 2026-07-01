import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../src/expected-schema.js";
import { emit } from "../src/emit/index.js";
import { diff } from "../src/diff/index.js";
import type { SchemaSnapshot, TableDescriptor } from "../src/types.js";

// Partial (`@where`) + ordered (`@orders`) secondary-index support: the metamodel
// declares them, buildExpectedSchema lifts them onto the IndexDescriptor, emit
// renders `… DESC` / `WHERE (…)`, and diff compares them (ordering positionally;
// predicate via expression normalization).

async function load(json: string): Promise<MetaData> {
  const r = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  return r.root;
}

const MODEL = JSON.stringify({
  "metadata.root": {
    "children": [
      {
        "object.entity": {
          "name": "Notification",
          "children": [
            { "field.string": { "name": "id" } },
            { "field.string": { "name": "user_id" } },
            { "field.timestamp": { "name": "created_at" } },
            { "field.timestamp": { "name": "delivered_at" } },
            { "source.rdb": { "name": "src", "@table": "notifications" } },
            { "identity.primary": { "name": "pk", "@fields": ["id"] } },
            {
              "index.lookup": {
                "name": "notifications_pending_idx",
                "@fields": ["user_id", "created_at"],
                "@orders": ["asc", "desc"],
                "@where": "delivered_at IS NULL",
              },
            },
          ],
        },
      },
    ],
  },
});

async function pendingIndex() {
  const root = await load(MODEL);
  const snapshot = buildExpectedSchema(root, { dialect: "postgres" });
  const table = snapshot.tables.find((t) => t.name === "notifications")!;
  return { snapshot, index: table.indexes.find((i) => i.name === "notifications_pending_idx")! };
}

describe("secondary index — partial (@where) + ordered (@orders)", () => {
  test("buildExpectedSchema lifts @orders and @where onto the descriptor", async () => {
    const { index } = await pendingIndex();
    expect(index.columns).toEqual(["user_id", "created_at"]);
    expect(index.orders).toEqual(["asc", "desc"]);
    expect(index.where).toBe("delivered_at IS NULL");
    expect(index.unique).toBe(false);
  });

  test("emit renders DESC keys and a WHERE predicate", async () => {
    const { snapshot } = await pendingIndex();
    const sql = emit(
      (await diff({ expected: snapshot, actual: { tables: [], views: [] } })).changes,
      { dialect: "postgres" },
    ).up;
    expect(sql).toContain(
      'CREATE INDEX "notifications_pending_idx" ON "notifications" ("user_id", "created_at" DESC) WHERE (delivered_at IS NULL);',
    );
  });

  test("diff: an all-ascending model index matches an actual index with no orders", async () => {
    // orders:["asc"] must be treated as the default (no DESC) — equal to an actual
    // index that carries no `orders` at all.
    const plain = (cols: string[]): TableDescriptor => ({
      name: "t",
      columns: cols.map((c) => ({ name: c, sqlType: { kind: "text" }, nullable: true })),
      indexes: [{ name: "ix", columns: cols, unique: false, orders: ["asc", "asc"] }],
      foreignKeys: [],
      primaryKey: [],
      checks: [],
    });
    const actual: SchemaSnapshot = {
      tables: [{ ...plain(["a", "b"]), indexes: [{ name: "ix", columns: ["a", "b"], unique: false }] }],
      views: [],
    };
    const result = await diff({ expected: { tables: [plain(["a", "b"])], views: [] }, actual });
    expect(result.changes.filter((c) => c.kind.endsWith("-index"))).toEqual([]);
  });

  test("diff: a DESC change is detected", async () => {
    const tbl = (orders: ("asc" | "desc")[]): TableDescriptor => ({
      name: "t",
      columns: [{ name: "ts", sqlType: { kind: "timestamp", withTimezone: true }, nullable: true }],
      indexes: [{ name: "ix", columns: ["ts"], unique: false, orders }],
      foreignKeys: [],
      primaryKey: [],
      checks: [],
    });
    const result = await diff({
      expected: { tables: [tbl(["desc"])], views: [] },
      actual: { tables: [tbl(["asc"])], views: [] },
      allow: { dropIndex: true },
    });
    const idxChanges = result.changes.filter((c) => c.kind.endsWith("-index"));
    expect(idxChanges.map((c) => c.kind).sort()).toEqual(["add-index", "drop-index"]);
  });

  test("diff: a partial predicate matches across PG's normalization", async () => {
    const tbl = (where: string): TableDescriptor => ({
      name: "t",
      columns: [
        { name: "user_id", sqlType: { kind: "text" }, nullable: true },
        { name: "delivered_at", sqlType: { kind: "timestamp", withTimezone: true }, nullable: true },
      ],
      indexes: [{ name: "ix", columns: ["user_id"], unique: false, where }],
      foreignKeys: [],
      primaryKey: [],
      checks: [],
    });
    // Authored vs PG's introspected/parenthesized form → equal after normalization.
    const result = await diff({
      expected: { tables: [tbl("delivered_at IS NULL")], views: [] },
      actual: { tables: [tbl("(delivered_at IS NULL)")], views: [] },
    });
    expect(result.changes.filter((c) => c.kind.endsWith("-index"))).toEqual([]);
  });

  test("diff: adding a WHERE to a previously-full index is detected", async () => {
    const tbl = (where?: string): TableDescriptor => ({
      name: "t",
      columns: [{ name: "user_id", sqlType: { kind: "text" }, nullable: true }],
      indexes: [{ name: "ix", columns: ["user_id"], unique: false, ...(where ? { where } : {}) }],
      foreignKeys: [],
      primaryKey: [],
      checks: [],
    });
    const result = await diff({
      expected: { tables: [tbl("user_id IS NOT NULL")], views: [] },
      actual: { tables: [tbl(undefined)], views: [] },
      allow: { dropIndex: true },
    });
    const idxChanges = result.changes.filter((c) => c.kind.endsWith("-index"));
    expect(idxChanges.map((c) => c.kind).sort()).toEqual(["add-index", "drop-index"]);
  });
});
