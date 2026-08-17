// The no-snapshot decision, made from the COMMITTED hash manifest.
//
// Until now, a file that existed with no `.gen-state` snapshot and content
// differing from fresh output was overwritten, and the engine reported that as
// `overwrite` — which the CLI then displayed as NEW. Because `meta init`
// gitignores the snapshot, that was the state of every fresh clone and every CI
// runner, so the documented promise that hand edits survive regeneration was
// false in exactly the situation adopters spend most of their time in.
//
// The fix rests on one question, asked of one piece of evidence: IS THIS FILE
// BYTE-FOR-BYTE WHAT WE RECORDED WRITING? `.hashes.json` answers it without the
// snapshot body, which is why the manifest is the part that gets committed —
// a hash per path is small and reviewable, where a second full copy of all
// generated output is neither.
//
//   hash matches   → nobody touched it → replacing it loses nothing
//   hash differs   → somebody edited it → REFUSE, name the file
//   no hash at all → we cannot prove anything → REFUSE (fail closed)
//
// The last case is deliberately not "adopt the file as the baseline". Recording
// hand-edited content as though we had written it would launder the edit into the
// manifest, and the NEXT run would then overwrite it with a clear conscience.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideAndWrite,
  readGeneratedHash,
  contentHash,
  listGeneratedPaths,
} from "../../src/overwrite-policy.js";

let tmp: string;
let state: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codegen-pristine-"));
  state = mkdtempSync(join(tmpdir(), "codegen-pristine-state-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
});

/** Simulate the fresh-clone shape: the committed manifest survives, the
 *  gitignored snapshot bodies do not. */
function dropSnapshotBodies(relPaths: string[]): void {
  for (const rel of relPaths) rmSync(join(state, rel), { force: true });
}

describe("no snapshot body, but a committed hash", () => {
  test("hash matches the file → safe to replace, reported as overwrite", () => {
    const path = join(tmp, "User.ts");
    const v1 = "export const x = 1;\n";
    decideAndWrite(path, v1, { genStateDir: state, outputRelPath: "User.ts" });
    dropSnapshotBodies(["User.ts"]);

    const fresh = "export const x = 2;\n";
    const result = decideAndWrite(path, fresh, {
      genStateDir: state,
      outputRelPath: "User.ts",
    });

    // Nobody edited it, so nothing is lost — and this is the common case on a
    // fresh clone, which is why it must NOT refuse.
    expect(result.status).toBe("overwrite");
    expect(readFileSync(path, "utf-8")).toBe(fresh);
    expect(readGeneratedHash(state, "User.ts")).toBe(contentHash(fresh));
  });

  test("hash does NOT match → REFUSED, and the edit survives", () => {
    const path = join(tmp, "User.ts");
    decideAndWrite(path, "export const x = 1;\n", {
      genStateDir: state,
      outputRelPath: "User.ts",
    });
    dropSnapshotBodies(["User.ts"]);

    const edited = "export const x = 1;\n// my hand edit\n";
    writeFileSync(path, edited);

    const result = decideAndWrite(path, "export const x = 2;\n", {
      genStateDir: state,
      outputRelPath: "User.ts",
    });

    expect(result.status).toBe("refused");
    expect(readFileSync(path, "utf-8")).toBe(edited);
    // The recorded hash is NOT advanced — a refusal that forgets repeats as a
    // silent overwrite on the very next run.
    expect(readGeneratedHash(state, "User.ts")).toBe(
      contentHash("export const x = 1;\n"),
    );
  });

  test("the refusal explains itself and names the way out", () => {
    const path = join(tmp, "User.ts");
    decideAndWrite(path, "a\n", { genStateDir: state, outputRelPath: "User.ts" });
    dropSnapshotBodies(["User.ts"]);
    writeFileSync(path, "hand edited\n");

    const result = decideAndWrite(path, "b\n", {
      genStateDir: state,
      outputRelPath: "User.ts",
    });
    expect(result.status).toBe("refused");
    expect(result.conflictHint).toContain("--baseline=fresh");
  });

  test("identical fresh content → unchanged, whatever the hash says", () => {
    const path = join(tmp, "User.ts");
    const content = "export const x = 1;\n";
    decideAndWrite(path, content, { genStateDir: state, outputRelPath: "User.ts" });
    dropSnapshotBodies(["User.ts"]);

    const result = decideAndWrite(path, content, {
      genStateDir: state,
      outputRelPath: "User.ts",
    });
    expect(result.status).toBe("unchanged");
  });
});

