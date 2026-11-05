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

  test("a live interval modelled as text is read as text with an advisory; modelled as anything else, it is a type change", async () => {
    const live = (expected: Awaited<ReturnType<typeof column>>["schema"]) => ({
      ...expected,
      tables: expected.tables.map((t) => ({ ...t, columns: t.columns.map((c) => c.name === "grace" ? { ...c, sqlType: { kind: "interval" as const } } : c) })),
    });
    const as = async (subType: string) => {
      const doc = DOC.replace('"field.duration":{"name":"grace","@default":"-PT90M"}', `"field.${subType}":{"name":"grace"}`);
      expect(doc).not.toBe(DOC);
      const { root } = await new MetaDataLoader().load([new InMemoryStringSource(doc)]);
      const expected = buildExpectedSchema(root, { dialect: "postgres" });
      return diff({ expected, actual: live(expected), dialect: "postgres" });
    };
    const asString = await as("string");
    expect(asString.changes.filter((c) => c.kind === "change-column-type")).toEqual([]);
    expect(asString.advisories).toEqual([{ kind: "interval-as-string", table: "timers", column: "grace" }]);
    const asInt = await as("int");
    expect(asInt.changes.filter((c) => c.kind === "change-column-type").map((c) => (c as { from: unknown }).from)).toEqual([{ kind: "interval" }]);
    expect(asInt.advisories).toEqual([]);
  });
});
