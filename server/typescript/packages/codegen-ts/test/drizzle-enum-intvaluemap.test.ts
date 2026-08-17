// Task 5 — an int-backed field.enum's symbol<->int codec lives in the COLUMN
// definition, as a generated Drizzle customType. Nothing downstream changes:
// db.insert().values() encodes on bind, a selected row decodes on read, and a
// filter comparison encodes because Drizzle binds through the column type.
//
// Chosen over a Zod write-transform + generated read-decode because TS's
// generated queries return raw Drizzle rows and have NO decode seam — that route
// meant inventing one and wrapping every generated read. This is also the direct
// analogue of the other four ports' codec seams (EF Core HasConversion, OMDB
// JdbcFieldCodec, Exposed customEnumeration, Python ObjectManager coercion).

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { renderDrizzleSchema } from "../src/templates/drizzle-schema.js";
import { makeRenderContext } from "../src/render-context.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";
import type { Dialect } from "../src/metaobjects-config.js";

const VALUES = ["DRAFT", "PUBLISHED", "ARCHIVED"];
const INT_MAP = { DRAFT: 0, PUBLISHED: 5, ARCHIVED: 9 };

async function emit(statusDecl: Record<string, unknown>, extraRoots: unknown[] = [], dialect: Dialect = "postgres") {
  const json = JSON.stringify({
    "metadata.root": {
      children: [
        ...extraRoots,
        {
          "object.entity": {
            name: "Order",
            children: [
              { "field.long": { name: "id" } },
              { "field.enum": statusDecl },
              { "source.rdb": { name: "src", "@table": "orders" } },
              { "identity.primary": { name: "pk", "@fields": ["id"] } },
            ],
          },
        },
      ],
    },
  });
  const res = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  expect(res.errors).toEqual([]);
  const ctx = makeRenderContext({
    dialect, loadedRoot: res.root, outDir: "/x", dbImport: "~/db",
    pkMap: buildPkMap(res.root), relationMap: buildRelationMap(res.root),
  });
  return renderDrizzleSchema(res.root.findObject("Order")!, ctx).toString();
}

describe("Drizzle codegen — int-backed field.enum customType", () => {
  test("emits the two lookup maps and a customType whose column is integer", async () => {
    const out = await emit({ name: "status", "@values": VALUES, "@intValueMap": INT_MAP });
    expect(out).toContain('const STATUS_TO_INT = { "DRAFT": 0, "PUBLISHED": 5, "ARCHIVED": 9 }');
    expect(out).toContain('const STATUS_FROM_INT: Record<number, "DRAFT" | "PUBLISHED" | "ARCHIVED">');
    expect(out).toContain('dataType: () => "integer"');
    expect(out).toContain("toDriver: (value) => STATUS_TO_INT[value]");
    // The column uses the local const, NOT a drizzle `integer(...)` call.
    expect(out).toContain('statusIntEnum("status")');
  });

  test("the TS-facing data type stays the member-string union, never number", async () => {
    const out = await emit({ name: "status", "@values": VALUES, "@intValueMap": INT_MAP });
    expect(out).toContain('data: "DRAFT" | "PUBLISHED" | "ARCHIVED"; driverData: number');
  });

  test("an unmapped stored integer throws rather than yielding undefined", async () => {
    const out = await emit({ name: "status", "@values": VALUES, "@intValueMap": INT_MAP });
    expect(out).toContain("unmapped statusIntEnum value");
  });

  test("customType is imported from the dialect's core module", async () => {
    const pg = await emit({ name: "status", "@values": VALUES, "@intValueMap": INT_MAP }, [], "postgres");
    expect(pg).toContain("drizzle-orm/pg-core");
    const sqlite = await emit({ name: "status", "@values": VALUES, "@intValueMap": INT_MAP }, [], "sqlite");
    expect(sqlite).toContain("drizzle-orm/sqlite-core");
  });

  test("the codec is emitted for a map INHERITED from a shared declaration (#246 shape)", async () => {
    const out = await emit({ name: "status", extends: "Status" }, [
      { "field.enum": { name: "Status", abstract: true, "@values": VALUES, "@intValueMap": INT_MAP } },
    ]);
    expect(out).toContain("const statusIntEnum = ");
    expect(out).toContain("STATUS_TO_INT[value]");
  });

  test("a string-backed enum emits NO codec at all (byte-identical to today)", async () => {
    const out = await emit({ name: "status", "@values": VALUES });
    expect(out).not.toContain("customType");
    expect(out).not.toContain("STATUS_TO_INT");
    expect(out).toContain('text("status"');
  });
});
