#!/usr/bin/env node
/**
 * Cut `v<version>` — the LAST step of a coordinated release, not the middle one.
 *
 *   bun scripts/finish-release.mjs 0.24.6
 *   bun scripts/finish-release.mjs 0.24.6 --check   # gate only, do not tag
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * `v<version>` is not just a marker. The website's Pages deploy RESOLVES it
 * (`git tag -l 'v0.*' | grep -E '^v0\\.[0-9]+\\.[0-9]+$' | sort -V | tail -1`), clones
 * that tree, and injects `examples/showcase/site-payload.json` from it. So the tag
 * decides what metaobjects.dev states about the release — including all five version
 * coordinates.
 *
 * `scripts/release.mjs` used to cut the tag right after the npm publish. But a
 * coordinated release is TWO commits: npm's, then a hand-written one bumping PyPI,
 * NuGet and Maven. A tag cut between them names a tree whose payload says
 * `{npm: <new>, pypi: <old>, nuget: <old>, maven: <old>}` — three versions that were
 * never released. That is not hypothetical: `v0.24.5` carries exactly that. It went
 * unnoticed only because no page displayed a coordinate yet, which stops being true the
 * moment the version table takes its `data-registry` attributes.
 *
 * The fix is the ORDER, not the payload. Publish everything, THEN tag, and refuse to
 * tag a tree that does not agree with what shipped.
 *
 * ── What it refuses ──────────────────────────────────────────────────────────
 *
 * Every check here is a way the tag could name a tree that lies about the release.
 * None of them reaches the network: what a registry actually holds is verified by
 * `scripts/release-verify.mjs`, which is a different question (did it publish?) from
 * this one (does the tagged tree SAY what published?).
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHECK_ONLY = process.argv.includes("--check");
const VERSION = process.argv.slice(2).find((a) => !a.startsWith("--"));

/** @type {(m: string) => never} */
const die = (m) => { console.error(`\x1b[31m✗\x1b[0m ${m}`); process.exit(1); };
/** @type {(m: string) => void} */
const ok = (m) => console.log(`\x1b[32m✓\x1b[0m ${m}`);
/** @type {(cmd: string) => string} */
const out = (cmd) => execSync(cmd, { cwd: REPO, encoding: "utf8" }).trim();

if (VERSION === undefined || !/^\d+\.\d+\.\d+$/.test(VERSION)) {
  die("usage: bun scripts/finish-release.mjs <version> [--check]   (e.g. 0.24.6)");
}

// The Maven line runs on its historical major 7 and shares only `minor.patch`
// (ADR-0035). Deriving it here rather than taking it as a second argument means the
// two can never be passed inconsistently.
const MAVEN_VERSION = `7.${VERSION.split(".").slice(1).join(".")}`;

// ── 1. the working tree is the tree that will be tagged ──────────────────────
// A tag points at a COMMIT, so anything uncommitted is silently excluded. Tagging with
// a dirty tree is how a payload fix sits on disk while the tag names the tree without it.
if (out("git status --porcelain") !== "") {
  die("working tree is dirty — commit or stash before tagging, or the tag names a tree you did not review");
}
if (out("git rev-parse --abbrev-ref HEAD") !== "main") die("not on main");
out("git fetch origin --quiet || true");
if (out("git rev-parse HEAD") !== out("git rev-parse origin/main")) {
  die("HEAD is not origin/main — push first; the deploy clones the REMOTE tag");
}
ok("on main, clean, synced with origin");

// ── 2. the tag is free ───────────────────────────────────────────────────────
// Never move a tag. A moved tag silently changes what the website deploys, and any
// clone that already fetched it keeps the old one — two truths for one name.
const tag = `v${VERSION}`;
if (out(`git tag -l ${tag}`) !== "") die(`${tag} already exists locally — never move a release tag`);
if (out(`git ls-remote --tags origin ${tag}`) !== "") die(`${tag} already exists on origin — never move a release tag`);
ok(`${tag} is free on both local and origin`);

// ── 3. the payload states what actually shipped ──────────────────────────────
// The whole reason the tag moved to the end.
const payloadPath = join(REPO, "examples/showcase/site-payload.json");
if (!existsSync(payloadPath)) die(`missing ${payloadPath}`);
/** @type {{registries: Record<string, string>}} */
const payload = JSON.parse(readFileSync(payloadPath, "utf8"));
const r = payload.registries ?? {};

