// The `wire` project setting end to end (ADR-0019 Amendment 2): the options the generated routes
// pass (`decimalColumnsLine`, read from the root's wire format) evaluated and handed to
// runtime-ts's Hono mount over bun:sqlite, and the HTTP bodies it answers asserted.
//
// `amount` is a TEXT column here so a row holds the string a Postgres or MySQL driver would hand
// back; `weight` is a NUMERIC column so a row holds the number SQLite or D1 would.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, integer, text, numeric } from "drizzle-orm/sqlite-core";
import { MetaDataLoader, InMemoryStringSource, type MetaObject, type WireFormat } from "@metaobjectsdev/metadata";
import { mountCrudRoutes } from "@metaobjectsdev/runtime-ts/hono";
import { renderZodValidators, renderInsertSchemaOnly } from "../src/templates/zod-validators.js";
import { renderFilterAllowlist } from "../src/templates/filter-allowlist.js";
import { decimalColumnsLine } from "../src/api-surface.js";

const MODEL = {
  "metadata.root": { package: "ledger", children: [
    { "object.value": { name: "Money", children: [
      { "field.string": { name: "label" } },
      { "field.decimal": { name: "amount", "@precision": 9, "@scale": 4 } },
      { "field.string": { name: "note" } },
    ]}},
    { "object.entity": { name: "Entry", children: [
      { "source.rdb": { "@table": "entries" } },
      { "field.long": { name: "id" } },
      { "field.decimal": { name: "amount", "@precision": 9, "@scale": 4 } },
      { "field.decimal": { name: "weight" } },
      { "field.decimal": { name: "readings", isArray: true, "@precision": 9, "@scale": 4 } },
      { "field.object": { name: "total", "@objectRef": "Money", "@storage": "jsonb" } },
      { "field.object": { name: "lines", "@objectRef": "Money", isArray: true, "@storage": "jsonb" } },
      { "field.map": { name: "byKey", "@objectRef": "Money" } },
      { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
    ]}},
  ]},
};

const entries = sqliteTable("entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  amount: text("amount"),
  weight: numeric("weight"),
  readings: text("readings", { mode: "json" }),
  total: text("total", { mode: "json" }),
  lines: text("lines", { mode: "json" }),
  byKey: text("by_key", { mode: "json" }),
});

