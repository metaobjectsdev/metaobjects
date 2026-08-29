// The showcase corpus is what metaobjects.dev publishes as "real `meta gen`
// output". A stale tree is a stale claim on a public page, so the gate is not
// "does it generate" — it is "is what is committed exactly what the five ports
// produce today".
//
// `--check` regenerates PRISTINE into a temp tree and byte-compares. It never
// writes to the repo, so it is safe in the gates lane and in the release
// preflight (which runs right after the clean-tree check).
//
// Why not `git status` after a regen, and why not `verify --codegen`: both are
// blind to a COMMITTED hand edit inside a generated file. `meta gen`
// three-way-merges hand edits by design and reports `merged`, leaving the tree
// clean and the hash in sync — correct for a consumer project, wrong for this
// one, whose whole contract is that the committed output is purely generated.
// Measured in Task 1, not assumed.
import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "../..");

describe("regen-showcase", () => {
  test(
    "--check exits 0 when committed output matches a fresh regen",
    () => {
      const r = spawnSync("bun", ["scripts/regen-showcase.ts", "--check"], {
        cwd: REPO,
        encoding: "utf8",
      });
      if (r.status !== 0) {
        throw new Error(`showcase is stale:\n${r.stdout ?? ""}${r.stderr ?? ""}`);
      }
      expect(r.status).toBe(0);
    },
    // Cold, this builds the C# CLI and resolves the Python venv.
    600_000,
  );
});
