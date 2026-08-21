#!/usr/bin/env node
// scripts/check-metamodel-version.mjs
//
// GATE — `metamodelVersion` must move when the metamodel does.
//
// ADR-0035 Amendment 2 gives the project two contracts on two numbers: the package
// version promises the SOFTWARE surface, and `metamodelVersion` promises the METADATA
// contract (registered vocabulary + canonical/interchange format + wire contract). A
// breaking metamodel change moves `metamodelVersion`'s major and NOT the package major.
//
// That amendment made a number load-bearing that, measured, nobody had ever moved:
// `metamodelVersion` has read "0.9" since it shipped in PR #145 (2026-07-02) and stayed
// there across 57 releases — including `0.21.0`, which deliberately retired assembly
// origins from `object.value` and shrank `@role`. A promise carried by a number no one
// maintains is not a promise. This is the thing that would have caught that.
//
// WHAT IT DOES
//   Diffs `fixtures/registry-conformance/expected-registry.json` — already the byte-exact
//   bill of materials every port is gated against — against its content at the last
//   published release tag, classifies each difference, and asserts the declared
//   `metamodelVersion` moved by at least the amount the change requires.
//
//   This is the `buf breaking --against '.git#tag=…'` / `oasdiff` shape: compare the
//   artifact to its last released baseline, classify, then require the declared version
//   to match the classification. The baseline is the last RELEASE TAG, not HEAD~1,
//   because the version promises against what adopters actually have — and because a
//   per-commit baseline would demand a bump from every PR in a release cycle rather than
//   the first one.
//
// WHAT IT CANNOT SEE, stated because a gate that hides its blind spot is worse than none
//   A rule can change with NO machine-readable footprint. #210 is the proof: retiring
//   assembly origins from `object.value` was a breaking metamodel change whose ONLY
//   manifest edit was the `rules` PROSE string ("…by assembly"). The loader enforced the
//   new rule; the structured vocabulary was untouched.
//
//   So prose changes (`description` / `rules` / `whenToUse`) are reported as a WARNING
//   with a direct question rather than classified. A typo fix and a semantics change are
//   indistinguishable here, and failing on every wording edit would train people to
//   ignore the gate.
//
// USAGE
//   node scripts/check-metamodel-version.mjs              # gate (CI + ci-local `gates`)
//   node scripts/check-metamodel-version.mjs --against v0.23.2
//   node scripts/check-metamodel-version.mjs --explain    # classify + print, always exit 0
//   node scripts/check-metamodel-version.mjs --set 1.0    # write the version to all 5 sites
//
// See docs/RELEASING.md → "The two-contracts rule".

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = "fixtures/registry-conformance/expected-registry.json";

/**
 * Every site that declares the metamodel version. The manifest is the one the
 * conformance corpus byte-matches; the four port constants are what each port EMITS
 * into its own manifest, so a partial edit is caught by `registry-conformance` — but
 * only in the lane for the port you forgot. `--set` writes all of them at once so that
 * failure mode does not need catching. (Kotlin has no constant of its own: it emits
 * through the JVM `RegistryManifest`.)
 */
