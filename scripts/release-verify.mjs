#!/usr/bin/env node
// Verify a coordinated release across ALL FOUR registries — and check that publishing is
// possible BEFORE anything irreversible happens.
//
//   node scripts/release-verify.mjs --preflight        # can we publish at all?
//   node scripts/release-verify.mjs 0.24.0             # is 0.24.0 actually live, everywhere?
//   node scripts/release-verify.mjs 0.24.0 --smoke     # ...plus a real external install
//   node scripts/release-verify.mjs 0.24.5 --registries=npm,maven
//                                                      # ...only the registries this cut published
//
// WHY THIS EXISTS. The 0.24.0 cut was verified by a dozen throwaway shell scripts written
// as it went, which is how two avoidable things happened: the auth check was improvised as
// a dist-tag WRITE against a published package (leaving a stray tag a bypass-2FA token
// cannot delete), and registry state was repeatedly re-derived by hand. Both are fixed
// checks, so they belong in a committed script.
//
// NOTHING HERE MUTATES A PUBLISHED PACKAGE. Read-only against every registry. The
// preflight answers "is the credential alive and is it the right TYPE" without writing.

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const VERSION = args.find((a) => /^\d+\.\d+\.\d+$/.test(a));
const PREFLIGHT = args.includes("--preflight");
const SMOKE = args.includes("--smoke");
const MVN = VERSION && `7.${VERSION.split(".").slice(1).join(".")}`;

// ── which registries this cut actually published ───────────────────────────────────────
// Since 0.24.5 a registry publishes ONLY when it has a changed product file, and adopts the
// then-current shared `minor.patch` when it does (docs/RELEASING.md). So "PyPI does not have
// 0.24.7" is the CORRECT state for a cut PyPI sat out — verifying all four unconditionally
// would report a red ✗ for a port behaving exactly as the rule requires, and a gate that
// fails on correct behaviour is one people learn to run with their eyes closed.
//
// Default stays ALL FOUR: a coordinated cut (any `expected-registry.json` / metamodelVersion
// move) publishes everywhere, and defaulting to "everything" means forgetting the flag
// over-checks rather than under-checks. Under-checking is the silent half.
const ALL_REGISTRIES = ["npm", "pypi", "nuget", "maven"];
const registriesArg = args.find((a) => a.startsWith("--registries="))?.split("=")[1]
  ?? (args.includes("--registries") ? args[args.indexOf("--registries") + 1] : undefined);
const REGISTRIES = registriesArg
  ? registriesArg.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
  : ALL_REGISTRIES;
const unknownRegistries = REGISTRIES.filter((x) => !ALL_REGISTRIES.includes(x));
if (unknownRegistries.length) {
  console.error(`unknown registry: ${unknownRegistries.join(", ")}`
    + `  (expected any of ${ALL_REGISTRIES.join(", ")})`);
  process.exit(2);
}

const NPM_PKGS = [
  "metadata", "render", "codegen-ts", "runtime-ts", "migrate-ts", "sdk", "docs-site",
  "runtime-web", "codegen-ts-react", "codegen-ts-tanstack", "react", "tanstack",
  "cli", "ai-runtime",
];
const NUGET_PKGS = ["metaobjects", "metaobjects.render", "metaobjects.codegen", "metaobjects.cli"];
const MVN_MODULES = ["metadata", "om", "omdb", "render", "codegen-spring", "codegen-kotlin",
  "metadata-ktx", "maven-plugin", "spring-boot-starter"];

let failures = 0;
const g = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const r = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); failures++; };
const w = (m) => console.log(`  \x1b[33m!\x1b[0m ${m}`);
const out = (c) => execSync(c, { encoding: "utf8" }).trim();
const head = async (url) => (await fetch(url, { method: "HEAD" })).status;

// ── preflight: can we publish, and is the token the right TYPE? ────────────────────────
// Read-only by design. A "Publish" token passes whoami AND `access list` (both reads) and
// then EOTPs on the first write, so neither proves write capability — say so rather than
// pretending, and never probe with a real write against a published package.
async function preflight() {
  console.log("\n── preflight ──\n");
  try { g(`npm auth: ${out("npm whoami")}`); }
  catch {
    r("npm is NOT authenticated (`npm whoami` failed)");
    console.log("      npm config set //registry.npmjs.org/:_authToken=<token>");
    console.log("      Must be Classic → Automation (or granular w/ 2FA-bypass). A 'Publish'");
    console.log("      token passes every read check, then EOTPs on the first publish.");
    return;
  }
  try {
    const n = out("npm access list packages @metaobjectsdev").split("\n").filter(Boolean).length;
    g(`npm scope access: ${n} packages visible`);
  } catch { w("could not list scope access (token may lack the read grant)"); }
  w("token TYPE cannot be proven without a write. Do NOT probe with `npm dist-tag add` on a");
  w("published package — a bypass-2FA token can add a tag and CANNOT delete it (403 since");
  w("2026-07-31). The tier-0 publish is the real probe: it fails first, before anything");
  w("depends on it, and `release.mjs` publishes in tier order for exactly that reason.");
}

