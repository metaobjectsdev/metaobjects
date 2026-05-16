import { describe, test, expect } from "bun:test";
import { TypeId, TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY } from "@metaobjects/metadata";
import { meta } from "../_meta-build.js";
import { renderInferredTypes } from "../../src/templates/inferred-types.js";

describe("renderInferredTypes", () => {
  test("emits Select + Insert type aliases", () => {
    const post = meta(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), "Post");
    const out = renderInferredTypes(post).toString();
    expect(out).toContain("export type Post = InferSelectModel<typeof posts>");
    expect(out).toContain("export type NewPost = InferInsertModel<typeof posts>");
  });
});
