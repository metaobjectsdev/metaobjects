// Drift gate for examples/advanced-modeling/ — the advanced-modeling series'
// canonical spine (docs/superpowers/plans/2026-07-19-advanced-modeling-series-plan.md,
// Unit 1). Per the design doc
// (docs/superpowers/specs/2026-07-19-advanced-modeling-series-design.md,
// Decision 3), this is a FRESHNESS + CLI-composition smoke check, NOT a
// correctness gate — the four patterns' actual BEHAVIOR is already owned by
// fixtures/*-conformance/ and the codegen golden tests. What this proves:
//   1. The example's metadata still loads strict (meta verify's default) and
//      its declared template.output's mustache is drift-free against its
//      payload VO (`--templates`).
//   2. `meta gen`'s committed src/generated/** output is byte-identical to a
//      fresh regen from the current metadata (`--codegen`) — i.e. the four
//      patterns still compose cleanly through the real `meta gen` CLI path
//      the reference implementation, docs, and agent-context all cite.
//
// Runs against the REAL example directory in place (read-only from this
// gate's perspective — `verify` only writes to a throwaway temp tree), the
// same directory a contributor edits and `cd`s into to run `meta gen`/`meta
// verify` by hand. No fixture copy: the whole point is proving the COMMITTED
// tree, not a copy of it.
//
// Joins the fast lane "for free": this file lives in the `cli` package, whose
// full `bun test` suite is already part of `ci-local.sh`'s `gate_conf_ts`
// step (the ts-fast lane) — no new CI job.
//
// examples/ is NOT part of the Bun workspace (repo-root package.json globs
// only server/typescript/packages/* and client/web/packages/*), so this test
// intentionally invokes the CLI's `run()` directly rather than relying on any
// workspace-level build/link step for the example itself.

import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { run } from "../../src/index.js";

// test/integration/ -> cli -> packages -> typescript -> server -> repo root
const EXAMPLE_DIR = resolve(import.meta.dirname, "../../../../../../examples/advanced-modeling");
const GENERATED_DIR = join(EXAMPLE_DIR, "src", "generated");

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

describe("examples/advanced-modeling — drift gate (Unit 1 spine)", () => {
  test("meta verify --templates: the declared template.output is drift-free", async () => {
    // The example's mustache lives under templates/ (the directory
    // render-helper's codegen-time provider resolves — see
    // codegen-ts/src/render-engine/framework-provider.ts), not verify's
    // own "prompts" default — hence the explicit --prompts override.
    const exit = await run(["verify", "--cwd", EXAMPLE_DIR, "--templates", "--prompts", "templates"]);
    expect(exit).toBe(0);
  });

  test("meta verify --codegen: committed src/generated/** matches a fresh regen", async () => {
    const exit = await run(["verify", "--cwd", EXAMPLE_DIR, "--codegen"]);
    expect(exit).toBe(0);
  });

  // `--codegen` above only string-diffs a fresh regen against the committed
  // tree — a generator that emits DETERMINISTICALLY invalid syntax still
  // diffs clean (this is exactly how a real bug slipped through while
  // building this example: a `template.output` payload referenced by its
  // package-qualified FQN rather than its bare class name in an import
  // specifier — invalid TS, "acme::learn::X" is not a legal identifier —
  // yet self-consistent across regens). examples/ carries no node_modules
  // (it is not a workspace package — see the design doc, "not a runnable
  // application"), so a full typecheck isn't available here; Bun's
  // Transpiler parses/transforms without resolving imports, which is enough
  // to catch a syntactically-broken template emission.
  test("every committed generated file is syntactically valid TS/TSX", () => {
    const files = listFilesRecursive(GENERATED_DIR).filter(
      (f) => extname(f) === ".ts" || extname(f) === ".tsx",
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const loader = extname(file) === ".tsx" ? "tsx" : "ts";
      const transpiler = new Bun.Transpiler({ loader });
      const source = readFileSync(file, "utf8");
      expect(() => transpiler.transformSync(source)).not.toThrow();
    }
  });
});