// ── per-registry verification (all read-only) ──────────────────────────────────────────
async function verifyNpm() {
  console.log(`\n── npm @ ${VERSION} ──\n`);
  let ok = 0;
  for (const p of NPM_PKGS) {
    const name = `@metaobjectsdev/${p}`;
    try {
      const res = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2f")}`);
      const j = await res.json();
      if (j.versions?.[VERSION]) ok++;
      else r(`${name} missing ${VERSION}`);
    } catch (e) { r(`${name}: ${e.message}`); }
  }
  if (ok === NPM_PKGS.length) g(`all ${ok}/${NPM_PKGS.length} packages at ${VERSION}`);

  const tags = JSON.parse(out("npm view @metaobjectsdev/cli dist-tags --json"));
  tags.latest === VERSION ? g(`cli latest = ${VERSION}`) : r(`cli latest = ${tags.latest}`);
  // Stray tags are release residue: a stale `next` from an RC line, or a leftover probe.
  // Reported, never deleted here — deletion needs interactive 2FA (403 for bypass tokens).
  const stray = Object.keys(tags).filter((t) => t !== "latest");
  if (stray.length) w(`extra dist-tags on cli: ${stray.map((t) => `${t}=${tags[t]}`).join(", ")}`
    + "  → `npm dist-tag rm` needs an interactive-2FA session");
}

async function verifyPypi() {
  console.log(`\n── PyPI @ ${VERSION} ──\n`);
  const s = await head(`https://pypi.org/pypi/metaobjects/${VERSION}/json`);
  s === 200 ? g(`metaobjects ${VERSION}`) : r(`metaobjects ${VERSION} → HTTP ${s}`);
}

async function verifyNuget() {
  console.log(`\n── NuGet @ ${VERSION} ──\n`);
  for (const p of NUGET_PKGS) {
    const s = await head(`https://api.nuget.org/v3-flatcontainer/${p}/${VERSION}/${p}.${VERSION}.nupkg`);
    // nuget.org validation/indexing lags the push by minutes — a 404 shortly after a
    // publish is not yet a failure, so it warns rather than fails.
    s === 200 ? g(p) : w(`${p} → HTTP ${s} (indexing can lag ~10-30min after push)`);
  }
}

async function verifyMaven() {
  console.log(`\n── Maven Central @ ${MVN} ──\n`);
  for (const m of MVN_MODULES) {
    const s = await head(
      `https://repo1.maven.org/maven2/com/metaobjects/metaobjects-${m}/${MVN}/metaobjects-${m}-${MVN}.pom`);
    s === 200 ? g(`metaobjects-${m}`) : r(`metaobjects-${m} → HTTP ${s}`);
  }
}

// ── external install smoke ─────────────────────────────────────────────────────────────
// NOT under /tmp: Node's resolution walks up from the scratch dir, so a stray
// /tmp/node_modules shadows anything the throwaway project does not hoist. That produced a
// false MISSING-export report during the 0.24.0 cut; the false GREEN is the worse half.
function smoke() {
  console.log(`\n── external install smoke @ ${VERSION} ──\n`);
  const root = join(homedir(), ".cache", "metaobjects-release-smoke");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  for (let d = root; d !== dirname(d); d = dirname(d)) {
    if (existsSync(join(d, "node_modules")))
      return r(`${join(d, "node_modules")} would shadow the smoke — remove it and re-run`);
  }
  for (const mgr of ["npm", "pnpm"]) {
    const dir = join(root, mgr);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"),
      JSON.stringify({ name: "smoke", version: "1.0.0", type: "module", private: true }, null, 2));
    try {
      execSync(mgr === "npm"
        ? `npm i @metaobjectsdev/cli@${VERSION} --prefer-online`
        : `pnpm add @metaobjectsdev/cli@${VERSION}`, { cwd: dir, stdio: "pipe" });
      const v = execSync("./node_modules/.bin/meta --version", { cwd: dir, encoding: "utf8" }).trim();
      v.includes(VERSION) ? g(`${mgr}: meta --version = ${v}`) : r(`${mgr}: reports ${v}`);
      for (const c of ["init", "gen", "docs", "upgrade", "verify"]) {
        try { execSync(`./node_modules/.bin/meta ${c}`, { cwd: dir, stdio: "pipe" }); g(`${mgr}: meta ${c}`); }
        catch { r(`${mgr}: meta ${c} failed`); }
      }
    } catch (e) { r(`${mgr}: install failed — ${String(e.message).split("\n")[0]}`); }
  }
}

if (PREFLIGHT) await preflight();
if (VERSION) {
  const skipped = ALL_REGISTRIES.filter((x) => !REGISTRIES.includes(x));
  // Say what was NOT checked, every time. A scoped run that prints only ✓s reads exactly
  // like a full one, and "all checks passed" over a third of the registries is the report
  // that gets believed and shouldn't be.
  if (skipped.length) {
    console.log(`\n  \x1b[33m!\x1b[0m not verified this run: ${skipped.join(", ")}`
      + `  — declared as sitting ${VERSION} out (docs/RELEASING.md, publish-what-changed)`);
  }
  if (REGISTRIES.includes("npm")) await verifyNpm();
  if (REGISTRIES.includes("pypi")) await verifyPypi();
  if (REGISTRIES.includes("nuget")) await verifyNuget();
  if (REGISTRIES.includes("maven")) await verifyMaven();
  if (SMOKE) {
    if (REGISTRIES.includes("npm")) smoke();
    else w("smoke skipped — it installs from npm, which is not in --registries");
  }
}
if (!PREFLIGHT && !VERSION) {
  console.error("usage: release-verify.mjs [--preflight] [<version>] [--smoke]"
    + " [--registries=npm,pypi,nuget,maven]");
  process.exit(2);
}

console.log(failures
  ? `\n\x1b[31m✗ ${failures} check(s) failed\x1b[0m\n`
  : `\n\x1b[32m✓ all checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
