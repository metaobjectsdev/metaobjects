/**
 * `verify --codegen` against an EJECTED generator — FR-040 design §6.3.
 *
 * The spec left this as an open question: an ejected generator is the adopter's own
 * source, so drift detection against it is presumably still correct, but "the
 * interaction with the three-way merge base deserves an explicit answer." This file
 * is that answer, pinned as a check rather than written as a paragraph.
 *
 * The answer is that `verify --codegen` needs no knowledge of ejection at all — and
 * that is a property worth pinning rather than a coincidence. The gate re-runs the
 * SAME `runGen` over the SAME loaded config, and a generator's provenance (imported
 * from `@metaobjectsdev/*`, or read from `./codegen/generators/`) is invisible to
 * both. So "what a fresh regen would produce" automatically means "what the ADOPTER'S
 * generator would produce". Three consequences, one test each:
 *
 *   1. Ejecting is not itself drift. `meta eject` copies the template byte-for-byte,
 *      so the owned generator emits exactly what the packaged one emitted.
 *   2. Editing the owned generator IS drift, and the committed output is convicted —
 *      which is the whole point of owning it. The gate follows the adopter's source,
 *      never the package's.
 *   3. The printed remedy terminates. That is NOT free: it is precisely where the
 *      0.24.3 hand-edit loop lived. There the remedy could not work, because
 *      `meta gen` re-merged the edit and the next verify failed identically. Here it
 *      does work, because the discriminator is `.gen-state/.hashes.json` — a record
 *      of what the GENERATOR WROTE — and re-running `meta gen` writes through the new
 *      generator and re-records the hash. The two cases must not be conflated: a hand
 *      edit in a generated FILE is preserved and forgiven, while a change to the
 *      GENERATOR is real drift until regenerated. Test 3 holds both at once — a
 *      preserved hand edit sitting in the same file as a regenerated generator change.
 *
 * WHY SUBPROCESSES. This gate must run the built CLI under node, one process per
 * command, exactly as an adopter does. In-process (`run()` from bun:test) it cannot
 * see the behaviour at all and reports a FALSE PASS: the config file is re-read under
 * a fresh random temp name on every load, but the `./codegen/generators/entity.js` it
 * imports resolves to a stable path and stays in the module cache, so the second load
 * silently re-uses the PRE-EDIT generator and `verify` finds no drift. An in-process
 * version of test 2 therefore passes for the wrong reason while asserting the
 * opposite of the truth. Do not "simplify" this file back to in-process `run()`.
 */
import { describe, test, expect } from "bun:test";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";

const CLI_ROOT = resolve(import.meta.dirname, "..", "..");
const META_BIN = join(CLI_ROOT, "dist", "bin", "meta.js");
const FIXTURES = resolve(import.meta.dirname, "..", "fixtures");
// Inside the workspace, so the ejected template's `@metaobjectsdev/codegen-ts` import
// resolves by walking up to the workspace root.
const WORKSPACE_TMP = join(FIXTURES, "__tmp__");

const OUT = "generated";
const USER_TS = join(OUT, "User.ts");
const EJECTED = join("codegen", "generators", "entity.ts");

const CONFIG = [
  `import { defineConfig } from "@metaobjectsdev/codegen-ts";`,
  `// The ownership move FR-040 exists to make first-class: the local copy, not the package.`,
  `import { entityFile } from "./codegen/generators/entity.js";`,
  `export default defineConfig({`,
  `  outDir: ${JSON.stringify(OUT)},`,
  `  dialect: "sqlite",`,
  `  dbImport: "~/db",`,
  `  extStyle: "none",`,
  `  generators: [entityFile()],`,
  `});`,
].join("\n");

/** Newest .ts mtime under a src dir (excluding reference/ scaffold assets, which the
 *  CLI reads from src at runtime and which need no rebuild). */
function newestSrcMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "reference") continue;
      newest = Math.max(newest, newestSrcMtime(p));
    } else if (entry.name.endsWith(".ts")) {
      newest = Math.max(newest, statSync(p).mtimeMs);
    }
  }
  return newest;
}

/** This gate runs the BUILT CLI under node, so it needs a dist at least as new as src.
 *  A stale/missing dist is rebuilt in place; if that does not converge, fail loudly
 *  rather than skip (a silent skip is how gates go vacuous). */
