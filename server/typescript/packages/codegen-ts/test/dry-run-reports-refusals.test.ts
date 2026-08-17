// `meta gen --dry-run` must report a refusal as a refusal.
//
// The preview reported `existsSync(path) ? "overwrite" : "new"`, so a hand-edited
// file — the one case the refusal exists for — previewed as "overwrite" while the
// real run refused. That is the same defect as the original `NEW` mislabel, one
// layer up: a preview that misdescribes the outcome is worse than no preview.
//
// The one place a coarse answer is still honest is the snapshot-body-present path:
// whether a three-way merge comes back clean or conflicted genuinely cannot be
// known without performing it. Everything the body-absent path decides is a hash
// comparison, which a preview can do exactly.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideAndWrite, previewWriteStatus } from "../src/overwrite-policy.js";

let tmp: string;
let state: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "dry-preview-"));
  state = mkdtempSync(join(tmpdir(), "dry-preview-state-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
});

const opts = () => ({ genStateDir: state, outputRelPath: "User.ts" });

describe("previewWriteStatus agrees with decideAndWrite", () => {
  test("a hand-edited file previews REFUSED, not overwrite", () => {
    const path = join(tmp, "User.ts");
    decideAndWrite(path, "export const x = 1;\n", opts());
    rmSync(join(state, "User.ts"), { force: true });          // fresh-clone shape
    writeFileSync(path, "export const x = 1;\n// my edit\n");

    const previewed = previewWriteStatus(path, "export const x = 2;\n", opts());
    expect(previewed).toBe("refused");

    // And the preview is what the real run then does — the property that matters.
    const actual = decideAndWrite(path, "export const x = 2;\n", opts()).status;
    expect(actual).toBe(previewed);
  });

  test("a file we have no record of previews REFUSED", () => {
    const path = join(tmp, "User.ts");
    writeFileSync(path, "// hand-written\n");
    expect(previewWriteStatus(path, "fresh\n", opts())).toBe("refused");
  });

  test("a pristine file previews overwrite, and does overwrite", () => {
    const path = join(tmp, "User.ts");
    decideAndWrite(path, "export const x = 1;\n", opts());
    rmSync(join(state, "User.ts"), { force: true });

    const previewed = previewWriteStatus(path, "export const x = 2;\n", opts());
    expect(previewed).toBe("overwrite");
    expect(decideAndWrite(path, "export const x = 2;\n", opts()).status).toBe(previewed);
  });

  test("identical content previews unchanged", () => {
    const path = join(tmp, "User.ts");
    decideAndWrite(path, "export const x = 1;\n", opts());
    expect(previewWriteStatus(path, "export const x = 1;\n", opts())).toBe("unchanged");
  });

  test("a path that does not exist previews new", () => {
    expect(previewWriteStatus(join(tmp, "Nope.ts"), "x\n", opts())).toBe("new");
  });

  test("--baseline=fresh previews overwrite even for a hand-edited file", () => {
    const path = join(tmp, "User.ts");
    writeFileSync(path, "// hand-written\n");
    expect(
      previewWriteStatus(path, "fresh\n", { ...opts(), baseline: "fresh" }),
    ).toBe("overwrite");
  });

  test("previewing NEVER touches the file or the manifest", () => {
    const path = join(tmp, "User.ts");
    writeFileSync(path, "// hand-written\n");
    previewWriteStatus(path, "fresh\n", opts());
    expect(readFileSync(path, "utf-8")).toBe("// hand-written\n");
    expect(existsSync(join(state, ".hashes.json"))).toBe(false);
  });

  test("with the snapshot body present it stays coarse, and says so honestly", () => {
    // A merge can come back clean or conflicted; the preview does not guess. It
    // reports that the file WILL be rewritten, which is true either way.
    const path = join(tmp, "User.ts");
    decideAndWrite(path, ["a", "b", "c", ""].join("\n"), opts());
    writeFileSync(path, ["a EDITED", "b", "c", ""].join("\n"));
    expect(previewWriteStatus(path, ["a", "b", "c", "d", ""].join("\n"), opts()))
      .toBe("overwrite");
  });
});
