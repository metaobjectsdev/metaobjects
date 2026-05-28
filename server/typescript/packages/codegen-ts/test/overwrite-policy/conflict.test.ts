// Conflict scenario (spike's CONFLICT case): both sides edit the same line.
// Result: standard git diff3 markers in the output, .gen-state NOT advanced,
// status === "conflict".

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideAndWrite } from "../../src/overwrite-policy.js";

let tmp: string;
let state: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codegen-conflict-"));
  state = mkdtempSync(join(tmpdir(), "codegen-state-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
});

describe("three-way merge — conflict", () => {
  test("both sides edit the same line → diff3 markers, snapshot NOT advanced", () => {
    const path = join(tmp, "User.ts");
    const v1 = [
      "export const User = table({",
      '  email: varchar("email", { length: 100 }),',
      "});",
      "",
    ].join("\n");

    decideAndWrite(path, v1, { genStateDir: state, outputRelPath: "User.ts" });

    // User changes length to 200
    const userEdit = [
      "export const User = table({",
      '  email: varchar("email", { length: 200 }),',
      "});",
      "",
    ].join("\n");
    writeFileSync(path, userEdit);

    // Codegen also bumps length, but to 150
    const v2 = [
      "export const User = table({",
      '  email: varchar("email", { length: 150 }),',
      "});",
      "",
    ].join("\n");
    const result = decideAndWrite(path, v2, {
      genStateDir: state,
      outputRelPath: "User.ts",
    });

    expect(result.status).toBe("conflict");
    expect(result.conflictHint).toContain("merge conflict");

    const finalContent = readFileSync(path, "utf-8");
    expect(finalContent).toContain("<<<<<<<");
    expect(finalContent).toContain("|||||||");
    expect(finalContent).toContain("=======");
    expect(finalContent).toContain(">>>>>>>");
    // Labels we supply to git merge-file.
    expect(finalContent).toContain("your edits");
    expect(finalContent).toContain("last generated");
    expect(finalContent).toContain("fresh from meta gen");

    // Snapshot must NOT advance — still v1.
    expect(readFileSync(join(state, "User.ts"), "utf-8")).toBe(v1);
  });
});
