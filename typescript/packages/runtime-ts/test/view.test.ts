import { describe, test, expect } from "bun:test";
import type { MetaData } from "@metaobjects/metadata";
import { TypeId, TYPE_OBJECT, TYPE_FIELD, TYPE_VIEW, TYPE_VALIDATOR,
         FIELD_SUBTYPE_STRING, FIELD_SUBTYPE_LONG,
         VIEW_SUBTYPE_TEXT, VIEW_SUBTYPE_TEXTAREA, VIEW_SUBTYPE_HIDDEN,
         VALIDATOR_SUBTYPE_REQUIRED,
         OBJECT_SUBTYPE_ENTITY } from "@metaobjects/metadata";
import { meta } from "./_meta-build.js";
import { viewFieldNames, fieldViewSpec, entityViewSpec } from "../src/view.js";
import { MetadataError } from "../src/errors.js";

function makePostWithViews(): MetaData {
  const post = meta(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), "Post");
  post.addChild(meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_LONG), "id"));

  const title = meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING), "title");
  const titleEdit = meta(new TypeId(TYPE_VIEW, VIEW_SUBTYPE_TEXT), "edit");
  titleEdit.setAttr("placeholder", "Title...");
  titleEdit.setAttr("maxLength", 200);
  title.addChild(titleEdit);
  const titleRequired = meta(new TypeId(TYPE_VALIDATOR, VALIDATOR_SUBTYPE_REQUIRED), "required");
  title.addChild(titleRequired);
  post.addChild(title);

  const body = meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING), "body");
  const bodyEdit = meta(new TypeId(TYPE_VIEW, VIEW_SUBTYPE_TEXTAREA), "edit");
  bodyEdit.setAttr("rows", 10);
  body.addChild(bodyEdit);
  post.addChild(body);

  const secret = meta(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING), "secret");
  const secretHidden = meta(new TypeId(TYPE_VIEW, VIEW_SUBTYPE_HIDDEN), "edit");
  secret.addChild(secretHidden);
  post.addChild(secret);

  return post;
}

describe("viewFieldNames", () => {
  test("returns names of fields tagged with the given view name", () => {
    const post = makePostWithViews();
    const names = viewFieldNames(post, "edit");
    expect(names).toEqual(["title", "body", "secret"]);
  });

  test("returns empty array for unknown view (does NOT throw — caller decides)", () => {
    const post = makePostWithViews();
    expect(viewFieldNames(post, "report")).toEqual([]);
  });
});

describe("fieldViewSpec", () => {
  test("returns the view spec for a tagged field", () => {
    const post = makePostWithViews();
    const spec = fieldViewSpec(post, "title", "edit");
    expect(spec).toEqual({
      fieldName: "title",
      fieldSubType: "string",
      viewName: "edit",
      controlType: VIEW_SUBTYPE_TEXT,
      attrs: { placeholder: "Title...", maxLength: 200 },
      required: true,
    });
  });

  test("returns null when field has no view tagged with that name", () => {
    const post = makePostWithViews();
    expect(fieldViewSpec(post, "id", "edit")).toBeNull();
  });

  test("returns null when field doesn't exist", () => {
    const post = makePostWithViews();
    expect(fieldViewSpec(post, "missing", "edit")).toBeNull();
  });
});

describe("entityViewSpec", () => {
  test("returns ordered field specs for the given view", () => {
    const post = makePostWithViews();
    const spec = entityViewSpec(post, "edit");
    expect(spec.entityName).toBe("Post");
    expect(spec.viewName).toBe("edit");
    expect(spec.fields.map((f) => f.fieldName)).toEqual(["title", "body", "secret"]);
    expect(spec.fields[0]?.controlType).toBe(VIEW_SUBTYPE_TEXT);
    expect(spec.fields[1]?.controlType).toBe(VIEW_SUBTYPE_TEXTAREA);
    expect(spec.fields[2]?.controlType).toBe(VIEW_SUBTYPE_HIDDEN);
  });

  test("throws MetadataError when no fields tagged with the view name", () => {
    const post = makePostWithViews();
    expect(() => entityViewSpec(post, "report")).toThrow(MetadataError);
  });
});
