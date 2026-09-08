#!/usr/bin/env node
// The ONE place the Maven coordinate is derived from the npm version.
//
// ADR-0035's decoupled cut fixes the JVM major at **npm major + 7**: every `0.x` line has
// shipped as `7.x`, and when npm/PyPI/NuGet cut `1.0.0` Maven Central cuts `8.0.0`. That is a
// forward major, not a continuation, and a hardcoded `7` is wrong the moment the npm line
// leaves `0.x`.
//
// WHY THIS FILE EXISTS. Four scripts derived this independently and two of them were wrong:
//   * `finish-release.mjs`  — correct (`npmMajor >= 1 ? 7 + npmMajor : 7`)
//   * `release-verify.mjs`  — correct (`npmMajor + 7`), fixed only after it asked Maven
//                             Central for `7.0.0` — a version BELOW the last release — and
//                             would have declared all nine live modules missing
//   * `prerelease.mjs`      — hardcoded `7`, so a `1.0.0` base derived `7.0.0-rc.N`
//   * `release.mjs`         — printed `java-v7.<minor>.<patch>` as the tag to create, which
//                             is an instruction to a human and therefore the hardest of the
//                             four to catch: nothing executes it
// Two of those are the SAME defect wearing a different hat, which is what a rule with four
// doors always eventually produces. Import from here; do not re-derive.
//
//   import { mavenVersion, mavenMajor } from "./maven-coordinate.mjs";

/** The historical offset: the JVM line has always run `npm major + 7`. */
export const MAVEN_MAJOR_OFFSET = 7;

/**
 * @param {string} npmVersion e.g. "0.25.0", "1.0.0", "1.0.0-rc.5"
 * @returns {number} the Maven major
 */
export function mavenMajor(npmVersion) {
  const major = Number(String(npmVersion).split(".")[0]);
  if (!Number.isInteger(major) || major < 0) {
    throw new Error(`maven-coordinate: cannot read an npm major from "${npmVersion}"`);
  }
  // `0.x` maps to 7, which the offset already gives; stated as one rule rather than a
  // special case, so there is nothing to keep in sync when the npm line moves past 1.
  return major + MAVEN_MAJOR_OFFSET;
}

/**
 * The full Maven coordinate for an npm version, pre-release suffix preserved verbatim.
 * `0.25.0` → `7.25.0`; `1.0.0` → `8.0.0`; `1.0.0-rc.5` → `8.0.0-rc.5`.
 * @param {string} npmVersion
 * @returns {string}
 */
export function mavenVersion(npmVersion) {
  const s = String(npmVersion);
  const m = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(s);
  if (!m) throw new Error(`maven-coordinate: "${s}" is not a three-part version`);
  // Through `mavenMajor`, not `Number(m[1]) + MAVEN_MAJOR_OFFSET` again. This file exists
  // because the offset had four doors and two were wrong; inlining it here made a fifth,
  // and left `mavenMajor` with no production caller at all — an exported rule whose only
  // exercise was its own unit test, beside a copy of itself that every release actually ran.
  return `${mavenMajor(s)}.${m[2]}.${m[3]}${m[4] ?? ""}`;
}
