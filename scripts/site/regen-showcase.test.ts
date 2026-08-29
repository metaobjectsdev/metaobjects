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
  // `--bun-only` on purpose: this file runs in the gates lane, which is guarded on
  // bun alone and is the documented pre-PR command. Maven alone costs ~20s — more
  // than every other port together — and a lane that shells out to mvn/dotnet/uv
  // would FAIL rather than skip on a machine without them. The skipped ports are
  // named in the output, and the release preflight runs `--all-ports`, which
  // refuses to leave any of them out.
  const r = spawnSync("bun", ["scripts/regen-showcase.ts", "--check", "--bun-only"], {
    cwd: REPO,
    encoding: "utf8",
  });

  test("--check --bun-only exits 0 when the ts and sql output match a fresh regen", () => {
    if (r.status !== 0) {
      throw new Error(`showcase is stale:\n${r.stdout ?? ""}${r.stderr ?? ""}`);
    }
    expect(r.status).toBe(0);
  });

  // The scope above is a deliberate cost decision, so it has to stay a decision:
  // if every port became bun-drivable the flag would be a no-op nobody removed,
  // and if a new port arrived it would sit unchecked here with nothing saying so.
  test("--bun-only genuinely leaves ports out, and names them", () => {
    expect(r.stdout).toContain("NOT checked");
  });
});