const dir = mkdtempSync(join(import.meta.dir, "tmp-wire-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function execute(name: string, source: string): Promise<Record<string, unknown>> {
  const file = join(dir, `${name}.ts`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
  return import(pathToFileURL(file).href);
}

let seq = 0;
/** A server mounted with exactly the wire options the generated route would pass under `wire`. */
async function serverFor(wire: WireFormat | undefined): Promise<{ app: Hono; sqlite: Database; options: string }> {
  const { root, errors } = await new MetaDataLoader({ strict: true }).load([
    new InMemoryStringSource(JSON.stringify(MODEL), { id: "ledger.json" }),
  ]);
  expect(errors).toEqual([]);
  if (wire !== undefined) root.wireFormat = wire;
  const entry = root.objects().find((o) => o.name === "Entry") as MetaObject;
  const money = root.objects().find((o) => o.name === "Money") as MetaObject;
  const n = seq++;
  await execute(`s${n}/Money`, renderInsertSchemaOnly(money).toString());
  const schemas = await execute(`s${n}/schemas`, renderZodValidators(entry).toString());
  const allowlists = await execute(`s${n}/allowlist`, renderFilterAllowlist(entry).toString());
  // The generated route's option lines, evaluated as the object literal they are.
  const options = decimalColumnsLine(entry, "");
  const wireOptions = new Function(`return {${options}}`)() as Record<string, unknown>;
  const sqlite = new Database(":memory:");
  sqlite.run("CREATE TABLE entries (id INTEGER PRIMARY KEY AUTOINCREMENT, amount TEXT, weight NUMERIC, readings TEXT, total TEXT, lines TEXT, by_key TEXT)");
  const app = new Hono();
  mountCrudRoutes({
    app, path: "/entries", db: drizzle(sqlite), table: entries,
    insertSchema: schemas["EntryInsertSchema"] as never,
    updateSchema: schemas["EntryUpdateSchema"] as never,
    filterAllowlist: allowlists["EntryFilterAllowlist"] as never,
    sortAllowlist: {}, dialect: "sqlite",
    ...wireOptions,
  });
  return { app, sqlite, options };
}

const seed = (sqlite: Database): void => {
  sqlite.run(
    `INSERT INTO entries (amount, weight, readings, total, lines, by_key) VALUES (?, ?, ?, ?, ?, ?)`,
    [
      "12.50", 0.1 + 0.2, '["1.10","2"]',
      '{"label":"a","amount":null}',
      '[{"label":null,"amount":"1.5"},{"amount":"2"}]',
      '{"k":{"label":null,"amount":"3"}}',
    ],
  );
};

const get = async (app: Hono): Promise<Record<string, unknown>> => {
  const res = await app.request("/entries/1");
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
};

describe("wire.decimals", () => {
  test("native (the default): a driver string is written as it is, a SQLite number at 15 digits, an array element-wise", async () => {
    const { app, sqlite, options } = await serverFor(undefined);
    expect(options).toContain('decimalColumns: ["amount","weight","readings"]');
    expect(options).not.toContain("decimalWire");
    seed(sqlite);
    const row = await get(app);
    expect(row["amount"]).toBe("12.50");
    expect(row["weight"]).toBe("0.3");
    expect(row["readings"]).toEqual(["1.10", "2"]);
  });

  test("string: the canonical form, exactly as 1.1.1", async () => {
    const { app, sqlite, options } = await serverFor({ decimals: "string", nullMembers: "native" });
    expect(options).toContain('decimalWire: "string"');
    seed(sqlite);
    const row = await get(app);
    expect(row["amount"]).toBe("12.5");
    expect(row["weight"]).toBe("0.3");
    expect(row["readings"]).toEqual(["1.1", "2"]);
  });

  test("input rules hold under native: a number is accepted, over-scale and garbage are 400", async () => {
    const { app } = await serverFor(undefined);
    const post = (body: unknown) =>
      app.request("/entries", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const ok = await post({ amount: 0.5, weight: "1.50" });
    expect(ok.status).toBe(201);
    for (const amount of ["12abc", "0.12345", "100000", true]) {
      const res = await post({ amount });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("validation");
    }
  });
});

describe("wire.nullMembers", () => {
  test("native (the default): a stored null is written, an absent member stays absent", async () => {
    const { app, sqlite, options } = await serverFor(undefined);
    expect(options).not.toContain("nullMembers");
    seed(sqlite);
    const row = await get(app);
    expect(row["total"]).toEqual({ label: "a", amount: null });
    expect(row["lines"]).toEqual([{ label: null, amount: "1.5" }, { amount: "2" }]);
    expect(row["byKey"]).toEqual({ k: { label: null, amount: "3" } });
  });

  test("omit: null members are dropped from a value object, an array of them and a map of them", async () => {
    const { app, sqlite, options } = await serverFor({ decimals: "native", nullMembers: "omit" });
    expect(options).toContain('nullMembers: "omit"');
    seed(sqlite);
    const row = await get(app);
    expect(row["total"]).toEqual({ label: "a" });
    expect(row["lines"]).toEqual([{ amount: "1.5" }, { amount: "2" }]);
    expect(row["byKey"]).toEqual({ k: { amount: "3" } });
  });

  test("emit: every declared member is present, null when unset", async () => {
    const { app, sqlite, options } = await serverFor({ decimals: "native", nullMembers: "emit" });
    expect(options).toContain('nullMembers: "emit"');
    seed(sqlite);
    const row = await get(app);
    expect(row["total"]).toEqual({ label: "a", amount: null, note: null });
    expect(row["lines"]).toEqual([{ label: null, amount: "1.5", note: null }, { label: null, amount: "2", note: null }]);
    expect(row["byKey"]).toEqual({ k: { label: null, amount: "3", note: null } });
    expect(row["id"]).toBe(1);
  });

  test("a top-level null field is unchanged in every mode", async () => {
    for (const nullMembers of ["native", "emit", "omit"] as const) {
      const { app, sqlite } = await serverFor({ decimals: "native", nullMembers });
      sqlite.run(`INSERT INTO entries (amount) VALUES (NULL)`);
      const row = await get(app);
      expect(row["amount"]).toBeNull();
      expect(row["total"]).toBeNull();
    }
  });
});
