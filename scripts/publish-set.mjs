#!/usr/bin/env node
// Single source of truth for WHICH @metaobjectsdev/* npm packages a release
// publishes, and in WHAT ORDER.
//
// Why this file exists. Two paths publish the npm lockstep set: `bun run release
// <ver>` (scripts/release.mjs) locally, and .github/workflows/publish-npm.yml on a
// `npm-v*` tag. They each answered "which packages?" separately — release.mjs
// DERIVED the set (every non-private package at the CLI's version), the workflow
// HARDCODED 13 directories — so they drifted the moment a package was added.
// @metaobjectsdev/docs-site is a runtime `dependencies` entry of
// @metaobjectsdev/cli and was missing from the workflow's list, so a release cut
// through the workflow would have published a cli pinning a docs-site version that
// does not exist on the registry: `npm i @metaobjectsdev/cli` fails with ETARGET.
// Nothing in the repo could see it, because the two answers were never compared —
// and the local path publishing all 14 is what kept it latent.
//
// So both paths read the set from here. A hardcoded list cannot drift from a
// derivation it no longer has.
//
// Offline by construction: it reads manifests, never the registry. "What SHOULD we
// publish" is a fact about this tree, not about npm.
//
//   node scripts/publish-set.mjs           # ordered package directories, one per line
//   node scripts/publish-set.mjs --check   # run the invariants, print a summary
//   import { publishSet } from "./publish-set.mjs"

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The workspace globs from the root package.json, in the order the release walks them.
const WORKSPACE_ROOTS = ["server/typescript/packages", "client/web/packages"];

// Publish order: a dependency never lands after its dependent (docs/RELEASING.md).
// This orders only the packages that are actually in the set; a set member missing
// from this list is a hard error, NOT a silent `indexOf() === -1` that sorts it
// first — that is how docs-site came to publish ahead of `metadata` and `render`,
// the two packages it depends on. Adding a package to the lockstep set is therefore
// one explicit decision here, not an omission that still "works".
export const TIER_ORDER = [
  "metadata", "render",
  "codegen-ts", "runtime-ts", "migrate-ts", "sdk", "docs-site",
  "runtime-web",
  "codegen-ts-react", "codegen-ts-tanstack", "react",
  "tanstack",
  "cli", "ai-runtime",
];

/** Every workspace package: `{ dir, pkg, short }`, dir repo-relative. */
export function enumerateWorkspacePackages(root = ROOT) {
  const found = [];
  for (const ws of WORKSPACE_ROOTS) {
    const abs = join(root, ws);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs).sort()) {
      const dir = `${ws}/${name}`;
      const manifest = join(root, dir, "package.json");
      if (!existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, "utf8"));
      found.push({ dir, pkg, short: pkg.name?.replace("@metaobjectsdev/", "") });
    }
  }
  return found;
}

const siblingDeps = (pkg) =>
  Object.keys(pkg.dependencies || {}).filter((k) => k.startsWith("@metaobjectsdev/"));

/**
 * The lockstep publish set, ordered and validated.
 *
 * The set is every NON-PRIVATE package sitting at the CLI's version — the rule
 * docs/RELEASING.md states and scripts/check-publish-intent.sh enforces from the
 * other side (a non-private package OFF the lockstep line must be declared
 * source-only). Returns `{ lockstep, packages, set }`; `set` is in publish order.
 * Throws on any broken invariant — callers are about to do something irreversible.
 *
 * `root`/`tierOrder` are overridable so scripts/test-publish-set.mjs can drive each
 * invariant against a synthetic workspace; production callers pass nothing.
 */
export function publishSet({ root = ROOT, tierOrder = TIER_ORDER } = {}) {
  const packages = enumerateWorkspacePackages(root);
  const cli = packages.find((p) => p.short === "cli");
  if (!cli) throw new Error("cannot find @metaobjectsdev/cli — is this the metaobjects repo root?");
  const lockstep = cli.pkg.version;
  const set = packages.filter((p) => !p.pkg.private && p.pkg.version === lockstep);

  // 1. Every member must have a declared tier. Without this, TIER_ORDER.indexOf()
  //    returns -1 for an unlisted package and sorts it AHEAD of everything —
  //    including its own dependencies.
  const untiered = set.filter((p) => !tierOrder.includes(p.short));
  if (untiered.length) {
    throw new Error(
      `publish order undeclared for: ${untiered.map((p) => p.pkg.name).join(", ")}\n` +
      `  Add each to TIER_ORDER in scripts/publish-set.mjs, after its dependencies.\n` +
      `  (Left unlisted it does not fall to the end — it sorts FIRST, ahead of the\n` +
      `  packages it depends on.)`,
    );
  }

  const ordered = [...set].sort((a, b) => tierOrder.indexOf(a.short) - tierOrder.indexOf(b.short));
  const inSet = new Set(ordered.map((p) => p.pkg.name));

  // 2. Closure: a published package's sibling runtime deps must ALSO be published.
  //    This is the defect itself — cli pinned docs-site@<ver> while the workflow's
  //    list never published docs-site, so the tarball resolved to nothing.
  const unresolvable = ordered.flatMap((p) =>
    siblingDeps(p.pkg).filter((d) => !inSet.has(d)).map((d) => `${p.pkg.name} -> ${d}`),
  );
  if (unresolvable.length) {
    throw new Error(
      `publish set is not closed over its own runtime dependencies:\n  ${unresolvable.join("\n  ")}\n` +
      `  Each arrow is a package that would be published pinning a sibling version\n` +
      `  nobody publishes — an uninstallable tarball (npm ETARGET).\n` +
      `  Fix: bring the dependency into the lockstep set, or stop depending on it.`,
    );
  }

  // 3. Order: nothing lands before something it depends on. Guards a bad TIER_ORDER
  //    edit, which is otherwise invisible until a mid-publish registry window.
  const position = new Map(ordered.map((p, i) => [p.pkg.name, i]));
  const inverted = ordered.flatMap((p, i) =>
    siblingDeps(p.pkg).filter((d) => position.get(d) > i).map((d) => `${p.pkg.name} (#${i}) depends on ${d} (#${position.get(d)})`),
  );
  if (inverted.length) {
    throw new Error(
      `TIER_ORDER publishes a dependency AFTER its dependent:\n  ${inverted.join("\n  ")}\n` +
      `  Reorder TIER_ORDER in scripts/publish-set.mjs.`,
    );
  }

  return { lockstep, packages, set: ordered };
}

// ── CLI ───────────────────────────────────────────────────────────────────────
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let result;
  try {
    result = publishSet();
  } catch (e) {
    console.error(`\x1b[31m✖ publish-set: ${e.message}\x1b[0m`);
    process.exit(1);
  }
  const { lockstep, set } = result;
  if (process.argv.includes("--check")) {
    for (const [i, p] of set.entries()) console.log(`  ${String(i + 1).padStart(2)}. ${p.pkg.name}  (${p.dir})`);
    console.log(`publish set: OK (lockstep ${lockstep}; ${set.length} packages, tier-ordered, closed over sibling deps)`);
  } else {
    for (const p of set) console.log(p.dir);
  }
}
