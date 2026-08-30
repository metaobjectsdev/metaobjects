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

// The Maven line runs on its own major and shares only `minor.patch` (ADR-0035).
// Derived rather than passed as a second argument, so the two cannot be inconsistent.
//
// The major is NOT always 7. ADR-0035 and `docs/1.0-readiness.md` fix the JVM coordinate
// at **8.0.0** when npm/PyPI/NuGet cut 1.0.0 — a forward major, not a continuation. A
// hardcoded 7 would demand `7.0.0` at that release while the manifest and Maven Central
// both said `8.0.0`, blocking the cut, with the only ways past being to declare Maven
// (which definitely published) as --sat-out or to write a wrong coordinate into the
// payload. Both defeat the gate.
const [npmMajor, ...npmRest] = VERSION.split(".");
const MAVEN_MAJOR = Number(npmMajor) >= 1 ? 7 + Number(npmMajor) : 7;
const MAVEN_VERSION = `${MAVEN_MAJOR}.${npmRest.join(".")}`;

// ── 1. the working tree is the tree that will be tagged ──────────────────────
// A tag points at a COMMIT, so anything uncommitted is silently excluded. Tagging with
// a dirty tree is how a payload fix sits on disk while the tag names the tree without it.
if (out("git status --porcelain") !== "") {
  die("working tree is dirty — commit or stash before tagging, or the tag names a tree you did not review");
}
if (out("git rev-parse --abbrev-ref HEAD") !== "main") die("not on main");
// NOT `|| true`. A swallowed fetch leaves `origin/main` at a STALE remote-tracking ref,
// and the very next comparison then prints "synced with origin" having verified nothing —
// with git's own "Could not read from remote repository" scrolling past just above the
// tick. The realistic case is the port-bump commit pushed from another checkout while
// this operator's fetch fails: HEAD matches the stale ref, and the tag is cut on a tree
// that predates the bump. A fetch that fails means the sync claim cannot be made.
try {
  execSync("git fetch origin --quiet", { cwd: REPO, stdio: ["ignore", "ignore", "pipe"] });
} catch (e) {
  die(`git fetch origin failed, so "synced with origin" cannot be verified: ` +
      `${e instanceof Error ? e.message : String(e)}`);
}
if (out("git rev-parse HEAD") !== out("git rev-parse origin/main")) {
  die("HEAD is not origin/main — push first; the deploy clones the REMOTE tag");
}
ok("on main, clean, synced with origin");

// ── 2. the tag is free ───────────────────────────────────────────────────────
// Never move a tag. A moved tag silently changes what the website deploys, and any
// clone that already fetched it keeps the old one — two truths for one name.
const tag = `v${VERSION}`;
if (out(`git tag -l ${tag}`) !== "") {
  const onOrigin = out(`git ls-remote --tags origin ${tag}`) !== "";
  die(onOrigin
    ? `${tag} already exists locally and on origin — never move a release tag`
    : `${tag} exists LOCALLY but not on origin — a previous run tagged and failed to push.\n` +
      `  That is the one safe case to clear: \`git tag -d ${tag}\`, then re-run.`);
}
if (out(`git ls-remote --tags origin ${tag}`) !== "") die(`${tag} already exists on origin — never move a release tag`);
ok(`${tag} is free on both local and origin`);

