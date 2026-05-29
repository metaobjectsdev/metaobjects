// Fix 2 verification: a read-only PROJECTION still yields sensible read-only
// instance artifacts on the tanstack side — read-only hooks (no mutations),
// grid columns, and a grid hook — because a projection IS instantiable for
// READ. (Only WRITE artifacts — the React form — are withheld.)
//
// Genericized `acme::*`. The projection inherits its dataGrid layout from the
// base it extends, satisfying the grid generators' opt-in.

import { describe, test, expect } from "bun:test";
import { tanstackQuery } from "../src/tanstack-query.js";
import { tanstackGrid } from "../src/tanstack-grid.js";
import { tanstackGridHook } from "../src/tanstack-grid-hook.js";
import { makeRenderContext, buildPkMap, buildRelationMap } from "@metaobjectsdev/codegen-ts";
import type { GenContext, Generator } from "@metaobjectsdev/codegen-ts";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";

async function loadFixture() {
  const json = JSON.stringify({
    "metadata.root": {
      package: "acme",
      children: [
        {
          "object.entity": {
            name: "Host",
            children: [
              { "source.rdb": { "@table": "hosts" } },
              { "field.int": { name: "id" } },
              { "field.string": { name: "name", children: [{ "view.text": {} }] } },
              { "identity.primary": { "@fields": "id" } },
              { "layout.dataGrid": { name: "default", "@columns": ["name"] } },
            ],
          },
        },
        {
          "object.entity": {
            name: "HostSummary",
            extends: "Host",
            children: [
              { "source.rdb": { "@kind": "view", "@table": "v_host_summary" } },
              { "identity.primary": { "@fields": "id" } },
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
  return gen.generate(ctx);
}

describe("tanstack generators — projection read-only instance artifacts", () => {
  test("tanstackQuery emits read-only hooks for the projection (no mutations)", async () => {
    const files = await emit(tanstackQuery());
    const hooks = files.find((f) => f.path === "HostSummary.hooks.ts");
    expect(hooks).toBeDefined();
    expect(hooks!.content).toContain("useHostSummary");
    expect(hooks!.content).toContain("useHostSummaries");
    expect(hooks!.content).not.toContain("useCreateHostSummary");
    expect(hooks!.content).not.toContain("useUpdateHostSummary");
    expect(hooks!.content).not.toContain("useDeleteHostSummary");
  });

  test("tanstackGrid emits columns for the projection", async () => {
    const files = await emit(tanstackGrid());
    expect(files.find((f) => f.path === "HostSummary.columns.tsx")).toBeDefined();
  });

  test("tanstackGridHook emits a grid hook for the projection", async () => {
    const files = await emit(tanstackGridHook());
    expect(files.find((f) => f.path === "HostSummary.grid.ts")).toBeDefined();
  });
});
