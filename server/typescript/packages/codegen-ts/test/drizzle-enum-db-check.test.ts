// rc.20 @dbCheck: an enum with `@dbCheck: false` gets no membership CHECK in the Drizzle table, as
// `meta migrate` creates none — else `drizzle-kit push` would re-add the CHECK the model opted out
// of. A sibling enum keeps its own, and the enum's values still type the column.
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { renderDrizzleSchema } from "../src/templates/drizzle-schema.js";
import { makeRenderContext } from "../src/render-context.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";
import { buildExpectedSchema } from "@metaobjectsdev/migrate-ts/expected";
import type { Dialect } from "../src/metaobjects-config.js";

async function load() {
  const json = JSON.stringify({ "metadata.root": { children: [
    { "object.entity": { name: "Provider", children: [
      { "source.rdb": { name: "src", "@table": "providers" } },
      { "field.long": { name: "id" } },
      { "field.enum": { name: "state", "@values": ["OPEN", "SHUT"], "@dbCheck": false } },
      { "field.enum": { name: "kind", "@values": ["CLINIC", "LAB"] } },
      { "field.enum": { name: "tier", "@values": ["GOLD", "SILVER"], "@constraintName": "CK_Providers_Tier" } },
      { "identity.primary": { name: "pk", "@fields": ["id"] } },
    ] } },
  ] } });
  const res = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  expect(res.errors).toEqual([]);
  return res.root;
}

async function emit(dialect: Dialect) {
  const root = await load();
  const ctx = makeRenderContext({
    dialect, loadedRoot: root, outDir: "/x", dbImport: "~/db",
    pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
  });
  return renderDrizzleSchema(root.findObject("Provider")!, ctx).toString();
}

describe("Drizzle: @dbCheck: false on a field.enum", () => {
  for (const dialect of ["postgres", "sqlite"] as const) {
    test(`${dialect}: the opted-out enum declares no CHECK; its sibling keeps one`, async () => {
      const out = await emit(dialect);
      expect(out).not.toContain("providers_state_chk");
      expect(out).toContain("providers_kind_chk");
      // A declared @constraintName names the CHECK, as meta migrate names it.
      expect(out).toContain('"CK_Providers_Tier"');
      expect(out).not.toContain("providers_tier_chk");
      // The column is still the enum's: only the database CHECK is left out.
      expect(out).toContain('"OPEN"');
    });

    test(`${dialect}: the Drizzle CHECKs are the ones meta migrate creates`, async () => {
      const root = await load();
      const migrate = buildExpectedSchema(root, { dialect }).tables.find((t) => t.name === "providers")!;
      expect(migrate.checks.map((c) => c.name)).toEqual(["providers_kind_chk", "CK_Providers_Tier"]);
    });
  }
});
