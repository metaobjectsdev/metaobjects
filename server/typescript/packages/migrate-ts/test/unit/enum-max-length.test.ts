/**
 * A string-stored field.enum's column is VARCHAR(n) when it has a length (its @maxLength,
 * else the project's enums.maxLength, resolveEnumMaxLength), and unbounded text otherwise,
 * as before. An @intValueMap enum stays an integer. A member longer than the project
 * default refuses the build before any SQL is emitted.
 */
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, MetaModelError } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { emit } from "../../src/emit/index.js";
import { diff } from "../../src/diff/index.js";

async function schema(enumDecls: Record<string, unknown>[], maxLength?: number) {
  const doc = { "metadata.root": { package: "acme", children: [
    { "object.entity": { name: "Ticket", children: [
      { "source.rdb": { "@table": "tickets" } },
      { "field.long": { name: "id" } },
      ...enumDecls.map((d) => ({ "field.enum": d })),
      { "identity.primary": { name: "pk", "@fields": "id" } },
    ] } },
  ] } };
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(doc))]);
  expect(errors).toHaveLength(0);
  if (maxLength !== undefined) root.enumDefaults = { maxLength };
  return () => buildExpectedSchema(root);
}

const column = (s: ReturnType<typeof buildExpectedSchema>, name: string) =>
  s.tables.find((t) => t.name === "tickets")!.columns.find((c) => c.name === name)!;

describe("a string-stored enum's column length", () => {
  test("@maxLength → VARCHAR(n) in the CREATE TABLE", async () => {
    const s = (await schema([{ name: "status", "@values": ["OPEN", "CLOSED"], "@maxLength": 16 }]))();
    expect(column(s, "status").sqlType).toEqual({ kind: "text", maxLength: 16 });
    const { changes } = await diff(s, { tables: [], views: [] } as never, { dialect: "postgres" });
    expect(emit(changes, { dialect: "postgres" }).up).toContain('"status" VARCHAR(16)');
  });

  test("the project default sizes an enum with no @maxLength", async () => {
    const s = (await schema([{ name: "status", "@values": ["OPEN", "CLOSED"] }], 32))();
    expect(column(s, "status").sqlType).toEqual({ kind: "text", maxLength: 32 });
  });

  test("no length anywhere → unbounded text, as before", async () => {
    const s = (await schema([{ name: "status", "@values": ["OPEN", "CLOSED"] }]))();
    expect(column(s, "status").sqlType).toEqual({ kind: "text" });
  });

  test("an @intValueMap enum stays an integer under a project default", async () => {
    const s = (await schema([{ name: "rank", "@values": ["A", "B"], "@intValueMap": { A: 1, B: 2 } }], 32))();
    expect(column(s, "rank").sqlType).toEqual({ kind: "integer", bits: 32 });
  });

  test("a member longer than the project default refuses the build", async () => {
    const build = await schema([{ name: "status", "@values": ["OPEN", "IN_PROGRESS"] }], 10);
    expect(build).toThrow(MetaModelError);
    expect(build).toThrow(/IN_PROGRESS/);
  });
});
