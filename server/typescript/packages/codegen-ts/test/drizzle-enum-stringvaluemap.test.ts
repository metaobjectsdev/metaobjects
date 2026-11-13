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

const VALUES = ["Draft", "Published"];
const STORED = { Draft: "draft", Published: "published" };

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
      expect(out).toContain('const STATUS_TO_STORED = { "Draft": "draft", "Published": "published" }');
      expect(out).toContain('const STATUS_FROM_STORED: Record<string, "Draft" | "Published"> = { "draft": "Draft", "published": "Published" }');
      expect(out).toContain('dataType: () => "text"');
      expect(out).toContain('statusStoredEnum("status")');
      expect(out).toContain("IN ('draft', 'published')");
    });
  }

  test("a sized column is the varchar(n) meta migrate creates", async () => {
    const out = await emit({ name: "status", "@values": VALUES, "@stringValueMap": STORED, "@maxLength": 12 });
    expect(out).toContain('dataType: () => "varchar(12)"');
  });
});

// rc.21 fix round (I1): sibling TPH subtypes declaring one column with different @values each
// get their own enum CHECK, guarded by their discriminator value, as `meta migrate` derives it.
describe("Drizzle codegen — TPH siblings sharing a column with different @values", () => {
  test("each owner's CHECK is guarded by its discriminator value", async () => {
    const json = JSON.stringify({ "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Device", "@discriminator": "kind", children: [
        { "source.rdb": { "@table": "devices" } },
        { "field.long": { name: "id" } },
        { "field.enum": { name: "kind", "@values": ["METER", "SWITCH"] } },
        { "identity.primary": { name: "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "Meter", extends: "Device", "@discriminatorValue": "METER", children: [
        { "field.enum": { name: "grade", "@values": ["A", "B"] } } ] } },
      { "object.entity": { name: "Switch", extends: "Device", "@discriminatorValue": "SWITCH", children: [
        { "field.enum": { name: "grade", "@values": ["X", "Y"] } } ] } } ] } });
    const res = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
    expect(res.errors).toEqual([]);
    const ctx = makeRenderContext({
      dialect: "postgres", loadedRoot: res.root, outDir: "/x", dbImport: "~/db",
      pkMap: buildPkMap(res.root), relationMap: buildRelationMap(res.root),
    });
    const out = renderDrizzleSchema(res.root.findObject("Device")!, ctx).toString();
    expect(out).toContain(`"devices_meter_grade_chk"`);
    expect(out).toContain(`("kind" <> 'METER') OR (grade IN ('A', 'B'))`);
    expect(out).toContain(`"devices_switch_grade_chk"`);
    expect(out).not.toContain(`"devices_grade_chk"`);
  });
});

// rc.21 part B (N1): two different CHECKs under one name are refused on Postgres, which requires
// unique constraint names, as `meta migrate` refuses them; SQLite accepts and enforces both.
describe("Drizzle codegen — two CHECKs under one name", () => {
  async function render(dialect: Dialect) {
    const json = JSON.stringify({ "metadata.root": { children: [ { "object.entity": { name: "Order", children: [
      { "field.long": { name: "id" } },
      { "field.enum": { name: "status", "@values": ["A", "B"], "@constraintName": "orders_state_chk" } },
      { "field.enum": { name: "phase", "@values": ["X", "Y"], "@constraintName": "orders_state_chk" } },
      { "source.rdb": { name: "src", "@table": "orders" } },
      { "identity.primary": { name: "pk", "@fields": ["id"] } } ] } } ] } });
    const res = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
    expect(res.errors).toEqual([]);
    const ctx = makeRenderContext({ dialect, loadedRoot: res.root, outDir: "/x", dbImport: "~/db",
      pkMap: buildPkMap(res.root), relationMap: buildRelationMap(res.root) });
    return () => renderDrizzleSchema(res.root.findObject("Order")!, ctx).toString();
  }
  test("refused on Postgres", async () => {
    expect(await render("postgres")).toThrow(/both named 'orders_state_chk'.*Postgres requires/);
  });
  test("both kept on SQLite", async () => {
    const out = (await render("sqlite"))();
    expect(out.match(/"orders_state_chk"/g)?.length).toBe(2);
  });
});