const SITES = [
  { path: MANIFEST, re: /("metamodelVersion":\s*")([^"]+)(")/ },
  {
    path: "server/typescript/packages/metadata/src/registry-manifest.ts",
    re: /(export const METAMODEL_VERSION = ")([^"]+)(")/,
  },
  {
    path: "server/python/src/metaobjects/registry_manifest.py",
    re: /(^METAMODEL_VERSION = ")([^"]+)(")/m,
  },
  {
    path: "server/java/metadata/src/main/java/com/metaobjects/registry/RegistryManifest.java",
    re: /(public static final String METAMODEL_VERSION = ")([^"]+)(")/,
  },
  {
    path: "server/csharp/MetaObjects/RegistryManifest.cs",
    re: /(public const string MetamodelVersion = ")([^"]+)(")/,
  },
];

// ---------------------------------------------------------------------------
// Version arithmetic. `metamodelVersion` is `major.minor` ("0.9", "1.0") — the
// `Metamodel N.M` form ADR-0035 §2 names. No patch component: a metamodel has no
// bug-fix axis, only "what is declarable" and "what it means".
// ---------------------------------------------------------------------------

export function parseVersion(raw, where) {
  const m = /^(\d+)\.(\d+)$/.exec(String(raw ?? "").trim());
  if (!m) {
    fail(`${where}: metamodelVersion must be "<major>.<minor>" (got ${JSON.stringify(raw)})`);
  }
  return { major: Number(m[1]), minor: Number(m[2]), raw: String(raw) };
}

/** Pre-1.0 the number itself carries no promise, so a BREAKING change moves the MINOR —
 *  the same rule the package line follows while it is `0.x`, and the same reason:
 *  `0.y` makes no compatibility claim to break. At 1.0 the major becomes real. */
const isPre1 = (v) => v.major === 0;

export function requiredBump(severity, base) {
  if (severity === "none") return "none";
  if (severity === "additive") return "minor";
  return isPre1(base) ? "minor" : "major"; // breaking
}

export function satisfies(bump, base, cur) {
  if (bump === "none") return true;
  if (bump === "major") return cur.major > base.major;
  // MINOR — compare the (major, minor) TUPLE, never the components independently.
  // `cur.major > base.major || cur.minor > base.minor` reads as "moved somehow" and
  // accepts a REGRESSION: 1.0 → 0.11 passes it (0 > 1 is false, but 11 > 0 is true), as
  // does 2.0 → 1.9. That is not hypothetical — post-1.0, `--set 0.11` typed out of
  // pre-1.0 habit, or a bad merge resolving the manifest to an older value, would ship a
  // release declaring a LOWER metamodel version than the one before it, with every port
  // byte-matching the manifest so registry-conformance stays green too.
  return cur.major > base.major || (cur.major === base.major && cur.minor > base.minor);
}

// ---------------------------------------------------------------------------
// Classification.
//
// BREAKING  — metadata that used to load may now fail, or mean something else.
// ADDITIVE  — every previously-valid document still loads, identically.
// PROSE     — human-readable only; the classifier declines to guess (see the header).
// ---------------------------------------------------------------------------

const PROSE_KEYS = ["description", "rules", "whenToUse"];

const typeKey = (t) => `${t.type}.${t.subType}`;
const childKey = (c) => `${c.childType}.${c.childSubType}/${c.childName}`;
const byKey = (arr, key) => new Map((arr ?? []).map((x) => [key(x), x]));

export function classify(base, cur) {
  const breaking = [];
  const additive = [];
  const prose = [];

  // ---- types (a `type.subType` pair is a declarable vocabulary member) ----
  const bT = byKey(base.types, typeKey);
  const cT = byKey(cur.types, typeKey);
  for (const k of bT.keys()) {
    if (!cT.has(k)) breaking.push(`type removed: ${k}`);
  }
  for (const k of cT.keys()) {
    if (!bT.has(k)) additive.push(`type added: ${k}`);
  }

  for (const [k, c] of cT) {
    const b = bT.get(k);
    if (!b) continue;
    diffProse(b, c, k, prose);
    diffAttrs(b.attrs, c.attrs, k, breaking, additive, prose);
    diffChildren(b.children, c.children, k, breaking, additive);
  }

  // ---- commonAttrs (registered on every node) ----
  diffAttrs(base.commonAttrs, cur.commonAttrs, "commonAttrs", breaking, additive, prose);

  // ---- defaultSubTypes (decides what an unqualified declaration MEANS) ----
  const bD = base.defaultSubTypes ?? {};
  const cD = cur.defaultSubTypes ?? {};
  for (const [t, sub] of Object.entries(bD)) {
    if (!(t in cD)) breaking.push(`default subtype removed: ${t} (was ${sub})`);
    else if (cD[t] !== sub) breaking.push(`default subtype changed: ${t} ${sub} → ${cD[t]}`);
  }
  for (const t of Object.keys(cD)) {
    if (!(t in bD)) additive.push(`default subtype added: ${t} = ${cD[t]}`);
  }

  return { breaking, additive, prose };
}

function diffProse(b, c, where, prose) {
  for (const k of PROSE_KEYS) {
    if ((b[k] ?? null) !== (c[k] ?? null)) prose.push(`${where}: ${k}`);
  }
}

function diffAttrs(baseAttrs, curAttrs, where, breaking, additive, prose) {
  const b = byKey(baseAttrs, (a) => a.name);
  const c = byKey(curAttrs, (a) => a.name);

  for (const name of b.keys()) {
    if (!c.has(name)) breaking.push(`attr removed: ${where} @${name}`);
  }
  for (const [name, ca] of c) {
    if (!b.has(name)) {
      // A REQUIRED attr appearing where there was none convicts every existing
      // document that omits it — additive in the registry, breaking in practice.
      if (ca.required) breaking.push(`required attr added: ${where} @${name}`);
      else additive.push(`attr added: ${where} @${name}`);
      continue;
    }
    const ba = b.get(name);
    const at = `${where} @${name}`;

    if (!ba.required && ca.required) breaking.push(`attr became required: ${at}`);
    if (ba.required && !ca.required) additive.push(`attr became optional: ${at}`);
    if (ba.valueType !== ca.valueType) {
      breaking.push(`attr valueType changed: ${at} ${ba.valueType} → ${ca.valueType}`);
    }
    const bArr = Boolean(ba.isArray);
    const cArr = Boolean(ca.isArray);
    if (bArr !== cArr) breaking.push(`attr isArray changed: ${at} ${bArr} → ${cArr}`);

    // allowedValues: a closed set. Removing a member, or closing a previously-open
    // attr, rejects a value that used to load. Adding one only permits more.
    const bv = ba.allowedValues ?? null;
    const cv = ca.allowedValues ?? null;
    if (bv === null && cv !== null) breaking.push(`attr became a closed enum: ${at} [${cv}]`);
    else if (bv !== null && cv === null) additive.push(`attr enum opened: ${at}`);
    else if (bv && cv) {
      const gone = bv.filter((v) => !cv.includes(v));
      const added = cv.filter((v) => !bv.includes(v));
      if (gone.length) breaking.push(`enum member removed: ${at} [${gone.join(", ")}]`);
      if (added.length) additive.push(`enum member added: ${at} [${added.join(", ")}]`);
    }

    diffProse(ba, ca, at, prose);
  }
}

function diffChildren(baseKids, curKids, where, breaking, additive) {
  const b = byKey(baseKids, childKey);
  const c = byKey(curKids, childKey);

  for (const k of b.keys()) {
    if (!c.has(k)) breaking.push(`child rule removed: ${where} ← ${k}`);
  }
  for (const [k, ck] of c) {
    if (!b.has(k)) {
      // A child that must be present convicts every existing parent that lacks it.
      if ((ck.min ?? 0) > 0) breaking.push(`required child rule added: ${where} ← ${k}`);
      else additive.push(`child rule added: ${where} ← ${k}`);
      continue;
    }
    const bk = b.get(k);
    const at = `${where} ← ${k}`;
    const bMin = bk.min ?? 0;
    const cMin = ck.min ?? 0;
    if (cMin > bMin) breaking.push(`child min raised: ${at}`);
    if (bMin > cMin) additive.push(`child min lowered: ${at}`);

    // max === null means unbounded; lowering a bound (or introducing one) rejects a
    // parent that already declares more children than the new cap.
    const bMax = bk.max ?? Infinity;
    const cMax = ck.max ?? Infinity;
    if (cMax < bMax) breaking.push(`child max lowered: ${at} ${bk.max ?? "∞"} → ${ck.max ?? "∞"}`);
    if (cMax > bMax) additive.push(`child max raised: ${at}`);
  }
}

// ---------------------------------------------------------------------------
// Git plumbing.
// ---------------------------------------------------------------------------

const git = (...args) =>
  execFileSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** The highest published release tag on the npm/PyPI/NuGet line (`v0.*` / `v1.*` …).
 *  The four registries cut together, so any one line dates the metamodel baseline. */
function lastReleaseTag() {
  const tags = git("tag", "--list", "v[0-6].*", "--sort=-version:refname")
    .split("\n")
    .map((t) => t.trim())
    .filter(Boolean);
  return tags[0] ?? null;
}

/**
 * Read the baseline manifest, distinguishing "genuinely not there yet" (skip) from
 * "something went wrong" (fail). The previous form swallowed EVERY error into `null`,
 * which `main()` reported as "pre-marker tag — skipping" and exited 0 — so a typo'd ref,
 * a partial clone whose objects were never fetched, a renamed path or malformed JSON all
 * produced a green tick having compared nothing. That is the exact failure the
 * no-baseline branch already refuses by name; it does not get a side door.
 *
 * Returns `{ manifest }` or `{ skip }`; anything else calls `fail()`.
 */
function readManifestAt(ref) {
  try {
    git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
  } catch {
    fail(`--against ${JSON.stringify(ref)} is not a resolvable git ref.`);
  }

  // Ask the TREE whether the path exists, rather than inferring absence from a failed
  // `git show`. In a blobless/partial clone the ref and its trees resolve while the blob
  // does not, and `git show` failing there means "not fetched", not "not present".
  const listed = git("ls-tree", "-r", "--name-only", ref, "--", MANIFEST).trim();
  if (!listed) return { skip: `${MANIFEST} does not exist at ${ref}` };

  let raw;
  try {
    raw = git("show", `${ref}:${MANIFEST}`);
  } catch (e) {
    fail(
      `${MANIFEST} is present in the tree at ${ref} but could not be read.\n` +
        `  Usually a partial/blobless clone — fetch the objects, or pass a different\n` +
        `  --against ref. Underlying error: ${e.message.split("\n")[0]}`,
    );
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    fail(`${MANIFEST} at ${ref} is not valid JSON: ${e.message}`);
  }

  // The marker itself post-dates the manifest (added in PR #145), so a baseline older
  // than that carries the file WITHOUT the key. Keying the skip on the file's existence
  // instead made `--against v0.15.0` die with `metamodelVersion must be "<major>.<minor>"
  // (got undefined)` — a confusing failure for a documented flag.
  if (json.metamodelVersion === undefined) {
    return { skip: `${MANIFEST} at ${ref} predates the metamodelVersion marker (PR #145)` };
  }
  return { manifest: json };
}

function fail(msg) {
  process.stderr.write(`\n✗ metamodel-version: ${msg}\n\n`);
  process.exit(1);
}

const bullets = (list, cap = 12) =>
  list
    .slice(0, cap)
    .map((x) => `    - ${x}`)
    .concat(list.length > cap ? [`    … and ${list.length - cap} more`] : [])
    .join("\n");

// ---------------------------------------------------------------------------
// --set: write the version to every declaring site at once.
// ---------------------------------------------------------------------------

function setVersion(next) {
  parseVersion(next, "--set");
  for (const site of SITES) {
    const abs = resolve(REPO, site.path);
    const src = readFileSync(abs, "utf8");
    if (!site.re.test(src)) fail(`--set: no metamodelVersion declaration found in ${site.path}`);
    writeFileSync(abs, src.replace(site.re, `$1${next}$3`), "utf8");
    process.stdout.write(`  updated ${site.path}\n`);
  }
  process.stdout.write(
    `\n✓ metamodelVersion set to "${next}" in ${SITES.length} sites.\n` +
      `  Re-run the registry-conformance corpus in every port — it byte-matches the\n` +
      `  manifest, so a port left behind fails there.\n\n`,
  );
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  const arg = (flag) => {
    const i = argv.indexOf(flag);
    if (i === -1) return null;
    const value = argv[i + 1];
    // Blindly taking the next token turns `--against --explain` into a ref named
    // "--explain", which then resolves to nothing and (before the fix above) passed.
    if (value === undefined || value.startsWith("--")) fail(`${flag} needs a value`);
    return value;
  };

  if (argv.includes("--set")) {
    setVersion(arg("--set"));
    process.exit(0);
  }

  const explain = argv.includes("--explain");
  const against = arg("--against") ?? lastReleaseTag();

  if (!against && argv.includes("--allow-no-baseline")) {
    process.stdout.write("  metamodel-version: no release tag, --allow-no-baseline given — skipped.\n");
    process.exit(0);
  }

  if (!against) {
    // Fail LOUD, not open. This repository has 90 release tags; the only way to see
    // zero is a checkout that did not fetch them (`fetch-depth: 1`), and a baseline-less
    // run of this gate passes unconditionally — a green tick that checked nothing.
    fail(
      "no release tag matched — the baseline is missing, so this gate would pass\n" +
        "  without comparing anything.\n\n" +
        "  Almost always a shallow checkout: use `fetch-depth: 0` (which fetches tags),\n" +
        "  or pass an explicit baseline with --against <ref>.\n" +
        "  A genuinely tagless checkout can opt out with --allow-no-baseline.",
    );
  }

  const current = JSON.parse(readFileSync(resolve(REPO, MANIFEST), "utf8"));
  const read = readManifestAt(against);

  if (read.skip) {
    process.stdout.write(`  metamodel-version: ${read.skip} — skipping.\n`);
    process.exit(0);
  }
  const baseline = read.manifest;

  const baseVer = parseVersion(baseline.metamodelVersion, against);
  const curVer = parseVersion(current.metamodelVersion, "working tree");

  const { breaking, additive, prose } = classify(baseline, current);
  let severity = "none";
  if (breaking.length) severity = "breaking";
  else if (additive.length) severity = "additive";
  const bump = requiredBump(severity, baseVer);

  if (explain) {
    process.stdout.write(`metamodel-version: ${against} (${baseVer.raw}) → working tree (${curVer.raw})\n\n`);
    if (breaking.length) process.stdout.write(`  BREAKING (${breaking.length}):\n${bullets(breaking, 100)}\n\n`);
    if (additive.length) process.stdout.write(`  ADDITIVE (${additive.length}):\n${bullets(additive, 100)}\n\n`);
    if (prose.length) process.stdout.write(`  PROSE (${prose.length}, not classified):\n${bullets(prose, 100)}\n\n`);
    if (!breaking.length && !additive.length && !prose.length) process.stdout.write("  no differences.\n\n");
    process.stdout.write(`  required bump: ${bump}\n`);
    process.exit(0);
  }

  // ---- the prompt: prose the classifier declines to judge ----
  if (prose.length) {
    process.stdout.write(
      `\n  ⚠ metamodel-version: ${prose.length} prose field(s) changed since ${against}:\n` +
        `${bullets(prose)}\n\n` +
        `    Did the RULE change, or only its wording? A rule can change with no\n` +
        `    machine-readable footprint — #210 retired assembly origins from object.value\n` +
        `    and its only manifest edit was a \`rules\` string. If the rule changed, this is\n` +
        `    a metamodel ${isPre1(baseVer) ? "MINOR" : "MAJOR"}: run\n` +
        `      node scripts/check-metamodel-version.mjs --set <version>\n\n`,
    );
  }

  if (satisfies(bump, baseVer, curVer)) {
    const moved = curVer.raw !== baseVer.raw ? ` (${baseVer.raw} → ${curVer.raw})` : "";
    process.stdout.write(
      `  metamodel-version: ${severity} change since ${against}; declared ${curVer.raw}${moved} — ok.\n`,
    );
    process.exit(0);
  }

  fail(
    `the metamodel changed since ${against}, but metamodelVersion did not move.\n\n` +
      (breaking.length ? `  BREAKING (${breaking.length}):\n${bullets(breaking)}\n\n` : "") +
      (additive.length ? `  ADDITIVE (${additive.length}):\n${bullets(additive)}\n\n` : "") +
      `  declared: ${curVer.raw} (unchanged since ${against})\n` +
      `  required: a ${bump.toUpperCase()} bump` +
      (bump === "minor" && isPre1(baseVer)
        ? ` — pre-1.0 the metamodel major carries no promise, so a BREAKING change moves the minor,\n` +
          `            exactly as the package line does while it is 0.x`
        : "") +
      `\n\n  Fix:  node scripts/check-metamodel-version.mjs --set ${
        bump === "major" ? `${baseVer.major + 1}.0` : `${baseVer.major}.${baseVer.minor + 1}`
      }\n` +
      `  Then say so in the CHANGELOG — post-1.0 the caret rule no longer gates the\n` +
      `  metadata axis, so the changelog is the adopter's only signal (ADR-0035 Am. 2).\n` +
      `  Detail: node scripts/check-metamodel-version.mjs --explain`,
  );

}

// Run only as a script — scripts/test-metamodel-version.mjs imports the pure
// classifier above and drives each rule against synthetic manifests.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
