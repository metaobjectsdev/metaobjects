import { describe, test, expect } from "bun:test";
import { MetaModel, TypeId, TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY } from "@metaobjects/metadata";
import { renderInferredTypes } from "../../src/templates/inferred-types.js";

describe("renderInferredTypes", () => {
  test("emits Select + Insert type aliases", () => {
    const post = new MetaModel(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), "Post");
    const out = renderInferredTypes(post).toString();
    expect(out).toContain("export type Post = InferSelectModel<typeof posts>");
    expect(out).toContain("export type NewPost = InferInsertModel<typeof posts>");
  });
});
