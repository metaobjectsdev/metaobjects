import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../src/expected-schema.js";
import { emit } from "../src/emit/index.js";
import type { Change } from "../src/types.js";

// Expression/functional indexes: `@expr` (key expression) + `@using` (access method).
// Covers a btree functional index and a GIN expression index.
//
// NEITHER NODE CARRIES `@fields`. An index key is `@fields` XOR `@expr` (#342). Both did
// until that gate landed, under a comment claiming "@fields anchors the underlying column
// for the loader" — which had stopped being true, and this file did not notice because it
// took `.root` off the result and never read `.errors`. The load verdict is checked now.
async function load(): Promise<import("@metaobjectsdev/metadata").MetaData> {
  const json = JSON.stringify({ "metadata.root": { package: "p", children: [
    { "object.entity": { name: "User", children: [
      { "field.long": { name: "id" } },
      { "field.string": { name: "email" } },
      { "field.string": { name: "tags" } },
      { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
      { "index.lookup": { name: "ix_email_lower",
          "@expr": "lower((email)::text)" } },
      { "index.lookup": { name: "ix_tags_gin",
          "@expr": "string_to_array((tags)::text, ','::text)", "@using": "gin" } },
      { "source.rdb": { name: "src", "@table": "users" } },
    ] } },
  ] } });
  const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  if (result.errors.length > 0) {
    throw new Error(`fixture does not load:\n${result.errors.map((e) => e.message).join("\n")}`);
  }
  return result.root;
}

describe("buildExpectedSchema — expression/functional indexes", () => {
  test("@expr/@using produce expr-keyed IndexDescriptors", async () => {
    const snap = buildExpectedSchema(await load(), { dialect: "postgres" });
    const t = snap.tables.find((x) => x.name === "users")!;
    const lower = t.indexes.find((i) => i.name === "ix_email_lower")!;
    expect(lower).toMatchObject({ expr: "lower((email)::text)", columns: [] });
    expect(lower.using).toBeUndefined(); // btree default
    const gin = t.indexes.find((i) => i.name === "ix_tags_gin")!;
    expect(gin).toMatchObject({ expr: "string_to_array((tags)::text, ','::text)", using: "gin", columns: [] });
  });

  test("emit renders USING <method> (<expr>)", async () => {
    const snap = buildExpectedSchema(await load(), { dialect: "postgres" });
    const t = snap.tables.find((x) => x.name === "users")!;
    const changes: Change[] = t.indexes.map((index) => ({
      kind: "add-index" as const, table: "users", index, status: { state: "allowed" as const },
    }));
    const { up } = emit(changes, { dialect: "postgres" });
    expect(up).toContain('CREATE INDEX "ix_email_lower" ON "users" (lower((email)::text));');
    expect(up).toContain('CREATE INDEX "ix_tags_gin" ON "users" USING gin (string_to_array((tags)::text, \',\'::text));');
  });
});
