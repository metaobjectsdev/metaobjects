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

describe("turning a length on for an enum column that already exists", () => {
  // text → VARCHAR(n) fails on any existing row longer than n, and the member list says
  // nothing about rows written before the enum was narrowed, so it is a lossy type change:
  // gated behind --allow type-change like any other narrowing.
  test("text → VARCHAR(n) is a change-column-type gated as lossy", async () => {
    const before = (await schema([{ name: "status", "@values": ["OPEN", "CLOSED"] }]))();
    const after = (await schema([{ name: "status", "@values": ["OPEN", "CLOSED"] }], 32))();
    const { changes } = await diff(after, before, { dialect: "postgres" });
    const change = changes.find((c) => c.kind === "change-column-type");
    expect(change).toMatchObject({ column: "status", from: { kind: "text" }, to: { kind: "text", maxLength: 32 } });
    expect(change?.status).toMatchObject({ state: "blocked" });
    const allowed = await diff(after, before, { dialect: "postgres", allow: { typeChange: true } });
    expect(emit(allowed.changes, { dialect: "postgres" }).up).toContain('ALTER COLUMN "status" TYPE VARCHAR(32)');
  });

  test("turning it off again (VARCHAR(n) → text) widens, so it is allowed", async () => {
    const before = (await schema([{ name: "status", "@values": ["OPEN", "CLOSED"] }], 32))();
    const after = (await schema([{ name: "status", "@values": ["OPEN", "CLOSED"] }]))();
    const { changes } = await diff(after, before, { dialect: "postgres" });
    expect(changes.find((c) => c.kind === "change-column-type")?.status).toEqual({ state: "allowed" });
  });

  test("SQLite does not enforce a VARCHAR length, so there is nothing to change", async () => {
    const before = (await schema([{ name: "status", "@values": ["OPEN", "CLOSED"] }]))();
    const after = (await schema([{ name: "status", "@values": ["OPEN", "CLOSED"] }], 32))();
    const { changes } = await diff(after, before, { dialect: "sqlite" });
    expect(changes.filter((c) => c.kind === "change-column-type")).toEqual([]);
  });
});
