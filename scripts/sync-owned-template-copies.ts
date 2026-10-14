#!/usr/bin/env bun
// Re-sync this repo's OWNED copies of the reference generator templates.
//
// `owned-copies-current.test.ts` requires every owned copy in this repo — the
// `test-generators` package, and one set per `examples/*/codegen/` — to be exactly what
// `meta eject` writes today: the generator, and the template modules it calls
// (ADR-0034 Amendment 8), which sit in a `templates/` directory beside the generators'. That
// gate exists because a drifted copy lets the suites and examples keep passing while proving
// nothing about what an adopter actually runs.
//
// The gate had no counterpart: changing a reference template turned 12 tests red with
// no command to make them green, so the only path was 12 hand copies — exactly the
// friction that makes people edit the gate instead. This is that command.
//
//   bun scripts/sync-owned-template-copies.ts            # write
//   bun scripts/sync-owned-template-copies.ts --check    # report, exit 1 if stale
//
// It copies ONLY names that already exist as an owned copy in a directory. It never
// introduces a new owned generator into an example — which copies an example owns is
// that example's decision, and adding one silently would change what it demonstrates. The
// template modules are different: they are not a decision, they are what the generators
// that ARE owned call, so the directory is made to hold exactly those.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";

import { expectedFor, ownedTiers, tsFilesUnder } from "../server/typescript/packages/cli/test/support/owned-tiers.js";

const REPO_ROOT = resolve(import.meta.dir, "..");
const CHECK = process.argv.includes("--check");

const stale: string[] = [];
let written = 0;
let checked = 0;

function sync(path: string, content: string): void {
  checked++;
  if (existsSync(path) && readFileSync(path, "utf8") === content) return;
  stale.push(relative(REPO_ROOT, path));
  if (CHECK) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  written++;
}

for (const tier of ownedTiers()) {
  const { generators, templates } = expectedFor(tier);
  for (const [path, content] of generators) sync(path, content);
  for (const [path, content] of templates) sync(path, content);
  // A template module this tier no longer calls is stale too, and left in place it would be
  // dead code the gate cannot see.
  for (const path of tsFilesUnder(tier.templates)) {
    if (templates.has(path)) continue;
    checked++;
    stale.push(`${relative(REPO_ROOT, path)} (no owned generator calls it)`);
    if (!CHECK) {
      rmSync(path);
      written++;
    }
  }
}

// ADR-0034 Amendment 3 (2026-09-24): an example owning `entity` / `routes` also owns the
// HTTP-adapter source their output imports, under `codegen/runtime/`, verbatim from
// runtime-ts/src. Same rule as above — only files that already exist are re-synced.
const RUNTIME_SRC = join(REPO_ROOT, "server/typescript/packages/runtime-ts/src");
const examplesDir = join(REPO_ROOT, "examples");
if (existsSync(examplesDir)) {
  for (const e of readdirSync(examplesDir, { withFileTypes: true })) {
    const root = join(examplesDir, e.name, "codegen", "runtime");
    if (!e.isDirectory() || !existsSync(root)) continue;
    for (const f of readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (!f.isFile() || !f.name.endsWith(".ts")) continue;
      const path = join(f.parentPath, f.name);
      const upstream = join(RUNTIME_SRC, relative(root, path));
      if (!existsSync(upstream)) continue;
      sync(path, readFileSync(upstream, "utf8"));
    }
  }
}

// A run that matched nothing would report success having done nothing — the same
// vacuous-pass shape the gate itself guards against.
if (checked === 0) {
  console.error("sync-owned-template-copies: found no owned copies at all — check the discovery paths.");
  process.exit(1);
}

if (stale.length === 0) {
  console.log(`sync-owned-template-copies: ${checked} owned cop(ies) already current.`);
  process.exit(0);
}

if (CHECK) {
  console.error(`sync-owned-template-copies: ${stale.length} of ${checked} owned cop(ies) are STALE:`);
  for (const s of stale) console.error(`  ${s}`);
  console.error("Run `bun scripts/sync-owned-template-copies.ts` to re-sync.");
  process.exit(1);
}

console.log(`sync-owned-template-copies: re-synced ${written} of ${checked} owned cop(ies):`);
for (const s of stale) console.log(`  ${s}`);
