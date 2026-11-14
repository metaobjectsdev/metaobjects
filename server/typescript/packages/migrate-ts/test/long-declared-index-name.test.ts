// A declared index name over Postgres's 63-byte identifier limit is created under its first
// 63 bytes, and introspection reads that cut name back. The expected schema carries the name
// Postgres stores, so a converged database proposes nothing on the next run. SQLite and D1
// store the name whole.
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../src/expected-schema.js";
import { diff } from "../src/diff/index.js";

const LONG_LOOKUP = `idx_events_${"a".repeat(59)}`;
const LONG_IDENTITY = `uq_events_${"b".repeat(60)}`;
const STORED_LOOKUP = LONG_LOOKUP.slice(0, 63);
const STORED_IDENTITY = LONG_IDENTITY.slice(0, 63);

function model(lookupName: string, identityName: string): string {
  return JSON.stringify({
    "metadata.root": {
      package: "acme",
      children: [
        {
          "object.entity": {
            name: "Event",
            children: [
              { "field.long": { name: "id" } },
              { "field.long": { name: "userId" } },
              { "field.string": { name: "slug" } },
              { "source.rdb": { "@table": "events" } },
              { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
              { "identity.secondary": { name: identityName, "@fields": ["slug"] } },
              { "index.lookup": { name: lookupName, "@fields": ["userId"] } },
            ],
          },
        },
      ],
    },
  });
}

async function load(json: string): Promise<MetaData> {
  return (await new MetaDataLoader().load([new InMemoryStringSource(json)])).root;
}

describe("a declared index name over 63 bytes on Postgres", () => {
  test("the declared names are over the limit (the premise)", () => {
    expect(LONG_LOOKUP.length).toBe(70);
    expect(LONG_IDENTITY.length).toBe(70);
  });

  test("a database holding the names Postgres stored converges: nothing is proposed", async () => {
    const root = await load(model(LONG_LOOKUP, LONG_IDENTITY));
    const expected = buildExpectedSchema(root, { dialect: "postgres" });
    const live = structuredClone(expected);
    const events = live.tables.find((t) => t.name === "events")!;
    // What introspection returns: the 63-byte names Postgres stored, written out literally.
    for (const ix of events.indexes) {
      if (ix.name.startsWith("idx_events_")) ix.name = STORED_LOOKUP;
      if (ix.name.startsWith("uq_events_")) ix.name = STORED_IDENTITY;
    }
    expect(events.indexes.map((i) => i.name).sort()).toEqual([STORED_LOOKUP, STORED_IDENTITY].sort());
    expect((await diff({ expected, actual: live })).changes).toEqual([]);
  });

  test("two long names that cut to the same 63 bytes are refused as duplicates", async () => {
    const root = await load(model(`${"c".repeat(63)}_x`, `${"c".repeat(63)}_y`));
    expect(() => buildExpectedSchema(root, { dialect: "postgres" })).toThrow(/ERR_DUPLICATE_SQL_NAME/);
  });

  test("SQLite keeps the declared name whole", async () => {
    const root = await load(model(LONG_LOOKUP, LONG_IDENTITY));
    const expected = buildExpectedSchema(root, { dialect: "sqlite" });
    const names = expected.tables.find((t) => t.name === "events")!.indexes.map((i) => i.name);
    expect(names.sort()).toEqual([LONG_LOOKUP, LONG_IDENTITY].sort());
  });
});
