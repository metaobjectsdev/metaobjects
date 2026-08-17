// Caveat 3 — first-time regen on an existing file (no .gen-state snapshot body).
//
// This file used to assert that different fresh content OVERWRITES the existing
// file, with a fixture whose pre-existing content read "user wrote this". That was
// the documented intent at the time and it is now reversed: because `meta init`
// gitignores the snapshot, "no snapshot" is the state of every fresh clone and CI
// runner, so the promise that hand edits survive regeneration was false exactly
// where adopters live.
//
// The decision now comes from the COMMITTED hash manifest:
//   - identical fresh content            → unchanged, hash seeded
//   - file still hashes to what we wrote → overwrite (nothing is lost)
//   - anything else                      → refused, naming the file
// `baseline: "fresh"` remains the explicit overwrite-and-re-baseline escape hatch.
//
// The pristine and no-record cases are covered in detail by pristine-hash.test.ts.

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

  test("default baseline: different content we have no record of → REFUSED", () => {
    const path = join(tmp, "User.ts");
    writeFileSync(path, "user wrote this\n");

    const fresh = "export const x = 1;\n";
    const result = decideAndWrite(path, fresh, {
      genStateDir: state,
      outputRelPath: "User.ts",
    });
    expect(result.status).toBe("refused");
    // The whole point: "user wrote this" is still there.
    expect(readFileSync(path, "utf-8")).toBe("user wrote this\n");
    // And no snapshot is seeded — adopting this content as our own baseline would
    // license the next run to overwrite it without hesitation.
    expect(existsSync(join(state, "User.ts"))).toBe(false);
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
