// formFile must NOT emit a write form for entities that have no instantiable
// write representation:
//   - abstract (`abstract: true`)   → shape-via-inheritance only
//   - projection (read-only view)   → instantiable for read, never for write
//
// A concrete writable entity still gets its form. Genericized `acme::*`.

import { describe, test, expect } from "bun:test";
import { formFile } from "../src/form-file.js";
import { makeRenderContext, buildPkMap, buildRelationMap } from "@metaobjectsdev/codegen-ts";
import type { GenContext } from "@metaobjectsdev/codegen-ts";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";

async function loadFixture() {
  const json = JSON.stringify({
    "metadata.root": {
      package: "acme",
      children: [
        // Abstract base — no instance, no write form.
        {
          "object.entity": {
            name: "PartyBase",
            abstract: true,
            children: [
              { "field.int": { name: "id" } },
              { "field.string": { name: "displayName" } },
              { "identity.primary": { "@fields": "id" } },
            ],
          },
        },
        // Concrete subclass — full write form.
        {
          "object.entity": {
            name: "Guest",
            extends: "PartyBase",
            children: [
              { "source.rdb": { "@table": "guests" } },
              { "field.string": { name: "email" } },
            ],
          },
        },
        // Base table for the projection to extend.
        {
          "object.entity": {
            name: "Host",
            children: [
              { "source.rdb": { "@table": "hosts" } },
              { "field.int": { name: "id" } },
              { "field.string": { name: "name" } },
              { "identity.primary": { "@fields": "id" } },
            ],
          },
        },
        // Read-only projection — read model only, no write form.
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

async function ctxFor() {
  const root = await loadFixture();
  const renderContext = makeRenderContext({
    dialect: "sqlite", loadedRoot: root, outDir: "/tmp",
    dbImport: "../db", extStyle: "none",
    pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
  });
  const gen = formFile();
  const ctx: GenContext = {
    entities: root.objects(),
    loadedRoot: root,
    matches: (e) => gen.filter?.(e) ?? true,
    config: { outDir: "/tmp", extStyle: "none", dbImport: "../db", dialect: "sqlite" },
    renderContext,
    warn: () => {},
  };
  return { gen, ctx };
}

describe("formFile — abstract + projection skip", () => {
  test("does NOT emit a form for the abstract base", async () => {
    const { gen, ctx } = await ctxFor();
    const files = await gen.generate(ctx);
    expect(files.find((f) => f.path === "PartyBase.form.tsx")).toBeUndefined();
  });

  test("does NOT emit a form for the read-only projection", async () => {
    const { gen, ctx } = await ctxFor();
    const files = await gen.generate(ctx);
    expect(files.find((f) => f.path === "HostSummary.form.tsx")).toBeUndefined();
  });

  test("DOES emit a form for the concrete writable subclass", async () => {
    const { gen, ctx } = await ctxFor();
    const files = await gen.generate(ctx);
    expect(files.find((f) => f.path === "Guest.form.tsx")).toBeDefined();
  });
});
