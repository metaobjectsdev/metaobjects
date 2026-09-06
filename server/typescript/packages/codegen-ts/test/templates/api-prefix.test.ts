// Tests for $apiPrefix emission in entity-constants + routes-file.

import { describe, test, expect } from "bun:test";
import type { MetaObject, MetaRoot } from "@metaobjectsdev/metadata";
import {
  TypeId,
  TYPE_IDENTITY,
  FIELD_SUBTYPE_STRING,
  FIELD_SUBTYPE_LONG,
  IDENTITY_SUBTYPE_PRIMARY,
  OBJECT_SUBTYPE_ENTITY,
  MetaDataLoader,
  InMemoryStringSource,
} from "@metaobjectsdev/metadata";
import { meta, metaRoot, metaObject, metaField } from "../_meta-build.js";
import { renderEntityConstants } from "../../src/templates/entity-constants.js";
import { renderRoutesFile } from "../../src/templates/routes-file.js";
import { makeRenderContext } from "../../src/render-context.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSimpleRoot(name = "Subscriber"): { root: MetaRoot; entity: MetaObject } {
  const root = metaRoot();
  const entity = metaObject(OBJECT_SUBTYPE_ENTITY, name);
  const id = metaField(FIELD_SUBTYPE_LONG, "id");
  entity.addChild(id);
  const email = metaField(FIELD_SUBTYPE_STRING, "email");
  entity.addChild(email);
  const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
  primary.setAttr("fields", ["id"]);
  primary.setAttr("generation", "increment");
  entity.addChild(primary);
  root.addChild(entity);
  return { root, entity };
}

function makeSimpleEntity(name = "Subscriber"): MetaObject {
  return makeSimpleRoot(name).entity;
}

function makeVanillaCtx(apiPrefix = "") {
  const { root } = makeSimpleRoot();
  return makeRenderContext({
    dialect: "sqlite",
    loadedRoot: root,
    outDir: "/x",
    dbImport: "~/db",
    apiPrefix,
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
  });
}

async function loadProjectionFixture() {
  const json = JSON.stringify({
    "metadata.root": {
      package: "test",
      children: [
        {
          "object.entity": {
            name: "Program",
            children: [
              { "source.rdb": { "@table": "programs" } },
              { "field.int": { name: "id" } },
              { "identity.primary": { "name": "id", "@fields": "id" } },
            ],
          },
        },
        {
          "object.projection": {
            name: "ProgramSummary",
            children: [
              { "source.rdb": { "@kind": "view", "@table": "v_program_summary" } },
              { "field.int": { name: "weekCount" } },
            ],
          },
        },
      ],
    },
  });
  const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  if (result.errors.length > 0) throw new Error(result.errors.map((e) => e.message).join("\n"));
  return result.root;
}

// ---------------------------------------------------------------------------
// entity-constants: $apiPrefix
// ---------------------------------------------------------------------------

// This block used to assert the OPPOSITE — that `$apiPrefix` was emitted, for three
// prefix values and in a fixed position after `$path`. It is inverted rather than
// deleted, because "the descriptor must not carry the base URL" is now the contract and
// deserves a test as much as its predecessor did. The `renderRoutesFile` block below is
// UNCHANGED on purpose: together the two halves state the split this release makes —
// the client descriptor carries no prefix, and the server routes still mount under one.
describe("renderEntityConstants — the base URL is not in the descriptor", () => {
  test("no prefix is emitted when none is passed", () => {
    const entity = makeSimpleEntity();
    expect(renderEntityConstants(entity).toString()).not.toContain("$apiPrefix");
  });

  test("no prefix is emitted even when one is passed", () => {
    const entity = makeSimpleEntity();
    // The parameter is still ACCEPTED — ADR-0034 ejected copies call this positionally
    // — so the case that would regress is a caller still supplying a real prefix.
    expect(renderEntityConstants(entity, "/api").toString()).not.toContain("$apiPrefix");
    expect(renderEntityConstants(entity, "/api/v1").toString()).not.toContain("$apiPrefix");
  });

  test("$path survives — the address IS metadata, the base is not", () => {
    const entity = makeSimpleEntity();
    const out = renderEntityConstants(entity, "/api").toString();
    // Without this, an emitter that produced nothing at all would pass the two above.
    expect(out).toContain('$path: "/subscribers"');
    expect(out).toContain('$entity: "Subscriber"');
  });
});

// ---------------------------------------------------------------------------
// routes-file: apiPrefix wrapping behaviour (vanilla entity)
// ---------------------------------------------------------------------------

describe("renderRoutesFile — vanilla entity — apiPrefix", () => {
  test("flat shape (no wrapping) when apiPrefix is empty", () => {
    const entity = makeSimpleEntity();
    const ctx = makeVanillaCtx("");
    const out = renderRoutesFile(entity, ctx);
    expect(out).not.toContain("fastify.register");
    expect(out).not.toContain('{ prefix:');
    expect(out).toContain("mountCrudRoutes");
    // flat call uses `fastify` not `instance`
    expect(out).toContain("fastify,");
  });

  test("wraps with fastify.register when apiPrefix is '/api'", () => {
    const entity = makeSimpleEntity();
    const ctx = makeVanillaCtx("/api");
    const out = renderRoutesFile(entity, ctx);
    expect(out).toContain("fastify.register");
    expect(out).toContain('{ prefix: "/api" }');
    expect(out).toContain("mountCrudRoutes");
    // wrapped call uses `instance` not top-level `fastify`
    expect(out).toContain("fastify: instance");
  });
});

// ---------------------------------------------------------------------------
// routes-file: apiPrefix wrapping behaviour (projection)
// ---------------------------------------------------------------------------

describe("renderRoutesFile — projection — apiPrefix", () => {
  test("flat shape (no wrapping) when apiPrefix is empty", async () => {
    const root = await loadProjectionFixture();
    const projection = root.objects().find((o) => o.name === "ProgramSummary")!;
    const ctx = makeRenderContext({
      dialect: "sqlite",
      loadedRoot: root,
      outDir: "/x",
      dbImport: "~/db",
      apiPrefix: "",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
    });
    const out = renderRoutesFile(projection, ctx);
    expect(out).not.toContain("fastify.register");
    expect(out).toContain("mountReadOnlyCrudRoutes");
    expect(out).toContain("fastify,");
  });

  test("wraps with fastify.register when apiPrefix is '/api'", async () => {
    const root = await loadProjectionFixture();
    const projection = root.objects().find((o) => o.name === "ProgramSummary")!;
    const ctx = makeRenderContext({
      dialect: "sqlite",
      loadedRoot: root,
      outDir: "/x",
      dbImport: "~/db",
      apiPrefix: "/api",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
    });
    const out = renderRoutesFile(projection, ctx);
    expect(out).toContain("fastify.register");
    expect(out).toContain('{ prefix: "/api" }');
    expect(out).toContain("mountReadOnlyCrudRoutes");
    expect(out).toContain("fastify: instance");
  });
});
