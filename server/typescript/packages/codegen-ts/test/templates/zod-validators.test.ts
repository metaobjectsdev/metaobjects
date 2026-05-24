import { describe, test, expect } from "bun:test";
import { TypeId, TYPE_IDENTITY, TYPE_VALIDATOR,
         FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_STRING, FIELD_SUBTYPE_ENUM,
         IDENTITY_SUBTYPE_PRIMARY, OBJECT_SUBTYPE_ENTITY,
         VALIDATOR_SUBTYPE_REGEX,
         MetaDataLoader, InMemorySource } from "@metaobjectsdev/metadata";
import { meta, metaObject, metaField } from "../_meta-build.js";
import { renderZodValidators } from "../../src/templates/zod-validators.js";

describe("renderZodValidators", () => {
  test("emits InsertSchema with required fields and optional unset fields", () => {
    const post = metaObject(OBJECT_SUBTYPE_ENTITY, "Post");
    const id = metaField(FIELD_SUBTYPE_LONG, "id");
    post.addChild(id);
    const title = metaField(FIELD_SUBTYPE_STRING, "title");
    title.setAttr("required", true);
    title.setAttr("maxLength", 200);
    post.addChild(title);
    const body = metaField(FIELD_SUBTYPE_STRING, "body");
    post.addChild(body);
    const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
    primary.setAttr("fields", ["id"]);
    primary.setAttr("generation", "increment");
    post.addChild(primary);

    const out = renderZodValidators(post).toString();
    expect(out).toContain("export const PostInsertSchema");
    expect(out).toContain("z.string().min(1).max(200)"); // title: required + maxLength in insert
    expect(out).toContain("z.string().optional()"); // body in insert
    expect(out).toContain("export const PostUpdateSchema");
    // UpdateSchema is now an explicit z.object() with all fields optional
    expect(out).toContain("z.string().min(1).max(200).optional()"); // title in update: optional
    // PK with autoIncrement should NOT appear in InsertSchema or UpdateSchema
    expect(out).not.toContain("id:");
  });

  test("field.enum emits z.enum([...]) with quoted member strings", () => {
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

    const out = renderZodValidators(order).toString();
    expect(out).toContain('z.enum(["DRAFT", "PUBLISHED"])');
    expect(out).not.toContain("z.string()"); // no fallback string type for enum field
  });

  test("validator.regex emits .regex(new RegExp(pattern)) — Zod expects a RegExp object, not a string", () => {
    const post = metaObject(OBJECT_SUBTYPE_ENTITY, "Post");
    const slug = metaField(FIELD_SUBTYPE_STRING, "slug");
    slug.setAttr("required", true);
    const regex = meta(new TypeId(TYPE_VALIDATOR, VALIDATOR_SUBTYPE_REGEX), "slugFormat");
    regex.setAttr("pattern", "^[a-z0-9-]+$");
    slug.addChild(regex);
    post.addChild(slug);

    const out = renderZodValidators(post).toString();
    expect(out).toContain('.regex(new RegExp("^[a-z0-9-]+$"))');
    expect(out).not.toMatch(/\.regex\("[^"]*"\)/); // no bare-string regex argument
  });

  test("emits JSDoc above InsertSchema + UpdateSchema from entity @description", async () => {
    const result = await new MetaDataLoader().load([new InMemorySource(JSON.stringify({
      "metadata.root": {
        "package": "acme",
        "children": [
          {
            "object.entity": {
              "name": "User",
              "@description": "A registered account holder.",
              "children": [
                { "field.long": { "name": "id" } },
                { "field.string": { "name": "email" } },
                { "identity.primary": { "@fields": ["id"], "@generation": "increment" } }
              ]
            }
          }
        ]
      }
    }))]);
    expect(result.errors).toEqual([]);
    const user = result.root.objects()[0]!;

    const out = renderZodValidators(user).toString();
    // The one-liner JSDoc form for a single-line description.
    const jsdoc = "/** A registered account holder. */";
    expect(out).toContain(jsdoc);
    expect(out).toContain("export const UserInsertSchema");
    expect(out).toContain("export const UserUpdateSchema");
    // Both schemas get the JSDoc — assert two occurrences.
    const occurrences = out.split(jsdoc).length - 1;
    expect(occurrences).toBe(2);
  });

  test("renderZodValidators does NOT emit `notes` content (D5)", async () => {
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
    const user = result.root.objects()[0]!;

    expect(renderZodValidators(user).toString()).not.toContain("INTERNAL_SECRET");
  });
});
