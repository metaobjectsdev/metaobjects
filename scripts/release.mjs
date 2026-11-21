#!/usr/bin/env bun
// One-command lockstep release of the @metaobjectsdev/* npm packages, and of the Rust crates
// when they have changed (ADR-0065 Amendment 3).
//
//   bun run release <version>            # do it (stops for confirm before publish)
//   bun run release <version> --dry-run  # everything except publish/tag/push
//   bun run release <version> --yes      # skip the interactive confirm (CI)
//   bun run release <version> --preflight-only   # run PHASE 0 and stop
//   bun run release <version> --crates=publish|skip   # override whether the crates ship
//
// The Rust crates publish to crates.io behind the same confirm, after npm, in dependency
// order, when a file they ship changed since the last `rust-v*` tag (or they never shipped,
// or expected-registry.json moved). scripts/lib/rust-release.mjs holds those rules.
//
// --preflight-only is NOT --dry-run. --dry-run still runs Phase 1, which writes the
// new version into every package.json of the lockstep set, rebuilds, and regenerates bun.lock —
// nothing reverts that, and this repo carries a scar from a corrupting version bump.
// --preflight-only returns before any of it, so it is the safe way to exercise a
// preflight change.
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
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { promoteChangelog } from "./lib/changelog-promote.mjs";
import { createInterface } from "node:readline/promises";
import { publishSet } from "./publish-set.mjs";
import { mavenVersion } from "./maven-coordinate.mjs";
import {
  RUST_DIR, RUST_TAG_PREFIX, bumpRustManifest, crateVersionTaken, newestRustTag, rustPublishDecision,
  rustPublishOrder,
} from "./lib/rust-release.mjs";
import { ejectReleaseRefusalAt } from "./eject-release-gate.mjs";
import {
  releaseBranchRefusal, newestNpmReleaseTag, latestRegressionRefusal, unmergedMaintenanceRefusal,
} from "./lib/release-branch.mjs";

const VERSION = process.argv[2];
const DRY = process.argv.includes("--dry-run");
const PREFLIGHT_ONLY = process.argv.includes("--preflight-only");
const YES = process.argv.includes("--yes");
const CRATES_MODE = process.argv.find((a) => a.startsWith("--crates="))?.slice("--crates=".length) ?? "auto";

// A scratch root for the post-publish smoke that no stray node_modules can shadow.
// See PHASE 11. Kept beside the other helpers so the reason travels with the call.
const smokeRoot = () => {
  const root = join(homedir(), ".cache", "metaobjects-release-smoke");
  mkdirSync(root, { recursive: true });
  for (let d = root; d !== dirname(d); d = dirname(d)) {
    if (existsSync(join(d, "node_modules")))
      die(`${join(d, "node_modules")} would shadow the smoke test — remove it and re-run`);
  }
  return root;
};

const sh = (cmd, o = {}) => execSync(cmd, { encoding: "utf8", stdio: o.quiet ? "pipe" : "inherit", ...o });
const out = (cmd) => execSync(cmd, { encoding: "utf8" }).trim();
const ok = (m) => console.log(`\x1b[32m✓\x1b[0m ${m}`);
const die = (m) => { console.error(`\x1b[31m✗ ${m}\x1b[0m`); process.exit(1); };

if (!VERSION || !/^\d+\.\d+\.\d+(-rc\.\d+)?$/.test(VERSION)) {
  die("usage: bun run release <version> [--dry-run] [--yes] [--preflight-only]   (e.g. 0.12.6)");
}

// --- PHASE 0: preflight (all must pass) -----------------------------------
console.log(`\n── Releasing ${VERSION}${DRY ? "  (DRY RUN)" : ""} ──\n`);

// A final version does not go out while a stock generator's owned copy still calls emit
// code left in the package (ADR-0034 Amendment 8). First, because it is offline and
// instant, and everything after it costs time or cannot be undone. A release candidate
// passes: it is how the remaining gaps are tried against an adopter.
const ejectRefusal = ejectReleaseRefusalAt(VERSION, join(dirname(fileURLToPath(import.meta.url)), ".."));
if (ejectRefusal !== null) die(ejectRefusal);

