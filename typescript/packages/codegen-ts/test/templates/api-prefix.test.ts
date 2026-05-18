// Tests for $apiPrefix emission in entity-constants + routes-file.

import { describe, test, expect } from "bun:test";
import type { MetaData } from "@metaobjects/metadata";
import {
  TypeId,
  TYPE_OBJECT,
  TYPE_FIELD,
  TYPE_IDENTITY,
  TYPE_METADATA,
  FIELD_SUBTYPE_STRING,
  FIELD_SUBTYPE_LONG,
  IDENTITY_SUBTYPE_PRIMARY,
  OBJECT_SUBTYPE_ENTITY,
  SUBTYPE_ROOT,
  MetaDataLoader,
  InMemorySource,
} from "@metaobjects/metadata";
import { meta } from "../_meta-build.js";
import { renderEntityConstants } from "../../src/templates/entity-constants.js";
import { renderRoutesFile } from "../../src/templates/routes-file.js";
import { makeRenderContext } from "../../src/render-context.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSimpleRoot(name = "Subscriber"): { root: MetaData; entity: MetaData } {
  const root = meta(new TypeId(TYPE_METADATA, SUBTYPE_ROOT), "");
  const entity = meta(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), name);
  const id = meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_LONG), "id");
  entity.addChild(id);
  const email = meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING), "email");
  entity.addChild(email);
  const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
  primary.setAttr("fields", ["id"]);
  primary.setAttr("generation", "increment");
  entity.addChild(primary);
  root.addChild(entity);
  return { root, entity };
}

function makeSimpleEntity(name = "Subscriber"): MetaData {
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
              { "source.dbTable": { "@name": "programs" } },
              { "field.int": { name: "id" } },
              { "identity.primary": { "@fields": "id" } },
            ],
          },
        },
        {
          "object.entity": {
            name: "ProgramSummary",
            extends: "Program",
            children: [
              { "source.dbView": { "@name": "v_program_summary" } },
              { "field.int": { name: "weekCount" } },
              { "identity.primary": { "@fields": "id" } },
            ],
          },
        },
      ],
    },
  });
  const result = await new MetaDataLoader().load([new InMemorySource(json)]);
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
  test("flat shape (no wrapping) when apiPrefix is empty", async () => {
    const root = await loadProjectionFixture();
    const projection = root.ownChildren().find((o) => o.name === "ProgramSummary")!;
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
    const projection = root.ownChildren().find((o) => o.name === "ProgramSummary")!;
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
