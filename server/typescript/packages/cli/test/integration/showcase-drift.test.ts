// Drift gate for examples/showcase/ — the corpus metaobjects.dev publishes.
//
// This is a FRESHNESS check, not a correctness gate: the metamodel behaviour it
// exercises is already owned by fixtures/*-conformance/ and the codegen golden
// tests. What it proves is narrower and load-bearing for the WEBSITE — that the
// code the site publishes as "real `meta gen` output" actually is.
//
// ── Why `verify --codegen` is NOT sufficient here ────────────────────────────
//
// Hand edits inside a generated file are SANCTIONED by the framework: `meta gen`
// three-way-merges them, reports `merged`, and `verify --codegen` compares a
// fresh regen's hash against the RECORDED one — so an edit that survives the
// merge is in-sync by design. That is right for a consumer project and wrong for
// this one. Measured, not assumed: renaming `subscribers` to `subscribersRENAMED`
// in the committed output leaves `--codegen` reporting "no codegen drift", `meta
// gen` reporting `merged`, and the edit still on disk — so the website would
// publish a hand-written line as generated output, and nothing would say so.
//
// The showcase carries a stricter contract than a normal project: its committed
// output must be PURELY generated. A pristine regen — model and config copied to
// an empty tree with no `.gen-state` — has no merge base, so it emits exactly
// what the generator produces. Byte-comparing that against the committed tree is
// the only check that can tell the two apart.
import { describe, test, expect } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { run } from "../../src/index.js";

// test/integration/ -> cli -> packages -> typescript -> server -> repo root
const SHOWCASE = resolve(import.meta.dirname, "../../../../../../examples/showcase");

function listFilesRecursive(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFilesRecursive(full, base));
    else out.push(relative(base, full));
  }
  return out.sort();
}

describe("examples/showcase — drift gate (the site's corpus)", () => {
  test("metadata loads strict and the prompt template is drift-free", async () => {
    // --prompts is required: verify's default prompts dir is `prompts`, and this
    // example's text lives in `templates/`. Without it the failure is
    // ERR_PARTIAL_UNRESOLVED ("your text file is missing") — a different error
    // that is still non-zero, so only asserting the exit code would hide it.
    const exit = await run([
      "verify", "--cwd", SHOWCASE, "--templates", "--prompts", "templates",
    ]);
    expect(exit).toBe(0);
  });

  test("committed output carries no codegen drift and no orphans", async () => {
    const exit = await run(["verify", "--cwd", SHOWCASE, "--codegen"]);
    expect(exit).toBe(0);
  });

  test("committed output is byte-identical to a PRISTINE regen (no hand edits)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "showcase-pristine-"));
    try {
      // Model, templates, owned generators and config only — deliberately NO .gen-state,
      // so the generator has no merge base and cannot preserve an edit. `codegen/` carries
      // the ADR-0034 owned generator copies the config imports; without it the regen fails
      // to resolve `./codegen/generators/entity` and this gate reports a config error as
      // if it were drift.
      for (const item of ["metaobjects", "templates", "codegen", "metaobjects.config.ts"]) {
        cpSync(join(SHOWCASE, item), join(tmp, item), { recursive: true });
      }
      cpSync(join(SHOWCASE, ".metaobjects", "config.json"),
             join(tmp, ".metaobjects", "config.json"), { recursive: true });

      const exit = await run(["gen", "--cwd", tmp]);
      expect(exit).toBe(0);

      // Scoped to the TS port: `generated/` also holds the python/csharp/sql
      // trees, which this run does not produce. Their equivalent gate is
      // `bun scripts/regen-showcase.ts --check`, which regenerates all four the
      // same pristine way; this one is the TS half, run where the TS CLI is.
      const fresh = join(tmp, "generated", "ts");
      const committed = join(SHOWCASE, "generated", "ts");
      expect(listFilesRecursive(fresh)).toEqual(listFilesRecursive(committed));

      for (const rel of listFilesRecursive(fresh)) {
        const a = readFileSync(join(fresh, rel), "utf8");
        const b = readFileSync(join(committed, rel), "utf8");
        if (a !== b) {
          throw new Error(
            `generated/${rel} differs from a pristine regen — the site would ` +
            `publish a hand-edited file as generated output. Run \`meta gen\` in ` +
            `examples/showcase after deleting the file, or revert the edit.`);
        }
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
