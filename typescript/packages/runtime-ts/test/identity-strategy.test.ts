import { describe, test, expect } from "bun:test";
import type { MetaModel } from "@metaobjects/metadata";
import { TypeId, TYPE_OBJECT, TYPE_FIELD, TYPE_IDENTITY,
         FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_STRING,
         IDENTITY_SUBTYPE_PRIMARY, OBJECT_SUBTYPE_ENTITY,
         GENERATION_INCREMENT, GENERATION_UUID, GENERATION_ASSIGNED } from "@metaobjects/metadata";
import { meta } from "./_meta-build.js";
import { resolveIdentity, type IdentityResolution } from "../src/identity-strategy.js";
import { ValidationError } from "../src/errors.js";

function makePost(generation?: string): MetaModel {
  const post = meta(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), "Post");
  post.addChild(meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_LONG), "id"));
  const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
  primary.setAttr("fields", ["id"]);
  if (generation !== undefined) primary.setAttr("generation", generation);
  post.addChild(primary);
  return post;
}

describe("resolveIdentity — increment", () => {
  test("driver-generated when caller omits PK", () => {
    const post = makePost(GENERATION_INCREMENT);
    const res = resolveIdentity(post, {});
    expect(res.kind).toBe("driver-generated");
    expect(res.values).toEqual({});
  });

  test("preset when caller supplies PK (seeding / legacy import)", () => {
    const post = makePost(GENERATION_INCREMENT);
    const res = resolveIdentity(post, { id: 99 });
    expect(res.kind).toBe("preset");
    expect(res.values).toEqual({ id: 99 });
  });
});

describe("resolveIdentity — uuid", () => {
  test("OM generates a UUID when caller omits PK", () => {
    const post = makePost(GENERATION_UUID);
    const res = resolveIdentity(post, {});
    expect(res.kind).toBe("preset");
    expect(typeof res.values["id"]).toBe("string");
    expect(String(res.values["id"])).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("caller-supplied UUID passes through unchanged", () => {
    const post = makePost(GENERATION_UUID);
    const res = resolveIdentity(post, { id: "user-supplied" });
    expect(res.kind).toBe("preset");
    expect(res.values["id"]).toBe("user-supplied");
  });
});

describe("resolveIdentity — assigned", () => {
  test("caller MUST provide PK", () => {
    const post = makePost(GENERATION_ASSIGNED);
    const res = resolveIdentity(post, { id: 42 });
    expect(res.kind).toBe("preset");
    expect(res.values).toEqual({ id: 42 });
  });

  test("missing PK → ValidationError with field=id, rule=required", () => {
    const post = makePost(GENERATION_ASSIGNED);
    let caught: ValidationError | undefined;
    try { resolveIdentity(post, {}); } catch (e) { caught = e as ValidationError; }
    expect(caught).toBeInstanceOf(ValidationError);
    expect(caught!.errors[0]?.field).toBe("id");
    expect(caught!.errors[0]?.rule).toBe("required");
  });
});

describe("resolveIdentity — no @generation", () => {
  test("treated as 'assigned' (caller provides PK)", () => {
    const post = makePost(); // no generation attr
    const res = resolveIdentity(post, { id: 42 });
    expect(res.kind).toBe("preset");
  });
});

describe("resolveIdentity — composite PK", () => {
  test("multi-field primary always treated as 'assigned' regardless of @generation", () => {
    const userTag = meta(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), "UserTag");
    userTag.addChild(meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_LONG), "userId"));
    userTag.addChild(meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_LONG), "tagId"));
    const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
    primary.setAttr("fields", ["userId", "tagId"]);
    primary.setAttr("generation", GENERATION_INCREMENT); // ignored for composite
    userTag.addChild(primary);

    const res = resolveIdentity(userTag, { userId: 1, tagId: 5 });
    expect(res.kind).toBe("preset");

    expect(() => resolveIdentity(userTag, { userId: 1 })).toThrow(ValidationError); // missing tagId
  });
});
