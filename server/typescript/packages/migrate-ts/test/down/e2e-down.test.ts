import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { diff } from "../../src/diff/index.js";
import { emit } from "../../src/emit/index.js";

async function load(json: string): Promise<MetaData> {
  return (await new MetaDataLoader().load([new InMemoryStringSource(json)])).root;
}
const ENTITY = (fields: string) => JSON.stringify({
  "metadata.root": { children: [{
    "object.entity": { name: "User", children: [
      { "field.long": { name: "id" } },
      ...JSON.parse(fields),
      { "source.rdb": { name: "src", "@table": "users" } },
      { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
    ] },
  }] },
});

describe("e2e: dropping a field yields a reversible migration", () => {
  test("up drops the column; down re-adds it with the recorded type", async () => {
    // snapshot (prior) has `email`; new metadata removes it
    const prior = buildExpectedSchema(await load(ENTITY('[{"field.string":{"name":"email"}}]')), { dialect: "postgres" });
    const next = buildExpectedSchema(await load(ENTITY('[]')), { dialect: "postgres" });
    const r = await diff({ expected: next, actual: prior, allow: { dropColumn: true } });
    const { up, down } = emit(r.changes, { dialect: "postgres" });
    expect(up).toContain(`DROP COLUMN "email"`);
    expect(down).toContain(`ADD COLUMN "email"`);
    expect(down).toMatch(/column data is not restored/i);
    // down is no longer a bare TODO stub
    expect(down).not.toMatch(/TODO: re-add dropped column/i);
  });
});