describe("no snapshot and no hash at all", () => {
  test("a pre-existing file we have no record of → REFUSED, not adopted", () => {
    const path = join(tmp, "User.ts");
    writeFileSync(path, "// hand-written, predates any codegen\n");

    const result = decideAndWrite(path, "export const x = 1;\n", {
      genStateDir: state,
      outputRelPath: "User.ts",
    });

    expect(result.status).toBe("refused");
    expect(readFileSync(path, "utf-8")).toBe("// hand-written, predates any codegen\n");
    // Nothing recorded: adopting it would launder the edit into the manifest and
    // license the next run to overwrite it.
    expect(listGeneratedPaths(state)).toEqual([]);
  });

  test("identical content with no record → unchanged, and the hash is seeded", () => {
    const path = join(tmp, "User.ts");
    const content = "export const x = 1;\n";
    writeFileSync(path, content);

    const result = decideAndWrite(path, content, {
      genStateDir: state,
      outputRelPath: "User.ts",
    });

    expect(result.status).toBe("unchanged");
    expect(readGeneratedHash(state, "User.ts")).toBe(contentHash(content));
  });
});

describe("escape hatch and non-regressions", () => {
  test('baseline: "fresh" still overwrites a hand-edited file', () => {
    const path = join(tmp, "User.ts");
    writeFileSync(path, "hand written\n");
    const fresh = "export const x = 1;\n";

    const result = decideAndWrite(path, fresh, {
      genStateDir: state,
      outputRelPath: "User.ts",
      baseline: "fresh",
    });

    expect(result.status).toBe("overwrite");
    expect(readFileSync(path, "utf-8")).toBe(fresh);
  });

  test("a file that does not exist yet is still a plain new write", () => {
    const result = decideAndWrite(join(tmp, "User.ts"), "x\n", {
      genStateDir: state,
      outputRelPath: "User.ts",
    });
    expect(result.status).toBe("new");
  });

  test("with the snapshot body present, the three-way merge still runs", () => {
    // Guards the change's blast radius: the body-present path is untouched.
    const path = join(tmp, "User.ts");
    const v1 = ["header", "a", "b", "c", "footer", ""].join("\n");
    decideAndWrite(path, v1, { genStateDir: state, outputRelPath: "User.ts" });
    expect(existsSync(join(state, "User.ts"))).toBe(true);

    writeFileSync(path, ["header", "a EDITED", "b", "c", "footer", ""].join("\n"));
    const fresh = ["header", "a", "b", "c", "footer", "added", ""].join("\n");

    const result = decideAndWrite(path, fresh, {
      genStateDir: state,
      outputRelPath: "User.ts",
    });

    expect(result.status).toBe("merged");
    const merged = readFileSync(path, "utf-8");
    expect(merged).toContain("a EDITED");
    expect(merged).toContain("added");
  });
});

describe("the manifest is a committed artifact", () => {
  test("keys are sorted, so a committed diff is stable and reviewable", () => {
    // Written out of order on purpose: insertion order would make the diff (and
    // any merge conflict) depend on which entities happened to generate first.
    for (const rel of ["z.ts", "a.ts", "m.ts"]) {
      decideAndWrite(join(tmp, rel), `// ${rel}\n`, {
        genStateDir: state,
        outputRelPath: rel,
      });
    }
    const raw = readFileSync(join(state, ".hashes.json"), "utf-8");
    const keys = Object.keys(JSON.parse(raw) as Record<string, string>);
    expect(keys).toEqual(["a.ts", "m.ts", "z.ts"]);
  });
});