// `main`, or a `release/<major>.<minor>` maintenance branch cutting a version on its own
// line (scripts/lib/release-branch.mjs). Everything below that pushes or compares against
// the remote uses THIS branch, so a maintenance cut never touches main.
const branch = out("git rev-parse --abbrev-ref HEAD");
const branchRefusal = releaseBranchRefusal(branch, VERSION);
if (branchRefusal !== null) die(branchRefusal);
sh("git fetch origin", { quiet: true });
if (out(`git rev-parse --verify --quiet origin/${branch} || true`) === "") {
  die(`${branch} has no origin/${branch} — push the branch first`);
}
if (out(`git rev-list --count HEAD..origin/${branch}`) !== "0") die(`${branch} is behind origin/${branch} — pull first`);

// A minor or major cut must already hold every commit of the previous release/<M>.<m>
// maintenance branch: a fix shipped as a patch from it and never brought to main would
// otherwise be missing from the new line (docs/RELEASING.md, Step 0).
const maintenanceBranches = out("git branch -r --format='%(refname:short)'")
  .split("\n").map((b) => b.trim().replace(/^origin\//, "")).filter(Boolean);
const unmergedRefusal = unmergedMaintenanceRefusal(VERSION, maintenanceBranches,
  (b) => Number(out(`git rev-list --count HEAD..origin/${b}`)));
if (unmergedRefusal !== null) die(unmergedRefusal);

// Clean tree, except the CHANGELOG (we promote its [Unreleased] section) and untracked noise.
const dirty = out("git status --porcelain").split("\n")
  .filter((l) => l && !l.startsWith("??") && !l.endsWith("CHANGELOG.md"));
if (dirty.length) die(`uncommitted changes:\n${dirty.join("\n")}\n(commit or stash first; CHANGELOG is allowed)`);

if (out(`git tag -l v${VERSION}`)) die(`tag v${VERSION} already exists`);

// `bun publish` tags `latest`, so a version older than the newest release would move
// `latest` backwards — finish-release gate 6 catches that only after the publish; this
// refuses it before anything irreversible. Same npm-line tag resolution the site deploy
// uses (scripts/lib/release-branch.mjs).
const latestRefusal = latestRegressionRefusal(VERSION, newestNpmReleaseTag(out));
if (latestRefusal !== null) die(latestRefusal);

// Can we publish AT ALL? Checked here, before the version bump, because the bump is
// committed and pushed long before the first `bun publish` — so discovering a dead
// credential at the publish step strands the release mid-flight. The 0.24.0 cut found
// BOTH npm paths dead at once (the local token had been revoked per this doc's own
// advice, and the NPM_TOKEN secret was empty), after PyPI and NuGet had already shipped
// irreversibly. Note npm answers 404, not 401, for an unauthorized scoped package, so
// the raw failure reads like "the package does not exist".
try {
  const who = out("npm whoami").trim();
  ok(`npm auth: ${who}`);
} catch {
  die("npm is not authenticated (`npm whoami` failed) — publishing would fail after the\n" +
      "  version bump is already committed. Set a token that BYPASSES 2FA:\n" +
      "    npm config set //registry.npmjs.org/:_authToken=<token>\n" +
      "  It must be an Automation / bypass-2FA token. A 'Publish' token authenticates and\n" +
      "  reads fine, then returns EOTP on every write, and `bun publish` falls back to an\n" +
      "  interactive browser flow that cannot complete in CI or a non-interactive shell.");
}

// The lockstep set = every non-private package at the CURRENT version (cli's version),
// in tier order. Derived by scripts/publish-set.mjs, which .github/workflows/publish-npm.yml
// also reads — the two publish paths must never disagree about which packages ship (they
// did: the workflow's hardcoded list omitted docs-site, a runtime dependency of the cli).
// It throws rather than returns on a set that is untiered, mis-ordered, or not closed over
// its own sibling deps; everything below this line is irreversible once publishing starts.
const { lockstep: current, set } = publishSet();

// The target version must be free for EVERY package in the set, not just the cli.
// Checking one package is a late failure waiting to happen: npm versions are permanent
// (unpublish is refused outright once anything depends on the version, and deprecating it
// does not free the number), so a version burned on a single package — as
// @metaobjectsdev/metadata@0.24.0-rc.1 is — would fail mid-publish, after its dependencies
// had already shipped irreversibly. Checked in parallel: 14 sequential `npm view`s is 14s.
const taken = (await Promise.all(set.map(async (p) => {
  try {
    const r = await fetch(`https://registry.npmjs.org/${p.pkg.name.replace("/", "%2f")}`,
      { headers: { accept: "application/vnd.npm.install-v1+json" }, signal: AbortSignal.timeout(15_000) });
    if (r.status === 404) return null;             // never published = free
    // Any other non-OK status is fatal, not "free": failing open here re-creates the
    // irreversible mid-publish partial failure this preflight exists to prevent.
    if (!r.ok) die(`npm answered HTTP ${r.status} for ${p.pkg.name} — cannot verify ${VERSION} is free`);
    return (await r.json()).versions?.[VERSION] ? p.pkg.name : null;
  } catch { die(`could not reach npm to verify ${VERSION} is free (${p.pkg.name})`); }
}))).filter(Boolean);
if (taken.length)
  die(`${VERSION} is already published for:\n  ${taken.join("\n  ")}\n` +
      `npm versions are permanent — pick the next free version.`);
ok(`preflight: on ${branch}, synced, ${VERSION} free on all ${set.length} packages`);
ok(`lockstep set @ ${current}: ${set.length} packages → ${VERSION}`);

// --- the Rust crates: do they ship this cut, and can they? -----------------
// Decided here, with npm's checks, for the same reason: everything after the version bump is
// committed and pushed before the first publish, so a dead token or a taken number found at
// the publish step strands the release half-shipped.
const rustTag = newestRustTag(out("git tag -l").split("\n"));
let rust;
try {
  rust = rustPublishDecision({
    lastTag: rustTag,
    changedPaths: rustTag ? out(`git diff --name-only ${rustTag} HEAD`).split("\n").filter(Boolean) : [],
    mode: CRATES_MODE,
  });
} catch (e) { die(e.message); }
let crates = [];
if (!rust.publish) {
  ok(`crates.io: sits this release out (${rust.reason})`);
} else {
  crates = rustPublishOrder(JSON.parse(out(`cd ${RUST_DIR} && cargo metadata --format-version 1 --no-deps --locked`)));
  // cargo reads a token from CARGO_REGISTRY_TOKEN or from the file `cargo login` writes.
  const cargoHome = process.env.CARGO_HOME ?? join(homedir(), ".cargo");
  const credentials = ["credentials.toml", "credentials"].map((f) => join(cargoHome, f)).find(existsSync);
  if (!process.env.CARGO_REGISTRY_TOKEN && !(credentials && /\btoken\s*=/.test(readFileSync(credentials, "utf8")))) {
    die("crates.io has no token: publishing the crates would fail after the version bump is\n" +
        "  already committed. Run `cargo login` with a crates.io API token that has the\n" +
        "  publish-update scope (and publish-new for a crate's first release), or set\n" +
        "  CARGO_REGISTRY_TOKEN. Pass --crates=skip to cut without the crates.");
  }
  // crates.io asks automated clients to name themselves in the User-Agent.
  const agent = { "user-agent": "metaobjects-release (https://github.com/metaobjectsdev/metaobjects)" };
  const takenCrates = (await Promise.all(crates.map(async (name) => {
    try {
      const r = await fetch(`https://crates.io/api/v1/crates/${name}`, { headers: agent, signal: AbortSignal.timeout(15_000) });
      if (r.status === 404) return null;             // never published = free
      if (!r.ok) die(`crates.io answered HTTP ${r.status} for ${name} — cannot verify ${VERSION} is free`);
      return crateVersionTaken(await r.json(), VERSION) ? name : null;
    } catch { die(`could not reach crates.io to verify ${VERSION} is free (${name})`); }
  }))).filter(Boolean);
  if (takenCrates.length) {
    die(`${VERSION} is already published on crates.io for:\n  ${takenCrates.join("\n  ")}\n` +
        "crates.io versions are permanent (a yank does not free the number) — pick the next free version.");
  }
  ok(`crates.io: ${crates.length} crates ship (${rust.reason}); ${VERSION} free on all of them`);
}

// The showcase corpus is what metaobjects.dev publishes as "real `meta gen` output",
// so a stale tree is a stale claim on a public page. Checked BEFORE the version bump,
// which is committed and pushed long before the first publish.
//
// LAST in Phase 0 on purpose: this is the only slow check here (it shells out to
// mvn/dotnet/uv), so everything cheap — and everything that fails often, like a dead
// npm token — gets to fail first.
//
// `--all-ports`, never a bare `--check`: without it a missing mvn/dotnet/uv makes
// regen-showcase SKIP that port and still exit 0, so the preflight would pass on a box
// that never checked Java at all. This is the one place that refuses to leave a port
// out; the ci-local gate deliberately runs the bun-only half.
try {
  sh("bun scripts/regen-showcase.ts --check --all-ports", { quiet: true });
  sh("bun scripts/build-site-payload.ts --check", { quiet: true });
  ok("site payload: showcase fresh on all five ports, payload fresh");
} catch (e) {
  die("the site payload is stale, or a port's toolchain is missing — the site would\n" +
      "  publish a stale claim. Run `bun scripts/regen-showcase.ts --all-ports` and\n" +
      "  `bun run site:payload`, review the diff, and commit before releasing.\n\n" +
      `${e.stdout ?? ""}${e.stderr ?? ""}`);
}

// The bidirectional payload <-> site check, against the LIVE site.
//
// The deploy-time injector deliberately checks only ONE direction (a placeholder the
// payload cannot fill), because running the bidirectional check there would fail every
// unrelated site edit -- prose included -- from the moment a placeholder lands until the
// next release. The other direction is enforced HERE instead: this is the last moment a
// mismatch is fixable before a tag exists, and a failed Pages deploy is expensive to
// recover (never re-run one; fix forward).
//
// It reaches the NETWORK, which is why it lives in scripts/ rather than scripts/site/ --
// `gate_site_payload` globs that directory and the gates lane must stay offline-safe.
try {
  sh("bun test scripts/site-bijection.test.ts", { quiet: true });
  ok("site bijection: every payload snippet is on a live page, and vice versa");
} catch (e) {
  die("the committed payload and the LIVE site disagree. A snippet the site does not\n" +
      "  reference is dead weight; a placeholder the payload cannot fill would deploy as\n" +
      "  an empty code block. Fix the site repo (or the snippet registry) and push it\n" +
      "  BEFORE tagging -- the deploy pins to the release tag.\n\n" +
      `${e.stdout ?? ""}${e.stderr ?? ""}`);
}

if (PREFLIGHT_ONLY) {
  ok("--preflight-only: Phase 0 passed; stopping before the version bump");
  process.exit(0);
}

// --- PHASE 1: bump --------------------------------------------------------
for (const p of set) {
  p.pkg.version = VERSION;
  writeFileSync(join(p.dir, "package.json"), JSON.stringify(p.pkg, null, 2) + "\n");
}
ok(`bumped ${set.length} package.json → ${VERSION}`);
const rustManifests = [];
if (rust.publish) {
  const members = JSON.parse(out(`cd ${RUST_DIR} && cargo metadata --format-version 1 --no-deps --locked`))
    .packages.map((p) => p.manifest_path);
  for (const manifest of [join(RUST_DIR, "Cargo.toml"), ...members]) {
    writeFileSync(manifest, bumpRustManifest(readFileSync(manifest, "utf8"), VERSION));
    rustManifests.push(manifest);
  }
  sh(`cd ${RUST_DIR} && cargo update --workspace --offline`, { quiet: true });
  ok(`bumped the Rust workspace → ${VERSION} (${rustManifests.length} manifests, Cargo.lock)`);
}

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

// --- pack-verify the crates: each packages and builds from its own tarball -------
// `--workspace` resolves the sibling crates from the tarballs it just made, so a crate that
// would only build against a path in this checkout fails here, not on crates.io.
// `--allow-dirty` because the version bump above is not committed yet.
if (rust.publish) {
  sh(`cd ${RUST_DIR} && cargo publish --dry-run --workspace --locked --allow-dirty`, { quiet: true });
  ok(`crates pack-verified: ${crates.join(", ")} @ ${VERSION}`);
}

// --- promote CHANGELOG [Unreleased] → [VERSION], or date a prepared [VERSION] ----
// The rule and its cases live in scripts/lib/changelog-promote.mjs (tested by
// scripts/test-changelog-promote.mjs): a section prepared ahead of the cut carries the date it
// was started, and is restamped with the release date here rather than by hand.
const today = out("date +%F");
const promoted = promoteChangelog(
  readFileSync("CHANGELOG.md", "utf8"),
  VERSION,
  today,
  `_npm \`${VERSION}\` (full lockstep across all ${set.length} \`@metaobjectsdev/*\` publish candidates)._`,
);
if (promoted.action === "nothing") {
  console.warn(`\x1b[33m! CHANGELOG has no entries and no [${VERSION}] section — add one before releasing\x1b[0m`);
} else {
  writeFileSync("CHANGELOG.md", promoted.text);
  ok(promoted.action === "promoted" ? `CHANGELOG promoted → [${VERSION}]` : `CHANGELOG [${VERSION}] dated ${today}`);
}

// --- refresh the site payload, which EMBEDS the versions Phase 1 just changed ------
// Phase 0 checked the payload against the OLD versions; Phase 1 then rewrote
// cli/package.json, which is one of the five coordinates the payload carries. Without
// this the release commit lands with a payload naming the previous version, `gates` goes
// red on main at the very next push, and once the site injection lands the page would
// publish stale coordinates. Regenerated BEFORE the confirm below so a failure happens
// before anyone is asked to publish.
//
// The PyPI/NuGet/Maven bump is a SEPARATE commit and changes three more coordinates —
// it must run `bun run site:payload` too. See docs/RELEASING.md.
sh("bun scripts/build-site-payload.ts", { quiet: true });
ok("site payload regenerated for the new version");

// --- PHASE 6: STOP — confirm before the irreversible publish --------------
console.log(`\n\x1b[1mReady to publish ${VERSION} to npm \`latest\` (IRREVERSIBLE).\x1b[0m`);
console.log(`  packages: ${set.length}  |  packed deps: pinned  |  build: clean`);
console.log(rust.publish
  ? `  and ${crates.length} crates to crates.io (IRREVERSIBLE): ${crates.join(", ")}`
  : `  crates.io: none (${rust.reason})`);
if (DRY) { ok("dry run — stopping before commit/publish/tag (no changes published)"); process.exit(0); }
if (!YES) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = (await rl.question(`Promote ${VERSION} to latest? (y/N) `)).trim().toLowerCase();
  rl.close();
  if (ans !== "y" && ans !== "yes") die("aborted — nothing published");
}

// --- commit the release ---------------------------------------------------
sh("git add server/typescript/packages/*/package.json client/web/packages/*/package.json bun.lock CHANGELOG.md examples/showcase/site-payload.json");
if (rust.publish) sh(`git add ${[...rustManifests, join(RUST_DIR, "Cargo.lock")].join(" ")}`);
sh(`git commit -q -m "chore(release): @metaobjectsdev TypeScript packages ${VERSION}"`);
ok("committed");

// --- PHASE 7: publish to latest, tier order -------------------------------
const ordered = set;   // publishSet() returns it in tier order, already validated
for (const pkg of ordered) {
  sh(`cd ${pkg.dir} && bun publish`, { quiet: true });
  ok(`published ${pkg.short}@${VERSION}`);
}

// --- PHASE 7b: the crates, in dependency order ------------------------------
// After npm, so a dead npm token (the likelier failure) stops the cut before anything on
// crates.io is permanent. cargo waits for each crate to appear in the index before it
// returns, so the next crate can resolve it.
for (const name of crates) {
  sh(`cd ${RUST_DIR} && cargo publish -p ${name} --locked`, { quiet: true });
  ok(`published ${name}@${VERSION} to crates.io`);
}

// --- PHASE 8: push (the tag is NOT cut here) -------------------------------
// This script publishes npm, which is one of FOUR registries. The PyPI/NuGet/Maven
// version bump is a separate, later commit — so at this point the branch states the new npm
// coordinate and three stale ones, and the site payload committed above says exactly
// that.
//
// `v<version>` is what the website's deploy PINS TO: it clones the tag and injects that
// payload. Cutting the tag here would publish three registry versions that were never
// released, on every release, forever — and it did, at v0.24.5, where the tag carries
// {npm 0.24.5, pypi 0.24.4, nuget 0.24.4, maven 7.24.4}. Nothing caught it because no
// page displayed a coordinate yet.
//
// So the tag moves to the END of the coordinated cut: `scripts/finish-release.mjs`,
// which refuses to tag until the payload's coordinates match what actually shipped.
sh(`git push origin ${branch}`, { quiet: true });
ok(`pushed ${branch} (tag deferred to finish-release)`);

// --- PHASE 11: post-publish smoke (the RC's safety net) -------------------
// NOT under tmpdir(). Node's resolution walks UP from the scratch dir, so a stale
// /tmp/node_modules shadows anything the throwaway project does not hoist itself. That
// is not hypothetical: /tmp/node_modules on the release box held a 0.24.0-era smoke's
// 0.21.5 install and made a real external smoke report a MISSING export that shipped
// fine. It fails both ways — the false GREEN is the dangerous one, since a genuinely
// absent export resolves against the stale copy and the gate passes.
const sm = mkdtempSync(join(smokeRoot(), "rel-smoke-"));
sh(`cd ${sm} && npm init -y`, { quiet: true });
sh(`cd ${sm} && npm i @metaobjectsdev/cli --prefer-online`, { quiet: true });
const v = out(`cd ${sm} && ./node_modules/.bin/meta --version`);
if (!v.includes(VERSION)) die(`smoke FAILED: clean install reports ${v}, expected ${VERSION}`);
ok(`smoke: clean external install → meta --version = ${v}`);

console.log(`\n\x1b[32m\x1b[1m✅ ${VERSION} is live on npm latest${rust.publish ? " and crates.io" : ""}.\x1b[0m`);
console.log(`\n\x1b[1mNOT DONE — v${VERSION} is not tagged yet, by design.\x1b[0m`);
console.log(`   1. Bump PyPI/NuGet/Maven, run \`bun run site:payload\`, commit, push.`);
console.log(`   2. Tag the ports: python-v${VERSION}, csharp-v${VERSION}, java-v${mavenVersion(VERSION)}` +
  (rust.publish ? `, ${RUST_TAG_PREFIX}${VERSION}.` : "."));
console.log(`   3. \`bun scripts/finish-release.mjs ${VERSION}\` — gates the coordinates, then cuts v${VERSION}.`);
console.log(`   The website pins to v${VERSION}, so tagging before step 1 publishes three stale versions.`);
console.log(`   Docs version refs are NOT auto-bumped (low-value churn for a patch); batch them when convenient.`);
console.log(`   The site payload IS auto-bumped and committed here — but only its npm coordinate.`);
console.log(`   The PyPI/NuGet/Maven bump commit must run \`bun run site:payload\` or gates goes red on ${branch}.\n`);
