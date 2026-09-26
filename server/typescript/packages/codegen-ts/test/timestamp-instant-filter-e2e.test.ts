// A zone-aware field.timestamp given a value with no zone, end to end on SQLite.
//
// Cold review of 1.0.9-rc.4: POST `"dueAt":"2026-10-06"` stored `2026-10-06`, `"2026-10-06T09:00"`
// stored `2026-10-06T09:00`, and `GET /rentals?filter[dueAt][gte]=2026-10-06T00:00:00Z` then
// omitted the date-only row — SQLite compares the TEXT column as text. A default timestamp is
// an instant whose wire form is "always UTC" (docs/features/api-contract.md, "Type
// encodings"; ADR-0036 Wave 2); only `@localTime` is a wall clock. So the generated write
// schema now reads a zoneless value as UTC and a date alone as midnight UTC, and the
// generated allowlist marks the field `instant` so runtime-ts reads a filter bound the same
// way. An @localTime field keeps what was sent, on both paths.
//
// Everything here is the GENERATED code, executed: the Zod module and the filter allowlist
// rendered from metadata, mounted with runtime-ts's Hono helper over bun:sqlite.

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
import { renderZodValidators } from "../src/templates/zod-validators.js";
import { renderFilterAllowlist } from "../src/templates/filter-allowlist.js";

const MODEL = {
  "metadata.root": { package: "rentals", children: [
    { "object.entity": { name: "Rental", children: [
      { "source.rdb": { "@table": "rentals" } },
      { "field.long": { name: "id" } },
      { "field.string": { name: "label", "@required": true } },
      { "field.timestamp": { name: "dueAt", "@required": true, "@filterable": true } },
      { "field.timestamp": { name: "opensAt", "@required": true, "@filterable": true, "@localTime": true } },
      { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
    ]}},
  ]},
};

const rentals = sqliteTable("rentals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  label: text("label").notNull(),
  dueAt: text("due_at").notNull(),
  opensAt: text("opens_at").notNull(),
});

const dir = mkdtempSync(join(import.meta.dir, "tmp-ts-instant-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function execute(name: string, source: string): Promise<Record<string, unknown>> {
  const file = join(dir, `${name}.ts`);
  writeFileSync(file, source);
  return import(pathToFileURL(file).href);
}

let app: Hono;
beforeAll(async () => {
  const { root, errors } = await new MetaDataLoader({ strict: true }).load([
    new InMemoryStringSource(JSON.stringify(MODEL), { id: "rentals.json" }),
  ]);
  expect(errors).toEqual([]);
  const rental = root.objects().find((o) => o.name === "Rental") as MetaObject;
  const schemas = await execute("schemas", renderZodValidators(rental).toString());
  const allowlists = await execute("allowlist", renderFilterAllowlist(rental).toString());

  const sqlite = new Database(":memory:");
  sqlite.run("CREATE TABLE rentals (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, due_at TEXT NOT NULL, opens_at TEXT NOT NULL)");
  app = new Hono();
  mountCrudRoutes({
    app, path: "/rentals", db: drizzle(sqlite), table: rentals,
    insertSchema: schemas["RentalInsertSchema"] as never,
    updateSchema: schemas["RentalUpdateSchema"] as never,
    filterAllowlist: allowlists["RentalFilterAllowlist"] as never,
    sortAllowlist: {}, dialect: "sqlite",
  });
  for (const [label, dueAt] of [["date-only", "2026-10-06"], ["zoneless", "2026-10-06T09:00"], ["before", "2026-10-05T22:00:00+00:00"]]) {
    const res = await app.request("/rentals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label, dueAt, opensAt: "2026-10-06T09:00" }),
    });
    expect(res.status).toBe(201);
  }
});

async function rows(query = ""): Promise<Array<{ label: string; dueAt: string; opensAt: string }>> {
  const res = await app.request(`/rentals${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Array<{ label: string; dueAt: string; opensAt: string }>;
}
const labels = async (query: string) => (await rows(query)).map((r) => r.label).sort();

describe("a zone-aware timestamp given a zoneless value (generated code, SQLite)", () => {
  test("the write stores UTC: date-only as midnight, zoneless as that time UTC", async () => {
    const byLabel = new Map((await rows()).map((r) => [r.label, r]));
    expect(byLabel.get("date-only")?.dueAt).toBe("2026-10-06T00:00:00Z");
    expect(byLabel.get("zoneless")?.dueAt).toBe("2026-10-06T09:00:00Z");
    expect(byLabel.get("before")?.dueAt).toBe("2026-10-05T22:00:00Z");
  });

  test("the @localTime field keeps what was sent", async () => {
    for (const r of await rows()) expect(r.opensAt).toBe("2026-10-06T09:00");
  });

  test("filter[dueAt][gte]=…T00:00:00Z includes the date-only row (the reported case)", async () => {
    expect(await labels(`?filter[dueAt][gte]=${encodeURIComponent("2026-10-06T00:00:00Z")}`)).toEqual(["date-only", "zoneless"]);
  });

  test("a date-only or zoneless filter bound is read as UTC", async () => {
    expect(await labels("?filter[dueAt][gte]=2026-10-06")).toEqual(["date-only", "zoneless"]);
    expect(await labels("?filter[dueAt][lt]=2026-10-06")).toEqual(["before"]);
    expect(await labels("?filter[dueAt][eq]=2026-10-06T09:00")).toEqual(["zoneless"]);
  });

  test("an @localTime filter bound is compared as sent", async () => {
    expect(await labels("?filter[opensAt][eq]=2026-10-06T09:00")).toEqual(["before", "date-only", "zoneless"]);
  });
});
