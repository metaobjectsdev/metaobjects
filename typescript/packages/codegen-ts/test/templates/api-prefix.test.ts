// Tests for $apiPrefix emission in entity-constants + routes-file.

import { describe, test, expect } from "bun:test";
import {
  MetaModel,
  TypeId,
  TYPE_OBJECT,
  TYPE_FIELD,
  TYPE_IDENTITY,
  FIELD_SUBTYPE_STRING,
  FIELD_SUBTYPE_LONG,
  IDENTITY_SUBTYPE_PRIMARY,
  OBJECT_SUBTYPE_ENTITY,
  Loader,
} from "@metaobjects/metadata";
import { renderEntityConstants } from "../../src/templates/entity-constants.js";
import { renderRoutesFile } from "../../src/templates/routes-file.js";
import { makeRenderContext } from "../../src/render-context.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSimpleRoot(name = "Subscriber"): { root: MetaModel; entity: MetaModel } {
  const root = new MetaModel(new TypeId("metadata", "base"), "");
  const entity = new MetaModel(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), name);
  const id = new MetaModel(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_LONG), "id");
  entity.addChild(id);
  const email = new MetaModel(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING), "email");
  entity.addChild(email);
  const primary = new MetaModel(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
  primary.setAttr("fields", ["id"]);
  primary.setAttr("generation", "increment");
  entity.addChild(primary);
  root.addChild(entity);
  return { root, entity };
}

function makeSimpleEntity(name = "Subscriber"): MetaModel {
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

function loadProjectionFixture() {
  const loader = new Loader();
  const json = JSON.stringify({
    metadata: {
      package: "test",
      children: [
        {
          object: {
            name: "Program",
            subType: "entity",
            children: [
              { source: { subType: "dbTable", "@name": "programs" } },
              { field: { name: "id", subType: "int" } },
              { identity: { subType: "primary", "@fields": "id" } },
            ],
          },
        },
        {
          object: {
            name: "ProgramSummary",
            subType: "entity",
            extends: "Program",
            children: [
              { source: { subType: "dbView", "@name": "v_program_summary" } },
              { field: { name: "weekCount", subType: "int" } },
              { identity: { subType: "primary", "@fields": "id" } },
            ],
          },
        },
      ],
    },
  });
  const result = loader.loadJson(json);
  if (result.errors.length > 0) throw new Error(result.errors.map((e) => e.message).join("\n"));
  return result.root;
}

// ---------------------------------------------------------------------------
// entity-constants: $apiPrefix
// ---------------------------------------------------------------------------

describe("renderEntityConstants — $apiPrefix", () => {
  test("emits $apiPrefix: '' when no prefix provided", () => {
    const entity = makeSimpleEntity();
    const out = renderEntityConstants(entity).toString();
    expect(out).toContain('$apiPrefix: ""');
  });

  test("emits $apiPrefix: '/api' when prefix is '/api'", () => {
    const entity = makeSimpleEntity();
    const out = renderEntityConstants(entity, "/api").toString();
    expect(out).toContain('$apiPrefix: "/api"');
  });

  test("emits $apiPrefix: '/api/v1' when prefix is '/api/v1'", () => {
    const entity = makeSimpleEntity();
    const out = renderEntityConstants(entity, "/api/v1").toString();
    expect(out).toContain('$apiPrefix: "/api/v1"');
  });

  test("$apiPrefix appears after $path in output", () => {
    const entity = makeSimpleEntity();
    const out = renderEntityConstants(entity, "/api").toString();
    const pathIdx = out.indexOf("$path");
    const prefixIdx = out.indexOf("$apiPrefix");
    expect(pathIdx).toBeGreaterThan(-1);
    expect(prefixIdx).toBeGreaterThan(pathIdx);
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
  test("flat shape (no wrapping) when apiPrefix is empty", () => {
    const root = loadProjectionFixture();
    const projection = root.children().find((o) => o.name === "ProgramSummary")!;
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

  test("wraps with fastify.register when apiPrefix is '/api'", () => {
    const root = loadProjectionFixture();
    const projection = root.children().find((o) => o.name === "ProgramSummary")!;
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
