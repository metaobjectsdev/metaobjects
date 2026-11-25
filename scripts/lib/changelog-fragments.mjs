// Changelog fragments: one file per change under `changelog.d/`, folded into CHANGELOG.md at
// release time.
//
// Why: every PR used to add its entry at the top of `## [Unreleased]`, so any two PRs in
// flight edited the same lines and the second to land went conflicting — on 2026-11-22 one
// lane PR conflicted three times in an afternoon, once mid-gate. A PR that adds its own new
// file cannot conflict with another PR that adds a different one.
//
// A fragment is `changelog.d/<name>.md` holding exactly the text the entry would have had
// under `## [Unreleased]`: one top-level `- ` bullet, continuation lines indented. Assembly
// puts the fragments, in file-name order, at the top of `## [Unreleased]` and deletes them,
// so CHANGELOG.md is still the one changelog a release ships. `changelog.d/README.md` is the
// format's documentation and is never assembled.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const FRAGMENT_DIR = "changelog.d";
const README = "README.md";
const NAME = /^[a-z0-9][a-z0-9._-]*\.md$/;
const UNRELEASED = "## [Unreleased]\n";

/**
 * The fragment file names in `dir`, sorted, README excluded. A missing dir has none.
 * @param {string} dir
 * @returns {string[]}
 */
export function fragmentNames(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return [];
    throw e;
  }
  return entries.filter((e) => e.isFile() && e.name !== README).map((e) => e.name).sort();
}

/**
 * Every fragment in `dir` as `{ name, text }`, sorted by name.
 * @param {string} dir
 * @returns {{ name: string, text: string }[]}
 */
export function readFragments(dir) {
  return fragmentNames(dir).map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
}

/**
 * What is wrong with one fragment, as messages naming it. Empty when it is well-formed.
 * @param {string} name the file name
 * @param {string} text its contents
 * @returns {string[]}
 */
export function fragmentProblems(name, text) {
  const problems = [];
  if (!NAME.test(name)) {
    problems.push(`${name}: name must be lower-case letters, digits, '.', '_' or '-', ending in .md`);
  }
  const body = text.replace(/\s+$/, "");
  if (body === "") return [...problems, `${name}: is empty`];
  if (!body.startsWith("- ")) problems.push(`${name}: must start with a '- ' bullet, as an [Unreleased] entry does`);
  const lines = body.split("\n");
  if (lines.some((l) => /^#/.test(l))) {
    problems.push(`${name}: must not contain a '#' heading line — it would split the CHANGELOG section it lands in`);
  }
  if (lines.slice(1).some((l) => l.startsWith("- "))) {
    problems.push(`${name}: holds more than one top-level bullet — one change per fragment`);
  }
  return problems;
}

/**
 * CHANGELOG.md with the fragments at the top of `## [Unreleased]`, in the order given.
 * @param {string} changelog the CHANGELOG.md text
 * @param {{ name: string, text: string }[]} fragments
 * @returns {string}
 */
export function assembleChangelog(changelog, fragments) {
  if (fragments.length === 0) return changelog;
  const at = changelog.indexOf(UNRELEASED);
  if (at === -1) throw new Error("CHANGELOG.md has no '## [Unreleased]' heading to assemble fragments under");
  const head = changelog.slice(0, at + UNRELEASED.length);
  const rest = changelog.slice(at + UNRELEASED.length).replace(/^\n+/, "");
  const entries = fragments.map((f) => f.text.replace(/\s+$/, "")).join("\n\n");
  return `${head}\n${entries}\n\n${rest}`;
}
