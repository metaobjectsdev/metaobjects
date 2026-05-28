// Caveat 2 — .gen-state integrity. Each snapshot is hashed at write time;
// on subsequent runs we re-hash and validate. If the hash doesn't match the
// stored value (someone tampered with .gen-state), we treat the snapshot as
// absent and fall back to first-time-existing semantics.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideAndWrite } from "../../src/overwrite-policy.js";

let tmp: string;
let state: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codegen-int-"));
  state = mkdtempSync(join(tmpdir(), "codegen-state-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
});

describe(".gen-state integrity", () => {
  test("tampered snapshot → falls back to first-time-existing behavior", () => {
    const path = join(tmp, "User.ts");
    const v1 = "export const x = 1;\n";
    decideAndWrite(path, v1, { genStateDir: state, outputRelPath: "User.ts" });
    expect(existsSync(join(state, "User.ts"))).toBe(true);

    // Manually corrupt the snapshot — hash will no longer match.
    writeFileSync(join(state, "User.ts"), "tampered content\n");

    // User has their own edit
    const userEdit = "export const x = 2;\n// user comment\n";
    writeFileSync(path, userEdit);

    // Fresh content from a new run
    const fresh = "export const x = 3;\n";
    const result = decideAndWrite(path, fresh, {
      genStateDir: state,
      outputRelPath: "User.ts",
    });

    // Tampered snapshot is ignored — falls back to first-time-existing:
    // existing content (userEdit) differs from fresh → overwrite.
    expect(result.status).toBe("overwrite");
    expect(readFileSync(path, "utf-8")).toBe(fresh);
    // Snapshot is re-seeded with fresh + fresh hash.
    expect(readFileSync(join(state, "User.ts"), "utf-8")).toBe(fresh);
  });

  test("hashes file present + intact → real three-way merge runs", () => {
    const path = join(tmp, "User.ts");
    // Use a body with enough surrounding context that user's edit on line2
    // and codegen's added line at the bottom don't overlap diff hunks.
    const v1 = [
      "header",
      "field email",
      "field name",
      "field age",
      "footer",
      "",
    ].join("\n");
    decideAndWrite(path, v1, { genStateDir: state, outputRelPath: "User.ts" });

    // Hashes file is present.
    expect(existsSync(join(state, ".hashes.json"))).toBe(true);
    const hashes = JSON.parse(readFileSync(join(state, ".hashes.json"), "utf-8"));
    expect(hashes["User.ts"]).toBeDefined();

    // User edits the "field email" line (line 2)
    const userEdit = [
      "header",
      "field email_addr",
      "field name",
      "field age",
      "footer",
      "",
    ].join("\n");
    writeFileSync(path, userEdit);

    // Codegen adds "field bio" before footer (line ~5). These hunks are
    // far enough apart that diff3 doesn't see a conflict.
    const v2 = [
      "header",
      "field email",
      "field name",
      "field age",
      "field bio",
      "footer",
      "",
    ].join("\n");
    const result = decideAndWrite(path, v2, {
      genStateDir: state,
      outputRelPath: "User.ts",
    });

    expect(result.status).toBe("merged");
    const final = readFileSync(path, "utf-8");
    expect(final).toContain("email_addr"); // user edit survived
    expect(final).toContain("bio"); // codegen edit landed
  });
});
