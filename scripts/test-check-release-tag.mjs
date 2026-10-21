#!/usr/bin/env node
// Tests for scripts/check-release-tag.mjs.
//
//   node scripts/test-check-release-tag.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PORTS, checkReleaseTag } from "./check-release-tag.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const check = (cond, label) => (cond ? console.log(`ok:   ${label}`) : (console.error(`FAIL: ${label}`), fails++));

const run = (over) => checkReleaseTag({ port: "python", manifestVersion: "1.1.0", refType: "tag", refName: "python-v1.1.0", override: "", ...over });

check(run({}).ok, "a tag naming the manifest version passes");
check(!run({ refName: "python-v1.1.1" }).ok, "a tag naming another version is refused");
check(run({ refName: "python-v1.1.1" }).message.includes("1.1.0"), "the refusal names the manifest version");
check(!run({ refName: "npm-v1.1.0" }).ok, "another port's tag is refused");
check(!run({ override: "1.1.0-rc.7" }).ok, "a version override on a tag run is refused");
check(run({ refType: "branch", refName: "main" }).ok, "a manual run has no tag to compare and passes");
check(run({ refType: "branch", override: "1.1.0-rc.7" }).message.includes("1.1.0-rc.7"), "a manual run reports the override it publishes");
check(!run({ manifestVersion: undefined }).ok, "a manifest with no version is refused");
check(!checkReleaseTag({ port: "ruby", manifestVersion: "1", refType: "tag", refName: "ruby-v1" }).ok, "an unknown port is refused");
check(checkReleaseTag({ port: "java", manifestVersion: "8.1.0", refType: "tag", refName: "java-v8.1.0" }).ok, "the Maven tag carries the Maven version");

// Every port's reader finds a version in the real manifest, so a manifest layout change
// fails here rather than at a release.
for (const [port, spec] of Object.entries(PORTS)) {
  const v = spec.read(readFileSync(join(REPO, spec.file), "utf8"));
  check(typeof v === "string" && /^\d+\.\d+\.\d+/.test(v), `${port}: reads a version from ${spec.file} (${v})`);
}
// The Java reader reads the reactor's own version: the poms' versions are checked equal by
// check-pom-versions.sh, and this must agree with the Maven derivation of the npm version.
const { mavenVersion } = await import("./maven-coordinate.mjs");
const npm = PORTS.npm.read(readFileSync(join(REPO, PORTS.npm.file), "utf8"));
const java = PORTS.java.read(readFileSync(join(REPO, PORTS.java.file), "utf8"));
check(java === mavenVersion(npm) || java.endsWith("-SNAPSHOT"), `java reads the reactor version (${java}) for npm ${npm}`);

if (fails > 0) {
  console.error(`\n${fails} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
