#!/usr/bin/env node
// Tests for scripts/maven-coordinate.mjs.
//
// The 1.0 cases are the point: every one of them is a version this repo has never released,
// which is exactly why two of the four original derivations were wrong and nothing noticed.
//
//   node scripts/test-maven-coordinate.mjs

import { mavenMajor, mavenVersion } from "./maven-coordinate.mjs";

let fails = 0;
const eq = (got, want, label) =>
  got === want ? console.log(`ok:   ${label}`) : (console.error(`FAIL: ${label} — got ${got}, want ${want}`), fails++);
const throws = (fn, label) => {
  try {
    fn();
    console.error(`FAIL: ${label} — did not throw`);
    fails++;
  } catch {
    console.log(`ok:   ${label}`);
  }
};

// Every historical 0.x mapping, unchanged — this is the regression half.
eq(mavenVersion("0.25.0"), "7.25.0", "0.25.0 → 7.25.0");
eq(mavenVersion("0.24.5"), "7.24.5", "0.24.5 → 7.24.5");
eq(mavenVersion("0.15.1"), "7.15.1", "0.15.1 → 7.15.1");
eq(mavenMajor("0.25.0"), 7, "0.x major is 7");

// The 1.0 line — where the hardcoded 7 produced a version BELOW the last release.
eq(mavenVersion("1.0.0"), "8.0.0", "1.0.0 → 8.0.0");
eq(mavenMajor("1.0.0"), 8, "1.x major is 8");
eq(mavenVersion("1.0.0-rc.5"), "8.0.0-rc.5", "an RC keeps its suffix verbatim");
eq(mavenVersion("1.2.3-rc.11"), "8.2.3-rc.11", "a two-digit iteration survives");
eq(mavenVersion("2.0.0"), "9.0.0", "the offset is a rule, not a 1.0 special case");

// Malformed input fails loudly rather than deriving a plausible-looking wrong coordinate.
throws(() => mavenVersion("1.0"), "a two-part version throws");
throws(() => mavenVersion("v1.0.0"), "a v-prefixed tag throws");
throws(() => mavenVersion(""), "an empty string throws");
throws(() => mavenMajor("nope"), "a non-numeric major throws");

console.log(fails === 0 ? "\nAll maven-coordinate tests passed." : `\n${fails} test(s) FAILED.`);
process.exit(fails === 0 ? 0 : 1);