// ── 3. the payload states what actually shipped ──────────────────────────────
// The whole reason the tag moved to the end.
const payloadPath = join(REPO, "examples/showcase/site-payload.json");
if (!existsSync(payloadPath)) die(`missing ${payloadPath}`);
/** @type {{registries?: Record<string, string>}} */
let payload;
try {
  payload = JSON.parse(readFileSync(payloadPath, "utf8"));
} catch (e) {
  // A die(), not an unhandled parse crash. Both exit non-zero, but only one tells the
  // operator which file to look at.
  die(`${payloadPath} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
}
const r = payload.registries ?? {};

/**
 * Where each coordinate's OWN manifest lives — the same four files `readRegistries`
 * reads when it builds the payload.
 *
 * This is the discriminator that makes `--sat-out` safe, and without it the flag is a
 * loaded gun. See the ruling below.
 */
const MANIFESTS = new Map([
  ["npm", { file: "server/typescript/packages/cli/package.json", re: /"version":\s*"([^"]+)"/ }],
  ["pypi", { file: "server/python/pyproject.toml", re: /^version\s*=\s*"([^"]+)"/m }],
  ["nuget", { file: "server/csharp/Directory.Build.props", re: /<Version>([^<]+)<\/Version>/ }],
  ["maven", { file: "server/java/pom.xml", re: /<version>([^<]+)<\/version>/ }],
]);

/** @type {(key: string) => string | undefined} */
function manifestVersion(key) {
  const entry = MANIFESTS.get(key);
  if (entry === undefined) return undefined;
  const full = join(REPO, entry.file);
  if (!existsSync(full)) return undefined;
  return entry.re.exec(readFileSync(full, "utf8"))?.[1];
}

/** Registries that move on the shared `minor.patch`, and what they must read. */
const expected = { npm: VERSION, pypi: VERSION, nuget: VERSION, maven: MAVEN_VERSION };
const wrong = Object.entries(expected).filter(([k, v]) => r[k] !== v);

// Under publish-what-changed (0.24.5) a registry may legitimately SIT OUT a release and
// keep its old number, so a mismatch is not automatically an error.
//
// **`--sat-out` used to be offered for ANY mismatch, and that made this gate able to
// authorise the exact defect it exists to prevent.** The remedy line printed a
// copy-pasteable command pre-filled with whatever mismatched — and the overwhelmingly
// likely cause of a mismatch is not a registry sitting out, it is `bun run site:payload`
// not having been re-run after the bump. An operator following the script's own advice
// would silence three real mismatches and cut a tag stating three versions that were
// never released: v0.24.5's defect, reproduced by the tool written to prevent it.
//
// The discriminator was there all along. A registry that SAT OUT has an unmoved MANIFEST
// — `pyproject.toml` still reads the old number. A payload that was not rebuilt sits
// beside a manifest that DID move. So "sat out" is mechanically decidable and is no
// longer something the operator may simply assert.
/** @type {(k: string) => boolean} */
const satOutIsPlausible = (k) => {
  const m = manifestVersion(k);
  // Unknown manifest ⇒ refuse to call it sat-out. Fail closed.
  const want = new Map(Object.entries(expected)).get(k);
  return m !== undefined && m === r[k] && m !== want;
};

if (wrong.length > 0) {
  const idx = process.argv.indexOf("--sat-out");
  const raw = idx === -1 ? "" : (process.argv[idx + 1] ?? "");
  // A following flag is not a value. `--sat-out --check` used to make "--check" a
  // registry name; harmless only because no registry is called that.
  const skipped = raw.startsWith("--") ? [] : raw.split(",").filter(Boolean);

  // npm can never sit out: `<version>` IS the npm version — `release.mjs` writes it into
  // all 14 package.json files — so a mismatch there always means the payload is stale.
  // Checked BEFORE the generic branch so the accurate message is reachable: it used to
  // fire only when an operator explicitly typed `npm`, which nobody does.
  if (wrong.some(([k]) => k === "npm")) {
    die(`the site payload says npm ${r.npm ?? "(absent)"}, but this release is ${VERSION}.\n` +
        `  npm cannot sit out — the version argument IS the npm version.\n` +
        `  Run \`bun run site:payload\`, commit, push, and re-run.`);
  }

  const declaredButImplausible = skipped.filter((k) => !satOutIsPlausible(k));
  if (declaredButImplausible.length > 0) {
    die(
      `these registries were declared --sat-out, but their own manifests say otherwise:\n` +
      declaredButImplausible.map((k) =>
        `    ${k}: manifest says ${manifestVersion(k) ?? "(unreadable)"}, payload says ${r[k] ?? "(absent)"}`
      ).join("\n") +
      `\n\n  A registry that truly sat out has an UNMOVED manifest. A manifest that moved\n` +
      `  while the payload did not means \`bun run site:payload\` was not re-run — which is\n` +
      `  the defect this gate exists to catch, so it will not be waived.`);
  }

  const unexplained = wrong.filter(([k]) => !skipped.includes(k));
  if (unexplained.length > 0) {
    // Only registries whose manifests corroborate them are offered as sat-out. If none
    // do, no command is suggested at all — an empty `--sat-out` used to be printed as a
    // remedy, and running it looped straight back to this same error.
    const offerable = unexplained.map(([k]) => k).filter(satOutIsPlausible);
    die(
      `the site payload does not state this release:\n` +
      unexplained.map(([k, v]) => `    ${k}: payload says ${r[k] ?? "(absent)"}, this release is ${v}` +
        (satOutIsPlausible(k) ? "  (manifest agrees with the payload — may have sat out)" : "  (manifest already moved — payload is STALE)")
      ).join("\n") +
      `\n\n  Fix: bump them, run \`bun run site:payload\`, commit, push, and re-run.` +
      (offerable.length > 0
        ? `\n  Or, if these genuinely sat this release out (publish-what-changed):\n` +
          `    bun scripts/finish-release.mjs ${VERSION} --sat-out ${offerable.join(",")}`
        : ``));
  }
  ok(`payload coordinates match (${skipped.join(", ")} sat this release out, manifests agree)`);
} else {
  ok(`payload states all four coordinates: npm ${r.npm} · PyPI ${r.pypi} · NuGet ${r.nuget} · Maven ${r.maven}`);
}

// ── 4. the injector and the payload are both IN the tree being tagged ────────
// The deploy runs the injector FROM the tag. A tag without it takes the skip branch in
// deploy.yml and the site publishes empty code blocks.
// `scripts/site/inject.mjs` is listed because `site-inject-ci.mjs` IMPORTS it. With the
// entrypoint present and the module absent, deploy.yml does NOT take its skip branch —
// it runs the injector and dies on ERR_MODULE_NOT_FOUND, taking the deploy with it.
//
// `site-reference/` is listed because the deploy COPIES it to /reference. Its own
// freshness gate lives in the `gates` lane, which is not consulted here, so a tag cut
// while that lane is red would publish 16 pages documenting the previous vocabulary.
for (const rel of [
  "scripts/site-inject-ci.mjs",
  "scripts/site/inject.mjs",
  "examples/showcase/site-payload.json",
  "site-reference/index.html",
]) {
  if (out(`git ls-tree -r --name-only HEAD -- ${rel}`) === "") {
    die(`${rel} is not in the tree being tagged — the deploy would publish an incomplete site`);
  }
}
ok("the deploy's injector, payload and rendered reference are all in the tagged tree");

