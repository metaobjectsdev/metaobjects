import { describe, test, expect } from "bun:test";
import { classifyViewDiff } from "../src/view-diff.js";

describe("classifyViewDiff", () => {
  test("identical column lists → no-change", () => {
    expect(classifyViewDiff(
      { columns: ["id", "title"] },
      { columns: ["id", "title"] },
    )).toBe("no-change");
  });

  test("new column appended at end → safe-append", () => {
    expect(classifyViewDiff(
      { columns: ["id", "title"] },
      { columns: ["id", "title", "weekCount"] },
    )).toBe("safe-append");
  });

  test("column dropped → breaking", () => {
    expect(classifyViewDiff(
      { columns: ["id", "title", "extra"] },
      { columns: ["id", "title"] },
    )).toBe("breaking");
  });

  test("column renamed → breaking", () => {
    expect(classifyViewDiff(
      { columns: ["id", "fullName"] },
      { columns: ["id", "displayName"] },
    )).toBe("breaking");
  });

  test("column reordered → safe-replace (data shape unchanged)", () => {
    expect(classifyViewDiff(
      { columns: ["id", "title", "weekCount"] },
      { columns: ["id", "weekCount", "title"] },
    )).toBe("safe-replace");
  });

  test("type change on existing column → breaking", () => {
    expect(classifyViewDiff(
      { columns: ["id", "title"], columnTypes: { title: "text" } },
      { columns: ["id", "title"], columnTypes: { title: "int" } },
    )).toBe("breaking");
  });
});
