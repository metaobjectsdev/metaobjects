#!/usr/bin/env node
// Tests for scripts/lib/changelog-promote.mjs.
//
//   node scripts/test-changelog-promote.mjs

import { promoteChangelog } from "./lib/changelog-promote.mjs";

let fails = 0;
const check = (cond, label) => (cond ? console.log(`ok:   ${label}`) : (console.error(`FAIL: ${label}`), fails++));

const SUB = "_npm `1.1.0`._";
const withEntries = "# Changelog\n\n## [Unreleased]\n\n- a fix\n\n## [1.0.13] — 2026-10-03\n";
const prepared = "# Changelog\n\n## [Unreleased]\n\n## [1.1.0] — 2026-10-10\n\n_npm `1.1.0`._\n\n## [1.0.13] — 2026-10-03\n";

let r = promoteChangelog(withEntries, "1.1.0", "2026-10-22", SUB);
check(r.action === "promoted", "entries under [Unreleased] are promoted");
check(r.text.includes("## [Unreleased]\n\n## [1.1.0] — 2026-10-22\n\n_npm `1.1.0`._\n\n- a fix"), "the promoted section is dated today and keeps its entries");

r = promoteChangelog(prepared, "1.1.0", "2026-10-22", SUB);
check(r.action === "redated", "a prepared section for this version is redated");
check(r.text.includes("## [1.1.0] — 2026-10-22") && !r.text.includes("2026-10-10"), "the prepared section carries today's date");
check(r.text.includes("## [1.0.13] — 2026-10-03"), "older sections keep their dates");

r = promoteChangelog(prepared, "1.1.0", "2026-10-10", SUB);
check(r.action === "unchanged" && r.text === prepared, "a section already dated today is left alone");

r = promoteChangelog(prepared, "1.1.1", "2026-10-22", SUB);
check(r.action === "nothing" && r.text === prepared, "an empty [Unreleased] above another version promotes nothing");

if (fails > 0) {
  console.error(`\n${fails} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
