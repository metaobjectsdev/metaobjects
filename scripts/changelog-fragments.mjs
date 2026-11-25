#!/usr/bin/env node
// Changelog fragments (changelog.d/): check them, preview them, or fold them into CHANGELOG.md.
//
//   node scripts/changelog-fragments.mjs --check      # every fragment is well-formed (gates lane)
//   node scripts/changelog-fragments.mjs --preview    # print CHANGELOG.md as assembly would write it
//   node scripts/changelog-fragments.mjs --assemble   # write it, and delete the fragments
//
// `scripts/release.mjs` assembles on its own; run --assemble by hand when preparing a release
// section ahead of the cut, so the entries are in CHANGELOG.md before you edit it.
// The format and why it exists: scripts/lib/changelog-fragments.mjs, changelog.d/README.md.

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FRAGMENT_DIR, assembleChangelog, fragmentProblems, readFragments } from "./lib/changelog-fragments.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, FRAGMENT_DIR);
const CHANGELOG = join(ROOT, "CHANGELOG.md");
const mode = process.argv[2];

const fragments = readFragments(DIR);
const problems = fragments.flatMap((f) => fragmentProblems(f.name, f.text));
if (problems.length > 0) {
  console.error(`${FRAGMENT_DIR}/ has malformed fragments (format: ${FRAGMENT_DIR}/README.md):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

if (mode === "--check") {
  console.log(`ok: ${fragments.length} changelog fragment(s) well-formed`);
} else if (mode === "--preview") {
  process.stdout.write(assembleChangelog(readFileSync(CHANGELOG, "utf8"), fragments));
} else if (mode === "--assemble") {
  if (fragments.length === 0) {
    console.log(`no fragments in ${FRAGMENT_DIR}/ — CHANGELOG.md unchanged`);
  } else {
    writeFileSync(CHANGELOG, assembleChangelog(readFileSync(CHANGELOG, "utf8"), fragments));
    for (const f of fragments) rmSync(join(DIR, f.name));
    console.log(`assembled ${fragments.length} fragment(s) into CHANGELOG.md [Unreleased] and removed them`);
  }
} else {
  console.error("usage: node scripts/changelog-fragments.mjs --check | --preview | --assemble");
  process.exit(2);
}
