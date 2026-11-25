#!/usr/bin/env node
// Tests for scripts/lib/changelog-fragments.mjs.
//
//   node scripts/test-changelog-fragments.mjs

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assembleChangelog, fragmentNames, fragmentProblems, readFragments } from "./lib/changelog-fragments.mjs";

let fails = 0;
const check = (cond, label) => (cond ? console.log(`ok:   ${label}`) : (console.error(`FAIL: ${label}`), fails++));

const LOG = "# Changelog\n\n## [Unreleased]\n\n- an entry already here\n\n## [1.2.3] — 2026-11-15\n\n- old\n";
const A = { name: "a-fix.md", text: "- **A fix.** It reads\n  two lines.\n" };
const B = { name: "b-feature.md", text: "- **A feature.**\n\n  With a second paragraph.\n\n" };

let r = assembleChangelog(LOG, [A, B]);
check(
  r === "# Changelog\n\n## [Unreleased]\n\n- **A fix.** It reads\n  two lines.\n\n- **A feature.**\n\n  With a second paragraph.\n\n- an entry already here\n\n## [1.2.3] — 2026-11-15\n\n- old\n",
  "fragments land at the top of [Unreleased], in order, one blank line apart, above the existing entries",
);
check(assembleChangelog(LOG, []) === LOG, "no fragments leaves the CHANGELOG byte-identical");

const empty = "# Changelog\n\n## [Unreleased]\n\n## [1.3.0] — unreleased\n\n- prepared\n";
r = assembleChangelog(empty, [A]);
check(r.includes("## [Unreleased]\n\n- **A fix.** It reads\n  two lines.\n\n## [1.3.0] — unreleased"), "an empty [Unreleased] above a prepared section gains the entry, and the section below is untouched");

let threw = false;
try { assembleChangelog("# Changelog\n", [A]); } catch { threw = true; }
check(threw, "a CHANGELOG with no [Unreleased] heading refuses rather than dropping fragments");

check(fragmentProblems(A.name, A.text).length === 0, "a one-bullet fragment is well-formed");
check(fragmentProblems(B.name, B.text).length === 0, "a fragment with an indented second paragraph is well-formed");
check(fragmentProblems("x.md", "  \n").some((p) => p.includes("empty")), "an empty fragment is refused");
check(fragmentProblems("x.md", "A sentence.\n").some((p) => p.includes("bullet")), "a fragment that is not a bullet is refused");
check(fragmentProblems("x.md", "- one\n- two\n").some((p) => p.includes("one change")), "two top-level bullets are refused");
check(fragmentProblems("x.md", "- one\n  - nested\n").length === 0, "a nested bullet is allowed");
check(fragmentProblems("x.md", "- one\n### Fixed\n").some((p) => p.includes("heading")), "a heading line is refused");
check(fragmentProblems("Bad Name.md", "- ok\n").some((p) => p.includes("name")), "a name with capitals or spaces is refused");
check(fragmentProblems("x.txt", "- ok\n").some((p) => p.includes("name")), "a name not ending in .md is refused");

const dir = mkdtempSync(join(process.env.DEV_SCRATCH || tmpdir(), "changelog-fragments-"));
try {
  check(fragmentNames(join(dir, "absent")).length === 0, "a missing changelog.d/ has no fragments");
  writeFileSync(join(dir, "README.md"), "# not an entry\n");
  writeFileSync(join(dir, "b.md"), "- b\n");
  writeFileSync(join(dir, "a.md"), "- a\n");
  mkdirSync(join(dir, "sub"));
  const read = readFragments(dir);
  check(read.map((f) => f.name).join(",") === "a.md,b.md", "fragments are read in name order, README and directories skipped");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (fails > 0) {
  console.error(`\n${fails} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