/** Registries that move on the shared `minor.patch`, and what they must read. */
const expected = { npm: VERSION, pypi: VERSION, nuget: VERSION, maven: MAVEN_VERSION };
const wrong = Object.entries(expected).filter(([k, v]) => r[k] !== v);

// Under publish-what-changed (0.24.5) a registry may legitimately SIT OUT a release and
// keep its old number — so a mismatch is not automatically an error. It is an error when
// the registry DID publish. This script cannot know that from the tree alone, so it
// refuses and makes the operator say so, rather than guessing either way. Guessing
// "probably sat out" is how the stale coordinate ships; guessing "must have published"
// is how a correct lagging registry blocks a release.
if (wrong.length > 0) {
  const skipped = process.argv.includes("--sat-out")
    ? (process.argv[process.argv.indexOf("--sat-out") + 1] ?? "").split(",").filter(Boolean)
    : [];
  // npm can never sit out, and offering it as an option would be an invitation to
  // silence the one mismatch that is always a real defect: `<version>` IS the npm
  // version — `release.mjs` writes it into all 14 package.json files — so a payload
  // disagreeing with it means the payload was not rebuilt after the bump.
  if (skipped.includes("npm")) {
    die("npm cannot sit out a release — the version argument IS the npm version. " +
        "A mismatch here means `bun run site:payload` was not re-run after the bump.");
  }
  const unexplained = wrong.filter(([k]) => !skipped.includes(k));
  if (unexplained.length > 0) {
    die(
      `the site payload does not state this release:\n` +
      unexplained.map(([k, v]) => `    ${k}: payload says ${r[k] ?? "(absent)"}, this release is ${v}`).join("\n") +
      `\n\n  If those registries genuinely SAT OUT this release (publish-what-changed), say so:\n` +
      `    bun scripts/finish-release.mjs ${VERSION} --sat-out ` +
      `${unexplained.map(([k]) => k).filter((k) => k !== "npm").join(",")}\n` +
      `  Otherwise bump them, run \`bun run site:payload\`, commit, push, and re-run.`);
  }
  ok(`payload coordinates match (${skipped.join(", ")} sat this release out, as declared)`);
} else {
  ok(`payload states all four coordinates: npm ${r.npm} · PyPI ${r.pypi} · NuGet ${r.nuget} · Maven ${r.maven}`);
}

// ── 4. the injector and the payload are both IN the tree being tagged ────────
// The deploy runs the injector FROM the tag. A tag without it takes the skip branch in
// deploy.yml and the site publishes empty code blocks.
for (const rel of ["scripts/site-inject-ci.mjs", "examples/showcase/site-payload.json"]) {
  if (out(`git ls-tree -r --name-only HEAD -- ${rel}`) === "") {
    die(`${rel} is not in the tree being tagged — the deploy would find no injector and skip`);
  }
}
ok("the deploy's injector and payload are both in the tagged tree");

// ── 5. the tag the DEPLOY will resolve is the one being cut ──────────────────
// The repo carries two tag lines and `sort -V` over a bare `v*` returns v7.20.12, which
// has no examples/showcase at all. This mirrors deploy.yml's own filter, so a change to
// either is caught here rather than on a deploy nobody is watching.
const resolved = out(`git tag -l 'v0.*' | grep -E '^v0\\.[0-9]+\\.[0-9]+$' | sort -V | tail -1 || true`);
const wouldResolve = [resolved, tag].filter(Boolean).sort((a, b) =>
  a.localeCompare(b, undefined, { numeric: true })).at(-1);
if (wouldResolve !== tag) {
  die(`the deploy would still resolve ${resolved}, not ${tag} — check the v0.x tag line`);
}
ok(`the site deploy will resolve ${tag}`);

if (CHECK_ONLY) { ok("--check: gates passed; no tag cut"); process.exit(0); }

// ── 6. cut it ────────────────────────────────────────────────────────────────
execSync(`git tag -a ${tag} -m "metaobjects ${VERSION} / ${MAVEN_VERSION}"`, { cwd: REPO, stdio: "inherit" });
execSync(`git push origin ${tag}`, { cwd: REPO, stdio: "inherit" });
ok(`cut and pushed ${tag}`);
console.log(`\n  Next: \`gh release create ${tag}\` with the CHANGELOG section as the body.`);
console.log(`  The site's next deploy will pin to ${tag} and inject its payload.`);
