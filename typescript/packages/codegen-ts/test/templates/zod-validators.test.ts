import { describe, test, expect } from "bun:test";
import { MetaModel, TypeId, TYPE_OBJECT, TYPE_FIELD, TYPE_IDENTITY, TYPE_VALIDATOR,
         FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_STRING, FIELD_SUBTYPE_BOOLEAN,
         IDENTITY_SUBTYPE_PRIMARY, OBJECT_SUBTYPE_ENTITY,
         VALIDATOR_SUBTYPE_REGEX } from "@metaobjects/metadata";
import { renderZodValidators } from "../../src/templates/zod-validators.js";

describe("renderZodValidators", () => {
  test("emits InsertSchema with required fields and optional unset fields", () => {
    const post = new MetaModel(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), "Post");
    const id = new MetaModel(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_LONG), "id");
    post.addChild(id);
    const title = new MetaModel(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING), "title");
    title.setAttr("required", true);
    title.setAttr("maxLength", 200);
    post.addChild(title);
    const body = new MetaModel(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING), "body");
    post.addChild(body);
    const primary = new MetaModel(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
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

  test("validator.regex emits .regex(new RegExp(pattern)) — Zod expects a RegExp object, not a string", () => {
    const post = new MetaModel(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), "Post");
    const slug = new MetaModel(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING), "slug");
    slug.setAttr("required", true);
    const regex = new MetaModel(new TypeId(TYPE_VALIDATOR, VALIDATOR_SUBTYPE_REGEX), "slugFormat");
    regex.setAttr("pattern", "^[a-z0-9-]+$");
    slug.addChild(regex);
    post.addChild(slug);

    const out = renderZodValidators(post).toString();
    expect(out).toContain('.regex(new RegExp("^[a-z0-9-]+$"))');
    expect(out).not.toMatch(/\.regex\("[^"]*"\)/); // no bare-string regex argument
  });
});
