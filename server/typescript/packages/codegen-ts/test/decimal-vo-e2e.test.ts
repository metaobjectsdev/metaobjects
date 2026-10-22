// A field.decimal inside a jsonb value object follows the top-level decimal rule (captain ruling
// C1, ADR-0019 Amendment 1): a string or an exact JSON number in, checked against the VO field's
// @precision / @scale, stored and answered as the canonical string. Generated code executed.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { MetaDataLoader, InMemoryStringSource, type MetaObject } from "@metaobjectsdev/metadata";
import { mountCrudRoutes } from "@metaobjectsdev/runtime-ts/hono";
import { renderZodValidators, renderInsertSchemaOnly } from "../src/templates/zod-validators.js";
import { renderFilterAllowlist } from "../src/templates/filter-allowlist.js";

const MODEL = {
  "metadata.root": { package: "ledger", children: [
    { "object.value": { name: "Money", children: [
      { "field.string": { name: "label" } },
      { "field.decimal": { name: "amount", "@precision": 9, "@scale": 4, "@required": true } },
      { "field.decimal": { name: "free" } },
    ]}},
    { "object.entity": { name: "Invoice", children: [
      { "source.rdb": { "@table": "invoices" } },
      { "field.long": { name: "id" } },
      { "field.object": { name: "total", "@objectRef": "Money", "@storage": "jsonb" } },
      { "field.object": { name: "lines", "@objectRef": "Money", isArray: true, "@storage": "jsonb" } },
      { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
    ]}},
  ]},
};

const invoices = sqliteTable("invoices", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  total: text("total", { mode: "json" }),
  lines: text("lines", { mode: "json" }),
});

const dir = mkdtempSync(join(import.meta.dir, "tmp-decimal-vo-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function execute(name: string, source: string): Promise<Record<string, unknown>> {
  const file = join(dir, `${name}.ts`);
  writeFileSync(file, source);
  return import(pathToFileURL(file).href);
}

let app: Hono;
beforeAll(async () => {
  const { root, errors } = await new MetaDataLoader({ strict: true }).load([
    new InMemoryStringSource(JSON.stringify(MODEL), { id: "ledger.json" }),
  ]);
  expect(errors).toEqual([]);
  const money = root.objects().find((o) => o.name === "Money") as MetaObject;
  const invoice = root.objects().find((o) => o.name === "Invoice") as MetaObject;
  const moneyText = renderInsertSchemaOnly(money).toString();
  expect(moneyText).toContain("function decimalWrite");
  await execute("Money", moneyText);
  const schemas = await execute("schemas", renderZodValidators(invoice).toString());
  const allowlists = await execute("allowlist", renderFilterAllowlist(invoice).toString());
  const sqlite = new Database(":memory:");
  sqlite.run("CREATE TABLE invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, total TEXT, lines TEXT)");
  app = new Hono();
  mountCrudRoutes({
    app, path: "/invoices", db: drizzle(sqlite), table: invoices,
    insertSchema: schemas["InvoiceInsertSchema"] as never,
    updateSchema: schemas["InvoiceUpdateSchema"] as never,
    filterAllowlist: allowlists["InvoiceFilterAllowlist"] as never,
    sortAllowlist: {}, dialect: "sqlite",
  });
});

const post = (body: unknown) =>
  app.request("/invoices", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("a decimal inside a jsonb value object", () => {
  test("a string and an exact number are stored and answered as the canonical string", async () => {
    const res = await post({ total: { amount: 100.25, free: "1.50" }, lines: [{ amount: "2.5000" }, { amount: 0.3 }] });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { total: unknown; lines: unknown };
    expect(body.total).toEqual({ amount: "100.25", free: "1.5" });
    expect(body.lines).toEqual([{ amount: "2.5" }, { amount: "0.3" }]);
  });

  test("a value the member's @precision / @scale cannot hold is a 400", async () => {
    for (const amount of ["0.12345", "100000", "12abc", true]) {
      expect((await post({ total: { amount } })).status).toBe(400);
      expect((await post({ lines: [{ amount }] })).status).toBe(400);
    }
  });

  test("a number a double cannot hold exactly is refused, not rounded", async () => {
    const res = await post({ total: { amount: 1, free: 1234567890.123456789 } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("validation");
    // the same digits as a string stay exact
    expect((await post({ total: { amount: 1, free: "1234567890.123456789" } })).status).toBe(201);
  });
});
