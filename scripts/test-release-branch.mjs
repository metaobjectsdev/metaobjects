#!/usr/bin/env node
// Tests for scripts/lib/release-branch.mjs — which branch a release may be cut from.
//
//   node scripts/test-release-branch.mjs

import { releaseBranchRefusal, latestRegressionRefusal, newestNpmReleaseTag } from "./lib/release-branch.mjs";

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

// `latest` never moves backwards: `bun publish` tags `latest`, so a version older than the
// newest release must be refused. The oracle is npm's own dist-tag semantics: `latest`
// resolves to whichever version was published last, so publishing an older one regresses it.
check(latestRegressionRefusal("1.2.4", "v1.3.0") !== null,
  "a version older than the newest release is refused");
check(latestRegressionRefusal("1.2.4-rc.1", "v1.3.0") !== null,
  "an RC on a line a newer release passed is refused too");
check(latestRegressionRefusal("1.2.4-rc.1", "v1.2.4") !== null,
  "an RC of the version that already shipped is refused");
check(latestRegressionRefusal("1.2.4", "v1.2.4") === null,
  "the released version itself is not a regression");
check(latestRegressionRefusal("1.3.0-rc.1", "v1.2.4") === null,
  "an RC of a NEWER triple passes");
check(latestRegressionRefusal("1.3.1", "v1.3.0") === null,
  "a version newer than the newest release passes");
check(latestRegressionRefusal("1.2.4", "v1.2.3") === null,
  "a patch on the newest release line passes");
check(latestRegressionRefusal("1.2.4", "") === null,
  "no released tag yet passes");
check(latestRegressionRefusal("1.2.4", "v1.3.0")?.includes("`latest` backwards") === true,
  "the refusal names the `latest` constraint");

// The newest release is resolved by the property that defines the npm line (deploy.yml's
// selector): the newest `vN.N.N` whose cli/package.json is versioned as the tag. A version
// prefix would wrongly pick `v8.2.2` (no cli tree) or the JVM `v7.20.12` (cli 0.20.11).
const cliOf = new Map([["v1.3.0", "1.3.0"], ["v1.2.2", "1.2.2"], ["v7.20.12", "0.20.11"]]);
const fakeOut = (cmd) => {
  if (cmd.startsWith("git tag -l")) return "v8.2.2\nv1.3.0\nv1.2.2\nv7.20.12";
  const t = /^git show (v[\d.]+):/.exec(cmd)?.[1];
  const v = t === undefined ? undefined : cliOf.get(t);
  return v === undefined ? "" : `{"name":"@metaobjectsdev/cli","version":"${v}"}`;
};
check(newestNpmReleaseTag(fakeOut) === "v1.3.0",
  "the newest npm-line tag wins; a treeless tag and the JVM line are skipped");

if (fails > 0) {
  console.error(`\n${fails} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
