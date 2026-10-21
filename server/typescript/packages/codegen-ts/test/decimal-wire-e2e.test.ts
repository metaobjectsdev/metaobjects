// A field.decimal end to end on SQLite, GENERATED code executed (ADR-0019 Amendment 1).
//
// The Zod module and the filter allowlist rendered from metadata, mounted with runtime-ts's Hono
// helper over bun:sqlite with the `decimalColumns` option the generated route passes. Covers the
// write rule (W2 accept, W3 range), the canonical read (W1) and the 15-digit rendering of a
// double (W4) - none of which the Postgres-backed lanes can see, since SQLite is where a decimal
// is a double. Exactness beyond 15 digits is the Postgres and MySQL lanes' to prove.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, integer, text, numeric } from "drizzle-orm/sqlite-core";
import { MetaDataLoader, InMemoryStringSource, type MetaObject } from "@metaobjectsdev/metadata";
import { mountCrudRoutes } from "@metaobjectsdev/runtime-ts/hono";
import { renderZodValidators } from "../src/templates/zod-validators.js";
import { renderFilterAllowlist } from "../src/templates/filter-allowlist.js";
import { decimalColumnsLine, decimalFieldNames } from "../src/api-surface.js";

const MODEL = {
  "metadata.root": { package: "ledger", children: [
    { "object.entity": { name: "Entry", children: [
      { "source.rdb": { "@table": "entries" } },
      { "field.long": { name: "id" } },
      { "field.string": { name: "bucket", "@required": true, "@filterable": true } },
      { "field.decimal": { name: "amount", "@precision": 9, "@scale": 4, "@filterable": true, "@sortable": true } },
      { "field.decimal": { name: "weight", "@required": true } },
      { "field.decimal": { name: "readings", isArray: true, "@precision": 9, "@scale": 4 } },
      { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
    ]}},
  ]},
};

const entries = sqliteTable("entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  bucket: text("bucket").notNull(),
  amount: numeric("amount"),
  weight: numeric("weight").notNull(),
  readings: text("readings", { mode: "json" }),
});

const dir = mkdtempSync(join(import.meta.dir, "tmp-decimal-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function execute(name: string, source: string): Promise<Record<string, unknown>> {
  const file = join(dir, `${name}.ts`);
  writeFileSync(file, source);
  return import(pathToFileURL(file).href);
}

let app: Hono;
let entry: MetaObject;
let moduleText: string;
let sqlite: Database;
beforeAll(async () => {
  const { root, errors } = await new MetaDataLoader({ strict: true }).load([
    new InMemoryStringSource(JSON.stringify(MODEL), { id: "ledger.json" }),
  ]);
  expect(errors).toEqual([]);
  entry = root.objects().find((o) => o.name === "Entry") as MetaObject;
  moduleText = renderZodValidators(entry).toString();
  const schemas = await execute("schemas", moduleText);
  const allowlists = await execute("allowlist", renderFilterAllowlist(entry).toString());

  sqlite = new Database(":memory:");
  sqlite.run("CREATE TABLE entries (id INTEGER PRIMARY KEY AUTOINCREMENT, bucket TEXT NOT NULL, amount NUMERIC, weight NUMERIC NOT NULL, readings TEXT)");
  app = new Hono();
  mountCrudRoutes({
    app, path: "/entries", db: drizzle(sqlite), table: entries,
    insertSchema: schemas["EntryInsertSchema"] as never,
    updateSchema: schemas["EntryUpdateSchema"] as never,
    filterAllowlist: allowlists["EntryFilterAllowlist"] as never,
    sortAllowlist: {}, dialect: "sqlite",
    decimalColumns: decimalFieldNames(entry),
  });
});

const post = (body: unknown) =>
  app.request("/entries", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("generated decimal write schema and route, SQLite", () => {
  test("the module carries one local helper, and imports nothing from MetaObjects", () => {
    expect(moduleText.match(/function decimalWrite/g)?.length).toBe(1);
    expect(moduleText).not.toContain("@metaobjectsdev");
  });

  test("the route is given every decimal field name", () => {
    expect(decimalFieldNames(entry)).toEqual(["amount", "weight", "readings"]);
    expect(decimalColumnsLine(entry, "    ")).toBe('\n    decimalColumns: ["amount","weight","readings"],');
  });

  test("a string and a number are accepted, and answered as the canonical string", async () => {
    for (const [sent, wire] of [["0.1", "0.1"], [0.3, "0.3"], ["100.2500", "100.25"], ["1.5e1", "15"], ["-0.0", "0"]] as const) {
      const res = await post({ bucket: "a", amount: sent, weight: "1" });
      expect(res.status).toBe(201);
      expect(((await res.json()) as { amount: unknown }).amount).toBe(wire);
    }
  });

  test("a required decimal reads back canonical too", async () => {
    const res = await post({ bucket: "w", weight: "2.50" });
    expect(((await res.json()) as { weight: unknown }).weight).toBe("2.5");
  });

  test("a value the column cannot hold, or that is not a number, is a 400", async () => {
    for (const amount of ["12abc", "NaN", "0.12345", "100000", "1e999999999", true, {}]) {
      const res = await post({ bucket: "bad", amount, weight: "1" });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("validation");
    }
  });

  test("a decimal list answers strings, never numbers, and filters by number", async () => {
    const rows = (await (await app.request("/entries?filter[bucket][eq]=a")).json()) as Array<{ amount: unknown }>;
    expect(rows.map((r) => r.amount)).toEqual(["0.1", "0.3", "100.25", "15", "0"]);
    const gt = (await (await app.request("/entries?filter[bucket][eq]=a&filter[amount][gt]=15")).json()) as Array<{ amount: unknown }>;
    expect(gt.map((r) => r.amount)).toEqual(["100.25"]);
  });

  test("a decimal array is written and read element by element", async () => {
    const res = await post({ bucket: "arr", weight: "1", readings: ["100.2500", 0.3, "1.5e1"] });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { readings: unknown }).readings).toEqual(["100.25", "0.3", "15"]);
    for (const readings of [["0.12345"], ["12abc"]]) {
      expect((await post({ bucket: "arr", weight: "1", readings })).status).toBe(400);
    }
  });

  test("a decimal array the database holds in another spelling is answered canonical", async () => {
    sqlite.run(`INSERT INTO entries (bucket, weight, readings) VALUES ('raw', 1, '["100.5000", 0.30000000000000004, "-0.0"]')`);
    const rows = (await (await app.request("/entries?filter[bucket][eq]=raw")).json()) as Array<{ readings: unknown }>;
    expect(rows.map((r) => r.readings)).toEqual([["100.5", "0.3", "0"]]);
  });
});
