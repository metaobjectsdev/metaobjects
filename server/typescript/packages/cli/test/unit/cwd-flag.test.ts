import { describe, test, expect } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import { run } from "../../src/index.js";

const FIXTURES = resolve(import.meta.dirname, "../fixtures");

describe("--cwd / -C global flag", () => {
  test("--cwd <path> points a command at that directory", async () => {
    const repo = mkdtempSync(join(tmpdir(), "metaobjects-cwd-flag-"));
    cpSync(join(FIXTURES, "trainer-website-meta"), repo, { recursive: true });
    try {
      const exit = await run(["export", "--cwd", repo]);
      expect(exit).toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("-C <path> is an alias for --cwd", async () => {
    const repo = mkdtempSync(join(tmpdir(), "metaobjects-C-flag-"));
    cpSync(join(FIXTURES, "trainer-website-meta"), repo, { recursive: true });
    try {
      const exit = await run(["export", "-C", repo]);
      expect(exit).toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("relative --cwd resolves against the launch directory", async () => {
    // Create the temp repo *under* process.cwd() so a genuine relative path
    // exists — a repo under the OS tmpdir would share no prefix with cwd.
    const repo = mkdtempSync(join(process.cwd(), "metaobjects-cwd-rel-"));
    cpSync(join(FIXTURES, "trainer-website-meta"), repo, { recursive: true });
    try {
      const rel = relative(process.cwd(), repo);
      expect(rel.startsWith("..")).toBe(false); // genuinely relative, under cwd
      const exit = await run(["export", "--cwd", rel]);
      expect(exit).toBe(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("--cwd with no value is an error (exit 2)", async () => {
    const exit = await run(["export", "--cwd"]);
    expect(exit).toBe(2);
  });
});
