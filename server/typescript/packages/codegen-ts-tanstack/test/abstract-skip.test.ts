// Abstract entities (`abstract: true`) contribute shape via inheritance ONLY
// and must never produce instance artifacts. The three tanstack generators
// (query hooks, grid columns, grid hooks) must SKIP abstract entities, while a
// concrete subclass still emits all of them.
//
// Genericized `acme::*`. The base and subclass both declare a dataGrid layout
// so the grid generators' opt-in is satisfied — proving the skip is driven by
// `abstract`, not by a missing layout.

import { describe, test, expect } from "bun:test";
import { tanstackQuery } from "../src/tanstack-query.js";
import { tanstackGrid } from "../src/tanstack-grid.js";
import { tanstackGridHook } from "../src/tanstack-grid-hook.js";
import { makeRenderContext, buildPkMap, buildRelationMap } from "@metaobjectsdev/codegen-ts";
import type { GenContext, Generator } from "@metaobjectsdev/codegen-ts";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";

async function loadFixture() {
  const grid = {
    "layout.dataGrid": { name: "default", "@columns": ["displayName"] },
  };
  const json = JSON.stringify({
    "metadata.root": {
      package: "acme",
      children: [
        // Abstract base WITH a dataGrid layout + a table source — proves the
        // skip is because it is abstract, not because of a missing opt-in.
        {
          "object.entity": {
            name: "PartyBase",
            abstract: true,
            children: [
              { "source.rdb": { "@table": "party_base" } },
              { "field.int": { name: "id" } },
              { "field.string": { name: "displayName", children: [{ "view.text": {} }] } },
              { "identity.primary": { "@fields": "id" } },
              grid,
            ],
          },
        },
        // Concrete subclass — emits query hooks, columns, grid hook.
        {
          "object.entity": {
            name: "Guest",
            extends: "PartyBase",
            children: [
              { "source.rdb": { "@table": "guests" } },
              { "field.string": { name: "email" } },
              grid,
            ],
          },
        },
      ],
    },
  });
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  if (errors.length > 0) throw new Error(errors.map((e) => e.message).join("\n"));
  return root;
}

async function emit(gen: Generator) {
  const root = await loadFixture();
  const renderContext = makeRenderContext({
    dialect: "sqlite", loadedRoot: root, outDir: "/tmp",
    dbImport: "../db", extStyle: "none",
    pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
  });
  const ctx: GenContext = {
    entities: root.objects(),
    loadedRoot: root,
    matches: (e) => gen.filter?.(e) ?? true,
    config: { outDir: "/tmp", extStyle: "none", dbImport: "../db", dialect: "sqlite" },
    renderContext,
    warn: () => {},
  };
  return (await gen.generate(ctx)).map((f) => f.path);
}

describe("tanstack generators — abstract skip", () => {
  test("tanstackQuery skips the abstract base, emits for the concrete subclass", async () => {
    const paths = await emit(tanstackQuery());
    expect(paths).not.toContain("PartyBase.hooks.ts");
    expect(paths).toContain("Guest.hooks.ts");
  });

  test("tanstackGrid skips the abstract base, emits for the concrete subclass", async () => {
    const paths = await emit(tanstackGrid());
    expect(paths).not.toContain("PartyBase.columns.tsx");
    expect(paths).toContain("Guest.columns.tsx");
  });

  test("tanstackGridHook skips the abstract base, emits for the concrete subclass", async () => {
    const paths = await emit(tanstackGridHook());
    expect(paths).not.toContain("PartyBase.grid.ts");
    expect(paths).toContain("Guest.grid.ts");
  });
});
