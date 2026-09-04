// Two objects declaring an `identity.secondary` of the same NAME generate two indexes
// with the same database name — and an index name is database-global on SQLite and
// schema-global on Postgres (where indexes share the `pg_class` namespace with tables
// and views), so the second CREATE fails at apply.
//
// The obvious way to reach it is an abstract base declaring the identity: every concrete
// entity that `extends` it inherits the same identity `name`, so the collision scales
// with the number of subtypes and is invisible in the metadata — each entity looks fine
// on its own.
//
// This is the same class ERR_DUPLICATE_SQL_NAME already refuses for tables and views;
// indexes were simply not in the guard's loop. Detect-and-refuse at BUILD time rather
// than emitting a migration that cannot be applied (the #258 precedent: refuse with a
// clear error instead of shipping un-appliable SQL).
import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";
import { buildExpectedSchema } from "../src/expected-schema.js";

function entity(name: string, secondaryName: string) {
  return {
    "object.entity": {
      name,
      children: [
        { "source.rdb": {} },
        { "field.long": { name: "id" } },
        { "field.string": { name: "slug", "@required": true } },
        { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
        { "identity.secondary": { name: secondaryName, "@fields": ["slug"] } },
      ],
    },
  };
}

async function load(children: unknown[]) {
  const repo = mkdtempSync(join(tmpdir(), "dupidx-"));
  mkdirSync(join(repo, "metaobjects"), { recursive: true });
  const f = join(repo, "metaobjects", "m.json");
  writeFileSync(f, JSON.stringify({ "metadata.root": { package: "acme::dup", children } }), "utf8");
  return (await new MetaDataLoader().load([new FileSource(f)])).root;
}

describe("ERR_DUPLICATE_SQL_NAME covers index names, not just tables and views", () => {
  test("two entities whose secondary identities share a name are refused", async () => {
    const root = await load([entity("Post", "bySlug"), entity("Page", "bySlug")]);
    expect(() => buildExpectedSchema(root, { dialect: "postgres" })).toThrow(/ERR_DUPLICATE_SQL_NAME/);
  });

  test("the error names the index and both owning tables, so it is actionable", async () => {
    const root = await load([entity("Post", "bySlug"), entity("Page", "bySlug")]);
    let msg = "";
    try {
      buildExpectedSchema(root, { dialect: "postgres" });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("bySlug");
    expect(msg).toContain("posts");
    expect(msg).toContain("pages");
  });

  test("sqlite too — an index name is database-global there", async () => {
    const root = await load([entity("Post", "bySlug"), entity("Page", "bySlug")]);
    expect(() => buildExpectedSchema(root, { dialect: "sqlite" })).toThrow(/ERR_DUPLICATE_SQL_NAME/);
  });

  test("distinct index names still build — the guard is not blanket", async () => {
    const root = await load([entity("Post", "postBySlug"), entity("Page", "pageBySlug")]);
    const snap = buildExpectedSchema(root, { dialect: "postgres" });
    const names = snap.tables.flatMap((t) => t.indexes.map((i) => i.name)).sort();
    expect(names).toEqual(["pageBySlug", "postBySlug"]);
  });

  test("an index may not collide with a TABLE name either (shared pg_class namespace)", async () => {
    const root = await load([entity("Post", "pages"), entity("Page", "byPageSlug")]);
    expect(() => buildExpectedSchema(root, { dialect: "postgres" })).toThrow(/ERR_DUPLICATE_SQL_NAME/);
  });
});
