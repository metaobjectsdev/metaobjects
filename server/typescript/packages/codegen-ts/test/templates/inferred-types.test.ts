import { describe, test, expect } from "bun:test";
import { OBJECT_SUBTYPE_ENTITY } from "@metaobjectsdev/metadata";
import { metaObject } from "../_meta-build.js";
import { renderInferredTypes } from "../../src/templates/inferred-types.js";

describe("renderInferredTypes", () => {
  test("emits Select + Insert + Update type aliases", () => {
    const post = metaObject(OBJECT_SUBTYPE_ENTITY, "Post");
    const out = renderInferredTypes(post).toString();
    expect(out).toContain("export type Post = InferSelectModel<typeof posts>");
    expect(out).toContain("export type PostInsert = InferInsertModel<typeof posts>");
    expect(out).toContain("export type PostUpdate = Partial<PostInsert>");
  });
});
