import { describe, test, expect } from "bun:test";
import { renderBarrel } from "../../src/templates/barrel.js";
import { GENERATED_HEADER } from "../../src/constants.js";

describe("renderBarrel", () => {
  test("emits alphabetical exports + @generated header", () => {
    const out = renderBarrel([
      { name: "Post", package: undefined },
      { name: "Comment", package: undefined },
      { name: "User", package: undefined },
    ]);
    expect(out).toContain(GENERATED_HEADER);
    // Alphabetical
    const postIdx = out.indexOf("Post");
    const commentIdx = out.indexOf("Comment");
    const userIdx = out.indexOf("User");
    expect(commentIdx).toBeLessThan(postIdx);
    expect(postIdx).toBeLessThan(userIdx);
    expect(out).toContain("export * from \"./Post\"");
  });

  test("empty entity list still emits header + nothing", () => {
    const out = renderBarrel([]);
    expect(out).toContain(GENERATED_HEADER);
  });
});
