/**
 * field.duration's column: a native INTERVAL on Postgres (a @default in Postgres's own interval
 * spelling, which it reads back unchanged), and on SQLite the 64-bit microsecond INTEGER the
 * runtimes store, so it orders and compares as the span does (a @default is that integer too).
 */
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { emit } from "../../src/emit/index.js";
import { diff } from "../../src/diff/index.js";

const DOC = JSON.stringify({ "metadata.root": { package: "acme", children: [{ "object.entity": { name: "Timer", children: [
  { "source.rdb": { "@table": "timers" } },
  { "field.long": { name: "id" } },
  { "field.duration": { name: "grace", "@default": "-PT90M" } },
  { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
] } }] } });

async function column(dialect: "postgres" | "sqlite") {
  const { root } = await new MetaDataLoader().load([new InMemoryStringSource(DOC)]);
  const schema = buildExpectedSchema(root, { dialect });
  return { schema, col: schema.tables[0]!.columns.find((c) => c.name === "grace")! };
}

describe("field.duration column", () => {
  test("Postgres: INTERVAL, default in the interval spelling", async () => {
    const { col } = await column("postgres");
    expect(col.sqlType).toEqual({ kind: "interval" });
    expect(col.default).toEqual({ kind: "literal", value: "-01:30:00" });
  });

  test("SQLite: a 64-bit INTEGER of microseconds, default included", async () => {
    const { schema, col } = await column("sqlite");
    expect(col.sqlType).toEqual({ kind: "integer", bits: 64 });
    expect(col.default).toEqual({ kind: "literal", value: "-5400000000" });
    const { changes } = await diff({ expected: schema, actual: { tables: [], views: [] }, dialect: "sqlite" });
    expect(emit(changes, { dialect: "sqlite", expectedSchema: schema }).up).toContain('"grace" INTEGER DEFAULT -5400000000');
  });
});
