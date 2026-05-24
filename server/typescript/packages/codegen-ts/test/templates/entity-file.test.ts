import { describe, test, expect } from "bun:test";
import { TypeId, TYPE_IDENTITY,
         FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_STRING, FIELD_SUBTYPE_ENUM,
         IDENTITY_SUBTYPE_PRIMARY, OBJECT_SUBTYPE_ENTITY,
         MetaDataLoader, InMemorySource } from "@metaobjectsdev/metadata";
import { meta, metaRoot, metaObject, metaField } from "../_meta-build.js";
import { renderEntityFile } from "../../src/templates/entity-file.js";
import { makeRenderContext } from "../../src/render-context.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";
import { GENERATED_HEADER } from "../../src/constants.js";

describe("renderEntityFile", () => {
  test("inline field.enum emits named type alias <Entity><FieldPascal>", () => {
    const root = metaRoot();
    const order = metaObject(OBJECT_SUBTYPE_ENTITY, "Order");
    const id = metaField(FIELD_SUBTYPE_LONG, "id");
    order.addChild(id);
    const status = metaField(FIELD_SUBTYPE_ENUM, "status");
    status.setAttr("values", ["DRAFT", "PUBLISHED"]);
    order.addChild(status);
    const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
    primary.setAttr("fields", ["id"]);
    primary.setAttr("generation", "increment");
    order.addChild(primary);
    root.addChild(order);

    const ctx = makeRenderContext({
      dialect: "sqlite",
      loadedRoot: root,
      outDir: "/x",
      dbImport: "~/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
    });

    const out = renderEntityFile(order, ctx);
    expect(out).toContain('export type OrderStatus = "DRAFT" | "PUBLISHED";');
  });

  test("field.enum extends abstract — emits type alias using super field name", async () => {
    const result = await new MetaDataLoader().load([new InMemorySource(JSON.stringify({
      "metadata.root": {
        "package": "acme",
        "children": [
          { "field.enum": { "name": "Status", "abstract": true, "@values": ["DRAFT", "PUBLISHED", "ARCHIVED"] } },
          {
            "object.entity": {
              "name": "Order",
              "children": [
                { "field.long": { "name": "id" } },
                { "field.enum": { "name": "status", "extends": "Status" } },
                { "identity.primary": { "@fields": ["id"], "@generation": "increment" } }
              ]
            }
          }
        ]
      }
    }))]);
    expect(result.errors).toEqual([]);
    const root = result.root;
    const order = root.objects()[0]!;

    const ctx = makeRenderContext({
      dialect: "sqlite",
      loadedRoot: root,
      outDir: "/x",
      dbImport: "~/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
    });

    const out = renderEntityFile(order, ctx);
    // The type alias should use "Status" (the abstract super's name), not "OrderStatus"
    expect(out).toContain('export type Status = "DRAFT" | "PUBLISHED" | "ARCHIVED";');
    expect(out).not.toContain("export type OrderStatus");
  });

  test("two fields extending the SAME abstract field.enum → ONE type alias", async () => {
    const result = await new MetaDataLoader().load([new InMemorySource(JSON.stringify({
      "metadata.root": {
        "package": "acme",
        "children": [
          { "field.enum": { "name": "Status", "abstract": true, "@values": ["DRAFT", "PUBLISHED"] } },
          {
            "object.entity": {
              "name": "Order",
              "children": [
                { "field.long": { "name": "id" } },
                { "field.enum": { "name": "status", "extends": "Status" } },
                { "field.enum": { "name": "shipmentStatus", "extends": "Status" } },
                { "identity.primary": { "@fields": ["id"], "@generation": "increment" } }
              ]
            }
          }
        ]
      }
    }))]);
    expect(result.errors).toEqual([]);
    const root = result.root;
    const order = root.objects()[0]!;

    const ctx = makeRenderContext({
      dialect: "sqlite",
      loadedRoot: root,
      outDir: "/x",
      dbImport: "~/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
    });

    const out = renderEntityFile(order, ctx);
    // De-duplicated by alias name: both fields share the "Status" super, so the
    // alias is emitted exactly once.
    const aliasCount = out.split('export type Status = "DRAFT" | "PUBLISHED";').length - 1;
    expect(aliasCount).toBe(1);
  });

  test("two distinct inline enums on one entity → two <Entity><Field> aliases", () => {
    const root = metaRoot();
    const order = metaObject(OBJECT_SUBTYPE_ENTITY, "Order");
    const id = metaField(FIELD_SUBTYPE_LONG, "id");
    order.addChild(id);
    const status = metaField(FIELD_SUBTYPE_ENUM, "status");
    status.setAttr("values", ["DRAFT", "PUBLISHED"]);
    order.addChild(status);
    const priority = metaField(FIELD_SUBTYPE_ENUM, "priority");
    priority.setAttr("values", ["LOW", "HIGH"]);
    order.addChild(priority);
    const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
    primary.setAttr("fields", ["id"]);
    primary.setAttr("generation", "increment");
    order.addChild(primary);
    root.addChild(order);

    const ctx = makeRenderContext({
      dialect: "sqlite",
      loadedRoot: root,
      outDir: "/x",
      dbImport: "~/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
    });

    const out = renderEntityFile(order, ctx);
    expect(out).toContain('export type OrderStatus = "DRAFT" | "PUBLISHED";');
    expect(out).toContain('export type OrderPriority = "LOW" | "HIGH";');
  });

  test("emits JSDoc above entity type from description / deprecated / seeAlso", async () => {
    const result = await new MetaDataLoader().load([new InMemorySource(JSON.stringify({
      "metadata.root": {
        "package": "acme",
        "children": [
          {
            "object.entity": {
              "name": "Order",
              "@description": "An order placed by a User.",
              "@deprecated": "Use OrderV2.",
              "@replacedBy": "OrderV2",
              "@seeAlso": ["https://acme.com/docs/order"],
              "children": [
                { "field.long": { "name": "id" } },
                { "identity.primary": { "@fields": ["id"], "@generation": "increment" } }
              ]
            }
          }
        ]
      }
    }))]);
    expect(result.errors).toEqual([]);
    const root = result.root;
    const order = root.objects()[0]!;

    const ctx = makeRenderContext({
      dialect: "sqlite",
      loadedRoot: root,
      outDir: "/x",
      dbImport: "~/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
    });

    const out = renderEntityFile(order, ctx);
    expect(out).toContain("/**");
    expect(out).toContain("An order placed by a User.");
    expect(out).toContain("@deprecated Use OrderV2. Replaced by OrderV2.");
    expect(out).toContain("@see https://acme.com/docs/order");
  });

  test("emits JSDoc above a field column line from field @description", async () => {
    const result = await new MetaDataLoader().load([new InMemorySource(JSON.stringify({
      "metadata.root": {
        "package": "acme",
        "children": [
          {
            "object.entity": {
              "name": "User",
              "children": [
                { "field.long": { "name": "id" } },
                { "field.string": { "name": "email", "@description": "Primary email address." } },
                { "identity.primary": { "@fields": ["id"], "@generation": "increment" } }
              ]
            }
          }
        ]
      }
    }))]);
    expect(result.errors).toEqual([]);
    const root = result.root;
    const user = root.objects()[0]!;

    const ctx = makeRenderContext({
      dialect: "sqlite",
      loadedRoot: root,
      outDir: "/x",
      dbImport: "~/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
    });

    const out = renderEntityFile(user, ctx);
    // Per-field JSDoc lands above the Drizzle column line for `email`.
    expect(out).toMatch(/\/\*\* Primary email address\. \*\/\s*email:/);
  });

  test("does NOT emit `notes` content in JSDoc (D5)", async () => {
    const result = await new MetaDataLoader().load([new InMemorySource(JSON.stringify({
      "metadata.root": {
        "package": "acme",
        "children": [
          {
            "object.entity": {
              "name": "User",
              "@description": "Public.",
              "@notes": "INTERNAL_SECRET",
              "children": [
                { "field.long": { "name": "id" } },
                { "identity.primary": { "@fields": ["id"], "@generation": "increment" } }
              ]
            }
          }
        ]
      }
    }))]);
    expect(result.errors).toEqual([]);
    const root = result.root;
    const user = root.objects()[0]!;

    const ctx = makeRenderContext({
      dialect: "sqlite",
      loadedRoot: root,
      outDir: "/x",
      dbImport: "~/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
    });

    const out = renderEntityFile(user, ctx);
    expect(out).not.toContain("INTERNAL_SECRET");
  });

  test("emits @generated header + table + types + validators", () => {
    const root = metaRoot();
    const post = metaObject(OBJECT_SUBTYPE_ENTITY, "Post");
    const id = metaField(FIELD_SUBTYPE_LONG, "id");
    post.addChild(id);
    const title = metaField(FIELD_SUBTYPE_STRING, "title");
    title.setAttr("required", true);
    post.addChild(title);
    const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
    primary.setAttr("fields", ["id"]);
    primary.setAttr("generation", "increment");
    post.addChild(primary);
    root.addChild(post);

    const ctx = makeRenderContext({
      dialect: "sqlite",
      loadedRoot: root,
      outDir: "/x",
      dbImport: "~/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
    });

    const out = renderEntityFile(post, ctx);
    expect(out).toContain(GENERATED_HEADER);
    expect(out).toContain("sqliteTable");
    expect(out).toContain("InferSelectModel");
    expect(out).toContain("PostInsertSchema");
    expect(out).toContain("import");
    expect(out).toContain("drizzle-orm/sqlite-core");
    expect(out).toContain("drizzle-orm");
    expect(out).toContain("zod");
  });
});
