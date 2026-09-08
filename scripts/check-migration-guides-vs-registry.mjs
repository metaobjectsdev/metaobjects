#!/usr/bin/env node
// A migration guide must not tell you to delete vocabulary the shipped registry registers.
//
// WHY THIS EXISTS. `verified-by-retirement.md` (0.24.0) instructed adopters to delete every
// `@supersededBy`, and every `abandoned` / `superseded` requirement, outright. `0.24.2`
// reversed half of that — `@supersededBy` was re-registered and `@status: retired` became the
// home for those entries — but the reversal shipped as a SEPARATE guide, and the original kept
// saying "delete the node". An adopting estate followed it as written and destroyed ledger
// entries the current release would have kept. Deletion is irreversible, so a stale guide here
// is not a documentation nit: the instruction it carries is destructive.
//
// The check is DERIVED, never a hand-kept list of guides to watch. It reads
// `fixtures/registry-conformance/expected-registry.json` — the byte-gated manifest all five
// ports match, i.e. the authority on what is registered TODAY — and fails when a guide's
// retirement TABLE claims a name fails to load while that manifest registers it.
//
// SCOPE, stated rather than implied:
//   * Only markdown TABLE ROWS whose first cell is a `@attr` / `type.subType` token and whose
//     row names ERR_UNKNOWN_ATTR / ERR_UNKNOWN_SUBTYPE. That is the shape every retirement
//     claim in this directory actually takes, and prose is too noisy to read this way — the
//     first draft of this gate flagged "`@status` shrinks" on a line whose ERR_UNKNOWN_ATTR
//     belonged to a different attribute two clauses earlier.
//   * The manifest is flat on the attribute axis: it records that `@unique` is registered
//     SOMEWHERE, not that it is registered on `identity.secondary`. So a claim scoped to one
//     type ("a legacy `@unique` on `identity.secondary` fails") is out of this gate's reach.
//     It catches the whole-name case, which is the one that came back.
//   * A row that already carries its own correction is exempt — that note IS the fix.
//
//   node scripts/check-migration-guides-vs-registry.mjs
import { readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";

/** A row that already carries its own correction is not stale — that note IS the fix. */
const CORRECTED = /re-?registered|restored in|superseded in part|still true at|no longer fails/i;
const CLAIMS = /ERR_UNKNOWN_ATTR|ERR_UNKNOWN_SUBTYPE/;
const FIRST_CELL_TOKEN = /^\s*\|\s*`(@[A-Za-z][A-Za-z0-9]*|[a-z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*)`/;

/**
 * @typedef {{ name: string }} ManifestAttr
 * @typedef {{ attrs?: ManifestAttr[] }} ManifestChild
 * @typedef {{ type: string, subType: string, attrs?: ManifestAttr[], children?: ManifestChild[] }} ManifestType
 * @typedef {{ commonAttrs?: ManifestAttr[], types?: ManifestType[] }} Manifest
 * @typedef {{ attrs: Set<string>, subTypes: Set<string> }} Registered
 * @typedef {{ file: string, line: number, token: string, text: string }} Finding
 */

/**
 * Every attribute name (`@`-prefixed) and `type.subType` the manifest registers.
 * @param {Manifest} manifest
 * @returns {Registered}
 */
export function registeredNames(manifest) {
  /** @type {Set<string>} */
  const attrs = new Set();
  for (const a of manifest.commonAttrs ?? []) attrs.add(`@${a.name}`);
  for (const t of manifest.types ?? []) {
    for (const a of t.attrs ?? []) attrs.add(`@${a.name}`);
    for (const c of t.children ?? []) for (const a of c.attrs ?? []) attrs.add(`@${a.name}`);
  }
  const subTypes = new Set((manifest.types ?? []).map((t) => `${t.type}.${t.subType}`));
  return { attrs, subTypes };
}

/**
 * @param {{file: string, text: string}[]} guides
 * @param {Registered} registered
 * @returns {Finding[]}
 */
export function scanGuides(guides, registered) {
  /** @type {Finding[]} */
  const failures = [];
  for (const { file, text } of guides) {
    text.split("\n").forEach((line, i) => {
      if (!CLAIMS.test(line) || CORRECTED.test(line)) return;
      const m = FIRST_CELL_TOKEN.exec(line);
      const token = m?.[1];
      if (token === undefined) return;
      const isRegistered =
        (token.startsWith("@") && registered.attrs.has(token)) || registered.subTypes.has(token);
      if (isRegistered) failures.push({ file, line: i + 1, token, text: line.trim() });
    });
  }
  return failures;
}

function main() {
  const root = new URL("..", import.meta.url).pathname;
  const guideDir = join(root, "docs/features/migrations");
  const manifest = JSON.parse(
    readFileSync(join(root, "fixtures/registry-conformance/expected-registry.json"), "utf8"),
  );
  const registered = registeredNames(manifest);
  const guides = readdirSync(guideDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => ({ file: basename(f), text: readFileSync(join(guideDir, f), "utf8") }));

  const failures = scanGuides(guides, registered);
  if (failures.length > 0) {
    console.error(
      `\n✗ ${failures.length} migration-guide row(s) claim a name fails to load, but the shipped\n` +
        `  registry (fixtures/registry-conformance/expected-registry.json) registers it.\n` +
        `  Either the guide is stale — note on that row that the name came back, and check whether\n` +
        `  the guide also tells adopters to DELETE something — or the registry entry is wrong.\n`,
    );
    for (const f of failures) console.error(`  ${f.file}:${f.line}  ${f.token}\n    ${f.text}`);
    process.exit(1);
  }
  console.log(
    `✓ migration guides vs registry: no retirement row claims a registered name fails to load ` +
      `(${registered.attrs.size} attrs, ${registered.subTypes.size} subtypes checked)`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
