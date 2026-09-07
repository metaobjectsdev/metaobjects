#!/usr/bin/env bun
// Re-sync this repo's OWNED copies of the reference generator templates.
//
// `owned-copies-current.test.ts` requires every owned copy in this repo — the
// `test-generators` package's `src/`, and one set per `examples/*/codegen/generators/`
// — to be byte-identical to the shipped `codegen-ts/src/reference/<name>.ts`. That
// gate exists because a drifted copy lets the suites and examples keep passing while
// proving nothing about what an adopter actually runs.
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
// that example's decision, and adding one silently would change what it demonstrates.

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";

import {
  readReferenceTemplate,
  REFERENCE_GENERATOR_NAMES,
  type ReferenceGeneratorName,
} from "../server/typescript/packages/codegen-ts/src/index.js";

const REPO_ROOT = resolve(import.meta.dir, "..");
const CHECK = process.argv.includes("--check");

/** Same discovery the gate uses — a new owned copy is covered the moment it lands. */
function ownedCopyDirs(): string[] {
  const dirs = [join(REPO_ROOT, "server/typescript/packages/test-generators/src")];
  const examples = join(REPO_ROOT, "examples");
  if (existsSync(examples)) {
    for (const e of readdirSync(examples, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const d = join(examples, e.name, "codegen", "generators");
      if (existsSync(d)) dirs.push(d);
    }
  }
  return dirs;
}

const names = new Set<string>(REFERENCE_GENERATOR_NAMES);
const stale: string[] = [];
let written = 0;
let checked = 0;

for (const dir of ownedCopyDirs()) {
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts")) continue;
    const name = file.slice(0, -3);
    if (!names.has(name)) continue;

    const shipped = readReferenceTemplate(name as ReferenceGeneratorName);
    const path = join(dir, file);
    checked++;
    if (readFileSync(path, "utf8") === shipped) continue;

    stale.push(relative(REPO_ROOT, path));
    if (!CHECK) {
      writeFileSync(path, shipped);
      written++;
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
