import { describe, test, expect } from "bun:test";
import { formatGenResult } from "../../src/lib/output.js";

const sample = {
  files: [
    { path: "User.ts", status: "new" as const, info: "124 lines" },
    { path: "User.queries.ts", status: "new" as const, info: "87 lines" },
    { path: "Post.ts", status: "merged" as const, info: "3-way, no conflicts" },
    { path: "Post.queries.ts", status: "conflict" as const, info: "resolve markers" },
    { path: "Comment.ts", status: "unchanged" as const, info: "" },
    { path: "Tag.ts", status: "refused" as const, info: "extra hand-written code" },
  ],
  outDir: "./src/db",
  dialect: "sqlite" as const,
  dryRun: false,
  warnings: [],
};

describe("formatGenResult", () => {
  test("non-TTY output uses plain words", () => {
    const out = formatGenResult(sample, { isTTY: false });
    expect(out).toContain("NEW");
    expect(out).toContain("MERGED");
    expect(out).toContain("CONFLICT");
    expect(out).toContain("UNCHANGED");
    expect(out).toContain("REFUSED");
    expect(out).not.toContain("✓");
    expect(out).not.toContain("✗");
  });

  test("TTY output uses glyphs", () => {
    const out = formatGenResult(sample, { isTTY: true });
    expect(out).toContain("✓");
    expect(out).toContain("↺");
    expect(out).toContain("✗");
  });

  test("includes file paths and info", () => {
    const out = formatGenResult(sample, { isTTY: false });
    expect(out).toContain("User.ts");
    expect(out).toContain("124 lines");
    expect(out).toContain("./src/db");
    expect(out).toContain("sqlite");
  });

  test("footer summary counts statuses", () => {
    const out = formatGenResult(sample, { isTTY: false });
    expect(out).toMatch(/2 written/);
    expect(out).toMatch(/1 merged/);
    expect(out).toMatch(/1 conflict/);
    expect(out).toMatch(/1 unchanged/);
    expect(out).toMatch(/1 refused/);
  });

  test("dry-run header reads 'meta gen --dry-run'", () => {
    const out = formatGenResult({ ...sample, dryRun: true }, { isTTY: false });
    expect(out).toContain("--dry-run");
  });

  test("empty file list shows 'No entities to generate.'", () => {
    const out = formatGenResult({ ...sample, files: [] }, { isTTY: false });
    expect(out).toContain("No entities to generate");
  });
});
