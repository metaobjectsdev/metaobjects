#!/usr/bin/env node
// Tests for scripts/lib/release-branch.mjs — which branch a release may be cut from.
//
//   node scripts/test-release-branch.mjs

import { releaseBranchRefusal } from "./lib/release-branch.mjs";

let fails = 0;
const check = (cond, label) => (cond ? console.log(`ok:   ${label}`) : (console.error(`FAIL: ${label}`), fails++));
const refused = (branch, version) => releaseBranchRefusal(branch, version) !== null;

// main is unchanged: any version, any line.
check(!refused("main", "1.2.2"), "main cuts a patch");
check(!refused("main", "1.3.0"), "main cuts a minor");
check(!refused("main", "2.0.0-rc.1"), "main cuts a release candidate");

// A maintenance branch cuts its own line only.
check(!refused("release/1.2", "1.2.2"), "release/1.2 cuts 1.2.2");
check(!refused("release/1.2", "1.2.10"), "release/1.2 cuts 1.2.10");
check(!refused("release/1.2", "1.2.3-rc.1"), "release/1.2 cuts a 1.2.x release candidate");
check(refused("release/1.2", "1.3.0"), "release/1.2 refuses 1.3.0 (mismatched minor)");
check(refused("release/1.2", "1.1.9"), "release/1.2 refuses 1.1.9 (an older minor)");
check(refused("release/1.2", "2.2.0"), "release/1.2 refuses 2.2.0 (mismatched major)");
check(refused("release/1.2", "1.20.0"), "release/1.2 refuses 1.20.0 (a prefix is not a match)");
check(refused("release/1.20", "1.2.0"), "release/1.20 refuses 1.2.0");
check(releaseBranchRefusal("release/1.2", "1.3.0")?.includes("cuts only 1.2.x") === true,
  "the mismatch refusal names the line the branch cuts");

// Anything else is refused, as before.
check(refused("release-prep", "1.2.2"), "an ordinary branch is refused");
check(refused("release/1", "1.2.2"), "release/<major> alone is not a maintenance branch");
check(refused("release/1.2.x", "1.2.2"), "release/1.2.x is not a maintenance branch");
check(refused("fix/release/1.2", "1.2.2"), "a nested name is not a maintenance branch");
check(refused("HEAD", "1.2.2"), "a detached HEAD is refused");
check(releaseBranchRefusal("release-prep", "1.2.2")?.includes("not on main") === true,
  "the refusal for an ordinary branch still says it is not on main");

if (fails > 0) {
  console.error(`\n${fails} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
