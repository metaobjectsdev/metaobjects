// rc.21 — a string-stored field.enum with @stringValueMap: its member<->stored-string codec lives
// in the COLUMN, as the int-backed codec does (drizzle-enum-intvaluemap.test.ts), and its CHECK
// lists the stored strings, as `meta migrate` does.
//
// (The int-backed note follows.) Task 5 — an int-backed field.enum's symbol<->int codec lives in the COLUMN
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

const VALUES = ["Pending", "Delivered"];
const STORED = { Pending: "pending", Delivered: "delivered" };

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

describe("Drizzle codegen — @stringValueMap field.enum customType", () => {
  for (const dialect of ["postgres", "sqlite"] as const) {
    test(`maps member <-> stored string at the column, and the CHECK lists the stored strings (${dialect})`, async () => {
      const out = await emit({ name: "status", "@values": VALUES, "@stringValueMap": STORED }, [], dialect);
      expect(out).toContain('const STATUS_TO_STORED = { "Pending": "pending", "Delivered": "delivered" }');
      expect(out).toContain('const STATUS_FROM_STORED: Record<string, "Pending" | "Delivered"> = { "pending": "Pending", "delivered": "Delivered" }');
      expect(out).toContain('dataType: () => "text"');
      expect(out).toContain('statusStoredEnum("status")');
      expect(out).toContain("IN ('pending', 'delivered')");
    });
  }

  test("a sized column is the varchar(n) meta migrate creates", async () => {
    const out = await emit({ name: "status", "@values": VALUES, "@stringValueMap": STORED, "@maxLength": 12 });
    expect(out).toContain('dataType: () => "varchar(12)"');
  });
});
