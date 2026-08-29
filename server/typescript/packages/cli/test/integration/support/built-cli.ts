/**
 * Driving the BUILT CLI from a test — one `node dist/bin/meta.js` per command.
 *
 * Two integration gates need this rather than an in-process `run()`, for different
 * reasons, and both reasons are about module topology:
 *
 *   - `gen-split-tree-single-import` needs a real resolver, because an in-process
 *     bun:test import produces a different module graph (Bun's native loader takes over
 *     from jiti) and cannot reproduce the duplicate-ts-poet failure at all.
 *   - `verify-codegen-ejected-generator` needs a fresh process PER COMMAND, because the
 *     config is re-read under a new temp name on every load while the
 *     `./codegen/generators/*.js` it imports keeps its stable path in the module cache —
 *     so in-process, a second load silently re-uses the PRE-EDIT generator and the gate
 *     passes while asserting the opposite of the truth.
 *
 * The two had a 46-line verbatim copy of this between them. The fragile part is the
 * rebuild triple below: it encodes which dists a `node dist/bin/meta.js` run depends on,
 * and when that set changes, a second copy silently keeps gating against a stale dist —
 * exactly the drift `support/scope-fixture.ts`'s header describes. One copy, here.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";

/** `server/typescript/packages/cli` — this file lives at test/integration/support/. */
export const CLI_ROOT = resolve(import.meta.dirname, "..", "..", "..");
export const META_BIN = join(CLI_ROOT, "dist", "bin", "meta.js");

/** Newest .ts mtime under a src dir, excluding `reference/` — those are scaffold assets
 *  the CLI reads from src at runtime and that no build output depends on. */
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

/** The packages whose dist a `node dist/bin/meta.js` run actually loads. */
function gatedPackages(): Array<{ name: string; srcDir: string; distFile: string }> {
  const req = createRequire(import.meta.url);
  const rootOf = (pkg: string): string => dirname(req.resolve(`${pkg}/package.json`));
  const codegenTs = rootOf("@metaobjectsdev/codegen-ts");
  const sdk = rootOf("@metaobjectsdev/sdk");
  return [
    { name: "codegen-ts", srcDir: join(codegenTs, "src"), distFile: join(codegenTs, "dist", "index.js") },
    { name: "cli", srcDir: join(CLI_ROOT, "src"), distFile: META_BIN },
    { name: "sdk", srcDir: join(sdk, "src"), distFile: join(sdk, "dist", "index.js") },
  ];
}

/**
 * Assert the built dist a subprocess gate needs is at least as new as its src.
 *
 * FAILS rather than rebuilding. A test that shells out to `bun run build` is a second,
 * partial build system that has to track how the workspace builds, and it mutates the
 * developer's tree as a side effect of running the suite — including, under a parallel
 * lane, two processes building one package at once. The error names the exact command,
 * which is all the auto-rebuild was buying.
 *
 * Call once per FILE (`beforeAll`), not per test.
 */
export function requireFreshDist(): void {
  const stale = gatedPackages().filter(
    ({ srcDir, distFile }) =>
      !existsSync(distFile) || newestSrcMtime(srcDir) > statSync(distFile).mtimeMs,
  );
  if (stale.length === 0) return;
  throw new Error(
    `${stale.map((s) => s.name).join(", ")}: dist is missing or older than src. This gate runs ` +
      "the BUILT CLI under node, so it cannot be trusted against a stale build.\n" +
      "Run: bun run --filter '*' build",
  );
}

/**
 * Same precondition, but REBUILDS a stale dist in place instead of failing.
 *
 * `gen-split-tree-single-import` chose this deliberately — "a red gate on every src edit
 * trains people to ignore it" — and that call is not revisited here. It shares the
 * package list above so the two gates cannot disagree about which dists a
 * `node dist/bin/meta.js` run depends on, which is the part that actually rots.
 * A gate whose whole point is a clean-checkout module topology should prefer
 * {@link requireFreshDist}.
 */
export function ensureFreshDist(): void {
  for (const { name, srcDir, distFile } of gatedPackages()) {
    const pkgRoot = dirname(distFile).endsWith("bin") ? CLI_ROOT : dirname(dirname(distFile));
    const stale = (): boolean =>
      !existsSync(distFile) || newestSrcMtime(srcDir) > statSync(distFile).mtimeMs;
    if (!stale()) continue;
    console.error(`[built-cli gate] ${name} dist is stale — rebuilding in ${pkgRoot}`);
    const build = Bun.spawnSync(["bun", "run", "build"], { cwd: pkgRoot, stdout: "pipe", stderr: "pipe" });
    if (build.exitCode !== 0 || stale()) {
      throw new Error(
        `${name} dist is missing or older than its src and the in-place rebuild did not fix it — ` +
          `this gate runs the built CLI under node; run: bun run --filter '*' build\n${build.stderr.toString()}`,
      );
    }
  }
}

export interface CliResult {
  exit: number;
  /** stdout and stderr joined — these commands write to both. */
  output: string;
}

/** One `meta` invocation in its own process — the adopter path (`#!/usr/bin/env node`). */
export async function meta(cwd: string, ...args: string[]): Promise<CliResult> {
  const proc = Bun.spawn(["node", META_BIN, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exit, output: `${out}\n${err}` };
}
