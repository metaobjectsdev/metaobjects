// test/snapshot/serialize.test.ts
import { describe, test, expect, beforeAll } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import type { SchemaSnapshot } from "../../src/types.js";
import {
  serializeSnapshot,
  parseSnapshot,
  SNAPSHOT_FORMAT_VERSION,
} from "../../src/snapshot/serialize.js";

const META = JSON.stringify({
  "metadata.root": {
    children: [
      {
        "object.entity": {
          name: "Order",
          children: [
            { "field.long": { name: "id" } },
            { "field.string": { name: "ref" } },
            { "source.rdb": { name: "src", "@table": "orders" } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Customer",
          children: [
            { "field.long": { name: "id" } },
            { "field.string": { name: "email" } },
            { "source.rdb": { name: "src", "@table": "customers" } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
          ],
        },
      },
    ],
  },
});

async function loadJson(json: string): Promise<MetaData> {
  const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  return result.root;
}

describe("serializeSnapshot / parseSnapshot", () => {
  let snap: SchemaSnapshot;

  beforeAll(async () => {
    snap = buildExpectedSchema(await loadJson(META), { dialect: "postgres" });
  });

  test("output carries the format version and ends with a newline", () => {
    const text = serializeSnapshot(snap);
    expect(text).toContain(`"formatVersion": ${SNAPSHOT_FORMAT_VERSION}`);
    expect(text.endsWith("\n")).toBe(true);
  });

  test("round-trips: parse(serialize(s)) re-serializes byte-identically", () => {
    const text = serializeSnapshot(snap);
    expect(serializeSnapshot(parseSnapshot(text))).toBe(text);
  });

  test("is order-stable: shuffled tables/columns serialize identically", () => {
    const shuffled: SchemaSnapshot = {
      ...snap,
      tables: [...snap.tables].reverse().map((t) => ({
        ...t,
        columns: [...t.columns].reverse(),
        indexes: [...t.indexes].reverse(),
        foreignKeys: [...t.foreignKeys].reverse(),
      })),
      views: [...snap.views].reverse(),
    };
    expect(serializeSnapshot(shuffled)).toBe(serializeSnapshot(snap));
  });

  test("rejects a snapshot whose formatVersion is newer than supported", () => {
    const bumped = serializeSnapshot(snap).replace(
      `"formatVersion": ${SNAPSHOT_FORMAT_VERSION}`,
      `"formatVersion": ${SNAPSHOT_FORMAT_VERSION + 1}`,
    );
    expect(() => parseSnapshot(bumped)).toThrow(/newer than supported/);
  });

  test("rejects a file with no formatVersion", () => {
    expect(() => parseSnapshot(JSON.stringify({ snapshot: snap }))).toThrow(/formatVersion/);
  });

  test("rejects a file with formatVersion but no snapshot body", () => {
    expect(() => parseSnapshot(JSON.stringify({ formatVersion: SNAPSHOT_FORMAT_VERSION })))
      .toThrow(/missing a 'snapshot' object/);
  });
});
