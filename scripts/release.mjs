#!/usr/bin/env bun
// One-command lockstep release of the @metaobjectsdev/* npm packages.
//
//   bun run release <version>            # do it (stops for confirm before publish)
//   bun run release <version> --dry-run  # everything except publish/tag/push
//   bun run release <version> --yes      # skip the interactive confirm (CI)
//
// Collapses the manual 11-phase ceremony into one command: preflight → bump →
// build → relock → pack-verify → [CONFIRM] → commit → publish (tier order) → tag →
// push → smoke-verify. It is the DIRECT-to-`latest` path (no RC) — correct for the
// common patch/minor where dependencies + package structure don't change; the
// pack-verify + post-publish external smoke are the safety net the RC used to
// provide. Use the RC dance manually only when deps/package layout change.
//
// npm versions are immutable, so the publish step is irreversible + human-gated.
// Idempotent-ish: re-publishing an existing version fails by design; preflight
// refuses an already-taken version/tag.

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline/promises";

const VERSION = process.argv[2];
const DRY = process.argv.includes("--dry-run");
const YES = process.argv.includes("--yes");

const sh = (cmd, o = {}) => execSync(cmd, { encoding: "utf8", stdio: o.quiet ? "pipe" : "inherit", ...o });
const out = (cmd) => execSync(cmd, { encoding: "utf8" }).trim();
const ok = (m) => console.log(`\x1b[32m✓\x1b[0m ${m}`);
const die = (m) => { console.error(`\x1b[31m✗ ${m}\x1b[0m`); process.exit(1); };

// Publish order: a dependency never lands after its dependent (docs/RELEASING.md).
// Enumerated dynamically below; this only orders the ones that are actually in the set.
const TIER_ORDER = [
  "metadata", "render",
  "codegen-ts", "runtime-ts", "migrate-ts", "sdk", "runtime-web",
  "codegen-ts-react", "codegen-ts-tanstack", "react",
  "tanstack",
  "cli", "ai-runtime",
];

if (!VERSION || !/^\d+\.\d+\.\d+(-rc\.\d+)?$/.test(VERSION)) {
  die("usage: bun run release <version> [--dry-run] [--yes]   (e.g. 0.12.6)");
}

// --- enumerate the workspace packages -------------------------------------
const pkgDirs = out(
  "ls -d server/typescript/packages/*/ client/web/packages/*/",
).split("\n").map((d) => d.replace(/\/$/, ""));
const pkgs = pkgDirs.map((dir) => {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  return { dir, pkg, short: pkg.name?.replace("@metaobjectsdev/", "") };
});

// --- PHASE 0: preflight (all must pass) -----------------------------------
console.log(`\n── Releasing ${VERSION}${DRY ? "  (DRY RUN)" : ""} ──\n`);

const branch = out("git rev-parse --abbrev-ref HEAD");
if (branch !== "main") die(`must be on main (you are on ${branch})`);
sh("git fetch origin", { quiet: true });
if (out("git rev-list --count HEAD..origin/main") !== "0") die("main is behind origin/main — pull first");

// Clean tree, except the CHANGELOG (we promote its [Unreleased] section) and untracked noise.
const dirty = out("git status --porcelain").split("\n")
  .filter((l) => l && !l.startsWith("??") && !l.endsWith("CHANGELOG.md"));
if (dirty.length) die(`uncommitted changes:\n${dirty.join("\n")}\n(commit or stash first; CHANGELOG is allowed)`);

// Target version free on npm + no existing tag.
try { sh(`npm view @metaobjectsdev/cli@${VERSION} version`, { quiet: true }); die(`${VERSION} is already published`); }
catch { /* 404 = free, good */ }
if (out(`git tag -l v${VERSION}`)) die(`tag v${VERSION} already exists`);

// The lockstep set = every non-private package at the CURRENT version (cli's version).
const current = pkgs.find((p) => p.short === "cli").pkg.version;
const set = pkgs.filter((p) => !p.pkg.private && p.pkg.version === current);
ok(`preflight: on main, synced, ${VERSION} free`);
ok(`lockstep set @ ${current}: ${set.length} packages → ${VERSION}`);

// --- PHASE 1: bump --------------------------------------------------------
for (const p of set) {
  p.pkg.version = VERSION;
  writeFileSync(join(p.dir, "package.json"), JSON.stringify(p.pkg, null, 2) + "\n");
}
ok(`bumped ${set.length} package.json → ${VERSION}`);