function ensureFreshDist(): void {
  const req = createRequire(import.meta.url);
  const codegenTsRoot = dirname(req.resolve("@metaobjectsdev/codegen-ts/package.json"));
  const sdkRoot = dirname(req.resolve("@metaobjectsdev/sdk/package.json"));
  for (const { name, pkgRoot, srcDir, distFile } of [
    { name: "codegen-ts", pkgRoot: codegenTsRoot, srcDir: join(codegenTsRoot, "src"), distFile: join(codegenTsRoot, "dist", "index.js") },
    { name: "cli", pkgRoot: CLI_ROOT, srcDir: join(CLI_ROOT, "src"), distFile: META_BIN },
    { name: "sdk", pkgRoot: sdkRoot, srcDir: join(sdkRoot, "src"), distFile: join(sdkRoot, "dist", "index.js") },
  ]) {
    const stale = (): boolean =>
      !existsSync(distFile) || newestSrcMtime(srcDir) > statSync(distFile).mtimeMs;
    if (!stale()) continue;
    console.error(`[verify-codegen-ejected gate] ${name} dist is stale — rebuilding in ${pkgRoot}`);
    const build = Bun.spawnSync(["bun", "run", "build"], { cwd: pkgRoot, stdout: "pipe", stderr: "pipe" });
    if (build.exitCode !== 0 || stale()) {
      throw new Error(
        `${name} dist is missing or older than its src and the in-place rebuild did not fix it — ` +
          `this gate runs the built CLI under node; run: bun run --filter '*' build\n${build.stderr.toString()}`,
      );
    }
  }
}

interface CliResult {
  exit: number;
  output: string;
}

/** One `meta` invocation, in its own process — the adopter path (`#!/usr/bin/env node`). */
async function meta(cwd: string, ...args: string[]): Promise<CliResult> {
  const proc = Bun.spawn(["node", META_BIN, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exit, output: `${out}\n${err}` };
}

/**
 * A project that owns its entity generator: the fixture metadata, a real
 * `meta eject entity`, and a config importing the OWNED copy rather than the package.
 */
async function setupRepo(): Promise<string> {
  mkdirSync(WORKSPACE_TMP, { recursive: true });
  const root = mkdtempSync(join(WORKSPACE_TMP, "forge-verify-ejected-"));
  cpSync(join(FIXTURES, "trainer-website-meta"), root, { recursive: true });

  const ejected = await meta(root, "eject", "entity");
  expect({ step: "eject", ...ejected }).toMatchObject({ step: "eject", exit: 0 });
  if (!existsSync(join(root, EJECTED))) throw new Error(`eject wrote no ${EJECTED}`);

  writeFileSync(join(root, "metaobjects.config.ts"), CONFIG);
  return root;
}

/** Change what the OWNED generator emits — the move ejection exists to enable. */
function editOwnedGenerator(root: string, marker: string): void {
  const p = join(root, EJECTED);
  const src = readFileSync(p, "utf8");
  const anchor = "`// ${GENERATED_HEADER} — DO NOT EDIT.\\n` +";
  if (!src.includes(anchor)) {
    throw new Error("the ejected entity template no longer has the header line this test edits");
  }
  writeFileSync(p, src.replace(anchor, `${anchor}\n    \`// ${marker}\\n\` +`), "utf8");
}

/** The other sanctioned move: hand-editing inside a generated file. */
function handEdit(root: string): void {
  appendFileSync(
    join(root, USER_TS),
    "\n// hand-written, preserved by three-way merge\nexport const HAND_EDIT = 1;\n",
  );
}

describe("meta verify --codegen — an ejected (adopter-owned) generator", () => {
  test("owning a generator is not itself drift", async () => {
    ensureFreshDist();
    const root = await setupRepo();
    try {
      expect(await meta(root, "gen")).toMatchObject({ exit: 0 });

      const verified = await meta(root, "verify", "--codegen");
      expect(verified).toMatchObject({ exit: 0 });
      expect(verified.output).not.toContain("User.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  test("editing the owned generator is drift — the gate follows the adopter's source", async () => {
    ensureFreshDist();
    const root = await setupRepo();
    try {
      expect(await meta(root, "gen")).toMatchObject({ exit: 0 });
      expect(readFileSync(join(root, USER_TS), "utf8")).not.toContain("owned-by-adopter");

      // Change the generator and do NOT re-run gen. The committed output is now stale
      // with respect to the adopter's OWN generator — drift the package never saw.
      editOwnedGenerator(root, "owned-by-adopter");

      const verified = await meta(root, "verify", "--codegen");
      expect(verified).toMatchObject({ exit: 1 });
      expect(verified.output).toContain("User.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  test("the remedy terminates, and a hand edit still survives the regen", async () => {
    ensureFreshDist();
    const root = await setupRepo();
    try {
      expect(await meta(root, "gen")).toMatchObject({ exit: 0 });
      handEdit(root);
      expect(await meta(root, "gen")).toMatchObject({ exit: 0 });
      expect(readFileSync(join(root, USER_TS), "utf8")).toContain("HAND_EDIT");

      editOwnedGenerator(root, "owned-by-adopter");
      expect(await meta(root, "verify", "--codegen")).toMatchObject({ exit: 1 });

      // The printed remedy. Unlike the 0.24.3 hand-edit loop, this one converges:
      // gen writes through the new generator and re-records the hash.
      expect(await meta(root, "gen")).toMatchObject({ exit: 0 });

      const verified = await meta(root, "verify", "--codegen");
      expect(verified).toMatchObject({ exit: 0 });
      expect(verified.output).not.toContain("User.ts");

      // Both contracts hold together: the generator change landed, the hand edit stayed.
      const emitted = readFileSync(join(root, USER_TS), "utf8");
      expect(emitted).toContain("owned-by-adopter");
      expect(emitted).toContain("HAND_EDIT");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
