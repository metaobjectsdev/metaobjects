// Clean-merge scenario (spike's EASY case): user adds whitespace / a comment
// between generated lines; the merge integrates it transparently and the user
// keeps their edit.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideAndWrite } from "../../src/overwrite-policy.js";

let tmp: string;
let state: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codegen-merge-"));
  state = mkdtempSync(join(tmpdir(), "codegen-state-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
});

describe("clean three-way merge", () => {
  test("user adds a comment between fields; regen integrates new field cleanly", () => {
    const path = join(tmp, "User.ts");
    const v1 = [
      "export const User = table({",
      '  email: varchar("email", { length: 100 }),',
      '  username: varchar("username"),',
      "});",
      "",
    ].join("\n");

    // 1. First gen: seed both the output and the .gen-state snapshot.
    const first = decideAndWrite(path, v1, { genStateDir: state, outputRelPath: "User.ts" });
    expect(first.status).toBe("new");

    // 2. User adds a comment between email and username.
    const userEdit = [
      "export const User = table({",
      '  email: varchar("email", { length: 100 }),',
      "  // login identifier",
      '  username: varchar("username"),',
      "});",
      "",
    ].join("\n");
    writeFileSync(path, userEdit);

    // 3. v2 from codegen adds a `bio` field at the bottom; no other changes.
    const v2 = [
      "export const User = table({",
      '  email: varchar("email", { length: 100 }),',
      '  username: varchar("username"),',
      '  bio: text("bio"),',
      "});",
      "",
    ].join("\n");
    const result = decideAndWrite(path, v2, {
      genStateDir: state,
      outputRelPath: "User.ts",
    });

    // Merge succeeded — should be "merged".
    expect(result.status).toBe("merged");

    const finalContent = readFileSync(path, "utf-8");
    expect(finalContent).toContain("// login identifier");
    expect(finalContent).toContain('bio: text("bio"),');
    // No conflict markers.
    expect(finalContent).not.toContain("<<<<<<<");
    expect(finalContent).not.toContain(">>>>>>>");

    // Snapshot advances to the fresh content (NOT the merged content) so the
    // next merge correctly identifies the canonical baseline.
    expect(readFileSync(join(state, "User.ts"), "utf-8")).toBe(v2);
  });
});