// --- PHASE 2+3: clean build + relock --------------------------------------
sh("bun run clean", { quiet: true });
sh("bun run build", { quiet: true });
ok("clean rebuild");
sh("rm -f bun.lock && bun install", { quiet: true });
ok("lockfile regenerated");

// --- pack-verify: the cli tarball pins siblings to VERSION, no workspace:* --
const p = mkdtempSync(join(tmpdir(), "rel-pack-"));
sh(`cd server/typescript/packages/cli && bun pm pack --destination ${p}`, { quiet: true });
const packed = out(`tar -xzOf ${p}/*.tgz package/package.json`);
const pj = JSON.parse(packed);
if (pj.version !== VERSION) die(`packed cli version is ${pj.version}, expected ${VERSION}`);
const bad = Object.entries(pj.dependencies || {}).filter(([k, v]) => k.startsWith("@metaobjectsdev/") && v !== VERSION);
if (bad.length) die(`packed cli pins stale/workspace sibling deps: ${JSON.stringify(bad)}`);
ok(`packed deps verified: all @metaobjectsdev/* pinned to ${VERSION}`);

// --- promote CHANGELOG [Unreleased] → [VERSION] ---------------------------
const today = out("date +%F");
let cl = readFileSync("CHANGELOG.md", "utf8");
if (/## \[Unreleased\]\s*\n\s*\n## /.test(cl)) {
  console.warn(`\x1b[33m! CHANGELOG [Unreleased] is empty — add an entry before releasing\x1b[0m`);
} else {
  cl = cl.replace(
    /## \[Unreleased\]\n/,
    `## [Unreleased]\n\n## [${VERSION}] — ${today}\n\n_npm \`${VERSION}\` (full lockstep across all ${set.length} \`@metaobjectsdev/*\` publish candidates)._\n`,
  );
  writeFileSync("CHANGELOG.md", cl);
  ok(`CHANGELOG promoted → [${VERSION}]`);
}

// --- PHASE 6: STOP — confirm before the irreversible publish --------------
console.log(`\n\x1b[1mReady to publish ${VERSION} to npm \`latest\` (IRREVERSIBLE).\x1b[0m`);
console.log(`  packages: ${set.length}  |  packed deps: pinned  |  build: clean`);
if (DRY) { ok("dry run — stopping before commit/publish/tag (no changes published)"); process.exit(0); }
if (!YES) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = (await rl.question(`Promote ${VERSION} to latest? (y/N) `)).trim().toLowerCase();
  rl.close();
  if (ans !== "y" && ans !== "yes") die("aborted — nothing published");
}

// --- commit the release ---------------------------------------------------
sh("git add server/typescript/packages/*/package.json client/web/packages/*/package.json bun.lock CHANGELOG.md");
sh(`git commit -q -m "chore(release): @metaobjectsdev TypeScript packages ${VERSION}"`);
ok("committed");

// --- PHASE 7: publish to latest, tier order -------------------------------
const ordered = [...set].sort((a, b) => TIER_ORDER.indexOf(a.short) - TIER_ORDER.indexOf(b.short));
for (const pkg of ordered) {
  sh(`cd ${pkg.dir} && bun publish`, { quiet: true });
  ok(`published ${pkg.short}@${VERSION}`);
}

// --- PHASE 8: push + tag --------------------------------------------------
sh("git push origin main", { quiet: true });
sh(`git tag v${VERSION} && git push origin v${VERSION}`, { quiet: true });
ok(`pushed main + tag v${VERSION}`);

// --- PHASE 11: post-publish smoke (the RC's safety net) -------------------
const sm = mkdtempSync(join(tmpdir(), "rel-smoke-"));
sh(`cd ${sm} && npm init -y`, { quiet: true });
sh(`cd ${sm} && npm i @metaobjectsdev/cli --prefer-online`, { quiet: true });
const v = out(`cd ${sm} && ./node_modules/.bin/meta --version`);
if (!v.includes(VERSION)) die(`smoke FAILED: clean install reports ${v}, expected ${VERSION}`);
ok(`smoke: clean external install → meta --version = ${v}`);

console.log(`\n\x1b[32m\x1b[1m✅ ${VERSION} is live on npm latest.\x1b[0m`);
console.log(`   Docs/site version refs are NOT auto-bumped (low-value churn for a patch); batch them when convenient.\n`);
