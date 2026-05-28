// Coverage for the rc.12 templateGenerator() factory.
//
// Hits the three patterns described in the design doc: per-entity, aggregator,
// and adopter Provider override (the "hybrid" decision D1). Also covers the
// EntityDocData public-API contract surfaced via `buildEntityDocData()`.

import { describe, test, expect } from "bun:test";
import { InMemoryProvider } from "@metaobjectsdev/render";
import { templateGenerator } from "../../src/generators/template-generator.js";
import { buildEntityDocData } from "../../src/generators/docs-data-builder.js";
import {
  OBJECT_SUBTYPE_ENTITY,
  FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_STRING,
  TypeId, TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY, IDENTITY_ATTR_FIELDS,
  IDENTITY_ATTR_GENERATION, GENERATION_INCREMENT,
} from "@metaobjectsdev/metadata";
import { metaRoot, metaObject, metaField, meta } from "../_meta-build.js";
import type { GenContext } from "../../src/generator.js";

function buildRoot() {
  const root = metaRoot("root", "demo");
  const e = metaObject(OBJECT_SUBTYPE_ENTITY, "Post");
  e.addChild(metaField(FIELD_SUBTYPE_LONG, "id"));
  e.addChild(metaField(FIELD_SUBTYPE_STRING, "title"));
  const pk = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
  pk.setAttr(IDENTITY_ATTR_FIELDS, ["id"]);
  pk.setAttr(IDENTITY_ATTR_GENERATION, GENERATION_INCREMENT);
  e.addChild(pk);
  root.addChild(e);
  return root;
}

function makeCtx(root: ReturnType<typeof buildRoot>): GenContext {
  return {
    entities: root.objects(),
    loadedRoot: root,
    matches: () => true,
    config: { outDir: "/tmp", extStyle: "none", dbImport: "~/db", dialect: "sqlite" } as never,
    warn: () => {},
  };
}

describe("templateGenerator() — per-entity pattern", () => {
  test("renders one file per entity using a custom provider", async () => {
    const provider = new InMemoryProvider({
      "custom/hello": "Hello {{name}}!\n",
    });
    const root = buildRoot();
    const gen = templateGenerator({
      name: "hello",
      template: "custom/hello",
      provider,
      walk: (r) => r.objects().map((e) => ({
        data: { name: e.name },
        outputPath: `${e.name}.txt`,
      })),
    });
    const files = await gen.generate(makeCtx(root));
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("Post.txt");
    expect(files[0]?.content).toBe("Hello Post!\n");
  });
});

describe("templateGenerator() — aggregator pattern", () => {
  test("renders ONE file aggregating all entities", async () => {
    const provider = new InMemoryProvider({
      "custom/index": "Entities:\n{{#entities}}- {{name}}\n{{/entities}}",
    });
    const root = buildRoot();
    // Add a second entity
    const e2 = metaObject(OBJECT_SUBTYPE_ENTITY, "Comment");
    e2.addChild(metaField(FIELD_SUBTYPE_LONG, "id"));
    root.addChild(e2);

    const gen = templateGenerator({
      name: "index",
      template: "custom/index",
      provider,
      walk: (r) => [{
        data: { entities: r.objects().map((e) => ({ name: e.name })) },
        outputPath: "index.md",
      }],
    });
    const files = await gen.generate(makeCtx(root));
    expect(files).toHaveLength(1);
    expect(files[0]?.content).toBe("Entities:\n- Post\n- Comment\n");
  });
});

describe("templateGenerator() — empty walk", () => {
  test("empty walk → emits zero files", async () => {
    const provider = new InMemoryProvider({ "x/y": "anything" });
    const root = buildRoot();
    const gen = templateGenerator({
      name: "empty",
      template: "x/y",
      provider,
      walk: () => [],
    });
    const files = await gen.generate(makeCtx(root));
    expect(files).toEqual([]);
  });
});

describe("buildEntityDocData() — public contract", () => {
  test("exposes the EntityDocData fields a custom template would consume", () => {
    const root = buildRoot();
    const post = root.objects().find((e) => e.name === "Post")!;
    const data = buildEntityDocData(post, {
      dialect: "sqlite",
      loadedRoot: root,
    });

    expect(data.entity.name).toBe("Post");
    expect(data.entity.type).toBe("object.entity");
    expect(data.generatedMarker).toContain("@generated");
    expect(data.validation.insertSchema).toBe("PostInsertSchema");
    expect(data.validation.updateSchema).toBe("PostUpdateSchema");
    expect(data.preambleHeader).toContain("**Type:** `object.entity`");
    expect(data.generated.length).toBeGreaterThan(0);
    expect(data.generated[0]?.filename).toBe("Post.ts");
  });
});
