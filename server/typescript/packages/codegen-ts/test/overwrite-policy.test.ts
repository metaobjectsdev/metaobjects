// Three-way merge overwrite policy — the basic surface area.
// More elaborate scenarios (clean merge, conflict, integrity, missing git,
// first-time-existing) live in test/overwrite-policy/*.test.ts.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideAndWrite } from "../src/overwrite-policy.js";

let tmp: string;
let state: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codegen-policy-"));
  state = mkdtempSync(join(tmpdir(), "codegen-state-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
});

describe("decideAndWrite (three-way merge)", () => {
  test("NEW: writes when file doesn't exist + seeds .gen-state", () => {
    const path = join(tmp, "Post.ts");
    const content = "export const x = 1;\n";
    const result = decideAndWrite(path, content, {
      genStateDir: state,
      outputRelPath: "Post.ts",
    });
    expect(result.status).toBe("new");
    expect(readFileSync(path, "utf-8")).toBe(content);
    // Snapshot was seeded
    expect(existsSync(join(state, "Post.ts"))).toBe(true);
    expect(readFileSync(join(state, "Post.ts"), "utf-8")).toBe(content);
  });

  test("UNCHANGED: identical content when snapshot matches → no write, no change", () => {
    const path = join(tmp, "Post.ts");
    const content = "export const x = 1;\n";
    decideAndWrite(path, content, { genStateDir: state, outputRelPath: "Post.ts" });

    const result = decideAndWrite(path, content, {
      genStateDir: state,
      outputRelPath: "Post.ts",
    });
    expect(result.status).toBe("unchanged");
  });

  test("OVERWRITE (regen with snapshot present): fresh content lands, snapshot advances", () => {
    const path = join(tmp, "Post.ts");
    decideAndWrite(path, "old\n", { genStateDir: state, outputRelPath: "Post.ts" });

    const result = decideAndWrite(path, "new\n", {
      genStateDir: state,
      outputRelPath: "Post.ts",
    });
    // Both sides match exactly → clean merge that's effectively an overwrite.
    expect(["overwrite", "merged"]).toContain(result.status);
    expect(readFileSync(path, "utf-8")).toBe("new\n");
    expect(readFileSync(join(state, "Post.ts"), "utf-8")).toBe("new\n");
  });

  test("skip-existing strategy never writes existing files", () => {
    const path = join(tmp, "Post.ts");
    writeFileSync(path, "user wrote this\n");
    const result = decideAndWrite(path, "fresh\n", {
      genStateDir: state,
      outputRelPath: "Post.ts",
      strategy: "skip-existing",
    });
    expect(result.status).toBe("skipped");
    expect(readFileSync(path, "utf-8")).toBe("user wrote this\n");
  });

  test("first-time-existing (default baseline): identical fresh content → unchanged + seed", () => {
    const path = join(tmp, "Post.ts");
    const content = "export const x = 1;\n";
    writeFileSync(path, content);

    const result = decideAndWrite(path, content, {
      genStateDir: state,
      outputRelPath: "Post.ts",
    });
    expect(result.status).toBe("unchanged");
    expect(existsSync(join(state, "Post.ts"))).toBe(true);
  });

  test("legacy MergeStrategy string still accepted via the third arg", () => {
    const path = join(tmp, "Post.ts");
    writeFileSync(path, "current\n");
    const result = decideAndWrite(path, "fresh\n", "skip-existing");
    expect(result.status).toBe("skipped");
  });
});
