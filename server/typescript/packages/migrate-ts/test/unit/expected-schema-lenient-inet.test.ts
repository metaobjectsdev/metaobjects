// #234 — a @lenient field.inet stores as a Postgres `text` column, not the
// native `inet` type: the native column would itself reject a not-strictly-valid
// value at INSERT, defeating the opt-out. A strict field.inet stays `inet`, and a
// field.uri stays `text` regardless (no Postgres uri type). Byte-identical for any
// field WITHOUT @lenient (the no-churn guard).
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import type { SqlType } from "../../src/sql-type.js";

const META = JSON.stringify({
  "metadata.root": {
    package: "acme",
    children: [
      {
        "object.entity": {
          name: "Endpoint",
          children: [
            { "field.long": { name: "id" } },
            { "field.inet": { name: "strictIp" } },
            { "field.inet": { name: "lenientIp", "@lenient": true } },
            { "field.uri": { name: "strictUrl" } },
            { "field.uri": { name: "lenientUrl", "@lenient": true } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
          ],
        },
      },
    ],
  },
});

async function columns(): Promise<Map<string, { sqlType: SqlType }>> {
  const root = (await new MetaDataLoader().load([new InMemoryStringSource(META)])).root;
  const snapshot = buildExpectedSchema(root, { dialect: "postgres" });
  const table = snapshot.tables.find((t) => t.name === "endpoints")!;
  return new Map(table.columns.map((c) => [c.name, c]));
}

describe("#234 — @lenient field.inet → text column (postgres)", () => {
  test("strict field.inet stays native inet; @lenient field.inet becomes text", async () => {
    const cols = await columns();
    expect(cols.get("strict_ip")?.sqlType).toEqual({ kind: "inet" });
    expect(cols.get("lenient_ip")?.sqlType).toEqual({ kind: "text" });
  });

  test("field.uri stays text regardless of @lenient (no Postgres uri type)", async () => {
    const cols = await columns();
    expect(cols.get("strict_url")?.sqlType).toEqual({ kind: "text" });
    expect(cols.get("lenient_url")?.sqlType).toEqual({ kind: "text" });
  });
});
