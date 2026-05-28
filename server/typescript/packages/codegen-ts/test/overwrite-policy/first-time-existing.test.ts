// Caveat 3 — first-time regen on an existing file (no .gen-state).
// Default baseline: write-if-different against the existing file (the
// existing content is treated as the canonical baseline; subsequent runs do
// real three-way merges).
//   - identical fresh content → unchanged, .gen-state seeded
//   - different fresh content → overwrite, .gen-state seeded with fresh
// `baseline: "fresh"` opts into explicit overwrite-and-re-baseline.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideAndWrite } from "../../src/overwrite-policy.js";

let tmp: string;
let state: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codegen-ftx-"));
  state = mkdtempSync(join(tmpdir(), "codegen-state-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
});

describe("first-time-on-existing-file", () => {
  test("default baseline: identical content → unchanged, snapshot seeded", () => {
    const path = join(tmp, "User.ts");
    const content = "export const x = 1;\n";
    writeFileSync(path, content);

    const result = decideAndWrite(path, content, {
      genStateDir: state,
      outputRelPath: "User.ts",
    });
    expect(result.status).toBe("unchanged");
    expect(existsSync(join(state, "User.ts"))).toBe(true);
    expect(readFileSync(join(state, "User.ts"), "utf-8")).toBe(content);
  });

  test("default baseline: different content → overwrite, snapshot seeded with fresh", () => {
    const path = join(tmp, "User.ts");
    writeFileSync(path, "user wrote this\n");

    const fresh = "export const x = 1;\n";
    const result = decideAndWrite(path, fresh, {
      genStateDir: state,
      outputRelPath: "User.ts",
    });
    expect(result.status).toBe("overwrite");
    expect(readFileSync(path, "utf-8")).toBe(fresh);
    expect(readFileSync(join(state, "User.ts"), "utf-8")).toBe(fresh);
  });

  test('baseline: "fresh" → overwrite and re-baseline even for identical content', () => {
    const path = join(tmp, "User.ts");
    const fresh = "export const x = 1;\n";
    writeFileSync(path, "stale content\n");

    const result = decideAndWrite(path, fresh, {
      genStateDir: state,
      outputRelPath: "User.ts",
      baseline: "fresh",
    });
    expect(result.status).toBe("overwrite");
    expect(readFileSync(path, "utf-8")).toBe(fresh);
    expect(readFileSync(join(state, "User.ts"), "utf-8")).toBe(fresh);
  });
});