// ── 5. the llms mirrors state this release ───────────────────────────────────
// The site COPIES docs/llms/* from this tag (Task 15), so a mirror that lags makes the
// published site lag — silently, because the copy succeeds and stale numbers look like
// fresh ones. `v0.24.5` carries mirrors reading `0.24.4`, because the docs refresh has
// always been a post-tag commit; with the tag moving to the end, it no longer has to be.
for (const rel of ["docs/llms/llms.txt", "docs/llms/llms-full.txt"]) {
  // `git show HEAD:<path>` THROWS on a missing path, unlike the `git ls-tree` / `git
  // tag -l` calls above which exit 0 with empty output. Unhandled it would abort with a
  // stack trace instead of the diagnostic below — still fail-closed, but useless.
  let text;
  try {
    text = out(`git show HEAD:${rel}`);
  } catch {
    die(`${rel} is not in the tree being tagged — the site copies the mirrors from this tag`);
  }

  // Checked on the SUMMARY LINE, not as a whole-file substring.
  //
  // The version appears in six or more places in each mirror, so `text.includes(VERSION)`
  // passes when ANY ONE of them was refreshed. The realistic miss is a refreshed summary
  // beside an untouched `## Implementations (...)` heading and Maven install snippet — a
  // page whose headline says the new release and whose copy-paste block installs the old
  // one. `scripts/site/llms.test.ts` already draws exactly this distinction: "the file
  // mentions 0.24.5 somewhere" and "the summary says we ship 0.24.5" are different claims.
  const summary = text.split("\n").find((l) => l.startsWith("> A cross-language"));
  if (summary === undefined) {
    die(`${rel} has no "> A cross-language …" summary line — the shape this gate reads changed`);
  }
  const missing = [
    ...(summary.includes(VERSION) ? [] : [`npm ${VERSION}`]),
    ...(summary.includes(MAVEN_VERSION) ? [] : [`Maven ${MAVEN_VERSION}`]),
  ];
  if (missing.length > 0) {
    die(`${rel}'s summary line does not name ${missing.join(" or ")} — refresh the mirrors ` +
        `before tagging, or the site publishes the previous release's versions ` +
        `(RELEASING-docs-checklist).\n    ${summary.slice(0, 120)}…`);
  }

  // The summary alone is NOT enough, and getting that wrong once is worth recording: the
  // first version of this fix checked only the summary, which closes "refreshed the
  // heading, missed the summary" and leaves its mirror image — a refreshed summary beside
  // an untouched install block — wide open. That is the worse of the two: the headline
  // says the new release and the copy-paste line installs the old one.
  //
  // So every OTHER line that makes a shipping claim is checked too. A line qualifies when
  // it names a registry AND a version; a version named anywhere else is free to be
  // historical ("retired in `0.24.0`"), which is the false-failure this deliberately
  // avoids — an earlier blanket rule tripped on exactly that sentence.
  const CLAIM = /\b(npm|PyPI|NuGet|Maven Central)\b/;
  const NPM_VER = /\b0\.\d+\.\d+\b/g;
  const MVN_VER = /\b7\.\d+\.\d+\b/g;
  const bad = [];
  for (const line of [summary, ...text.split("\n").filter((l) => l !== summary && CLAIM.test(l))]) {
    const stale = [
      ...[...line.matchAll(NPM_VER)].map((m) => m[0]).filter((v) => v !== VERSION),
      ...[...line.matchAll(MVN_VER)].map((m) => m[0]).filter((v) => v !== MAVEN_VERSION),
    ];
    if (stale.length > 0) bad.push(`${stale.join(", ")}  in: ${line.trim().slice(0, 100)}`);
  }
  if (bad.length > 0) {
    die(`${rel} names a version this release did not ship, on a line that makes a ` +
        `registry claim — a partial refresh:\n    ${bad.slice(0, 6).join("\n    ")}` +
        (bad.length > 6 ? `\n    …and ${bad.length - 6} more` : ``));
  }
}
ok("the llms mirrors state this release");

// ── 6. the tag the DEPLOY will resolve is the one being cut ──────────────────
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

// ── 7. cut it ────────────────────────────────────────────────────────────────
execSync(`git tag -a ${tag} -m "metaobjects ${VERSION} / ${MAVEN_VERSION}"`, { cwd: REPO, stdio: "inherit" });
execSync(`git push origin ${tag}`, { cwd: REPO, stdio: "inherit" });
ok(`cut and pushed ${tag}`);
console.log(`\n  Next: \`gh release create ${tag}\` with the CHANGELOG section as the body.`);
console.log(`  The site's next deploy will pin to ${tag} and inject its payload.`);
