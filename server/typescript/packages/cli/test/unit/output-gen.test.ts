import { describe, test, expect } from "bun:test";
import { formatGenResult, genResultToData } from "../../src/lib/output.js";

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
  generatorCount: 4,
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

// Two ways to emit nothing, and they send the reader to different files (F78). A config
// wiring NO generators cannot produce output however good the metadata is, and the old
// line told its author to go write entities — a false statement about a project that
// already had five. The run's own first line (`gen: []`) already knew.
test("emitting nothing because no generator is wired says THAT, not 'author entities'", () => {
  const data = genResultToData({ ...sample, files: [], generatorCount: 0 });
  expect(data.summary).toContain("no generators are wired");
  expect(data.summary).not.toContain("no entities to generate");
  expect(data.help.join(" ")).toContain("metaobjects.config.ts");
  expect(data.help.join(" ")).not.toContain("author entities");
});

test("...and emitting nothing WITH generators wired still points at the metadata", () => {
  const data = genResultToData({ ...sample, files: [], generatorCount: 4 });
  expect(data.summary).toContain("no entities to generate");
  expect(data.help.join(" ")).toContain("author entities");
});
