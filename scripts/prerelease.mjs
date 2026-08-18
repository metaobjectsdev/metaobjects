#!/usr/bin/env bun
// Publish a PRE-RELEASE of the in-development version to a PRIVATE registry, so an
// unreleased change can be iterated against downstream consumers without cutting a real
// release on npm / PyPI / NuGet / Maven Central.
//
//   bun run prerelease                       # next iteration, npm (the default scope)
//   bun run prerelease --only npm,csharp     # pick ports
//   bun run prerelease --only all            # all four
//   bun run prerelease --iter 5              # pin the iteration number
//   bun run prerelease --base 0.25.0         # target a different in-development version
//   bun run prerelease --dry-run             # build + normalize + gate, publish nothing
//
// Registry address and token come from tools/prerelease/registry.env (gitignored) or the
// environment — never from anything committed. See docs/features/prerelease.md.
//
// ── the version scheme ────────────────────────────────────────────────────────────────
// ONE canonical internal string:  <base>-rc.<iteration>   e.g. 0.24.0-rc.3
// normalized per ecosystem in exactly one place (`V` below):
//
//   npm    0.24.0-rc.3     SemVer2, verbatim
//   NuGet  0.24.0-rc.3     SemVer2, verbatim
//   PyPI   0.24.0rc3       PEP 440 canonical form
//   Maven  7.24.0-rc.3     same minor.patch on the historical major 7
//
// The iteration counter — not a commit sha — is the collision breaker, because npm STRIPS
// SemVer build metadata: `0.24.0-rc.1+aaa` and `0.24.0-rc.1+bbb` compare EQUAL, so the
// second publish is refused as a duplicate. The sha still travels where it is useful: the
// C# packages carry it in AssemblyInformationalVersion via Source Link, which identifies a
// build without participating in resolution.
//
// `-rc.N` was chosen over `-SNAPSHOT` for Maven so all four ports read the same. A mutable
// version is worse than inconvenient: with a lockfile and a warm client cache, re-pushing
// the same version serves the consumer STALE BYTES with no error and no warning.
//
// ── the safety model ──────────────────────────────────────────────────────────────────
// The registry may be on a private network, so "it is only bound to loopback" is NOT the
// guarantee. These are:
//
//   1. The publish target must equal the CONFIGURED registry (or be loopback). Asserted
//      before anything runs, as an equality test — not a hostname pattern.
//   2. An independent deny-list of the public registries. Two checks that fail differently
//      beat one check trusted twice.
//   3. For npm, `bun publish --dry-run` is PARSED and its reported registry compared to the
//      expected one. bun ignores `npm_config_userconfig`; during this design's own
//      validation it silently fell back to the user-level ~/.npmrc and published a
//      pre-release to the PUBLIC registry. bun is not taken at its word anywhere here.
//   4. HOME is redirected to a scratch dir holding only the private-registry .npmrc, so a
//      fall-back has no credential to publish with even if it happens.
//   5. Maven is deployed with an explicit -DaltDeploymentRepository and never -Prelease —
//      this repo declares distributionManagement ONLY inside the `release` profile, so a
//      bare `mvn deploy` has no target at all.
//   6. Version declarations are edited in place and ALWAYS restored on exit; the script
//      refuses to start if any of them is already dirty.
import { execSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const has = (n) => argv.includes(`--${n}`);

const DRY = has("dry-run");
const ROOT = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
const SCRATCH = join(process.env.TMPDIR || "/tmp", "mo-prerelease");

const ok = (m) => console.log(`\x1b[32m✓\x1b[0m ${m}`);
const info = (m) => console.log(`  ${m}`);
const die = (m) => { console.error(`\x1b[31m✗ ${m}\x1b[0m`); process.exit(1); };
const sh = (cmd, o = {}) => execSync(cmd, { encoding: "utf8", cwd: ROOT, stdio: "pipe", ...o });

// ── registry config: environment first, then the gitignored env file ──────────────────
const envFile = join(ROOT, "tools/prerelease/registry.env");
const fileEnv = existsSync(envFile)
  ? Object.fromEntries(readFileSync(envFile, "utf8").split("\n")
      .filter((l) => l.trim() && !l.trim().startsWith("#") && l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]))
  : {};
const cfg = (k) => process.env[k] || fileEnv[k];

// The registry HOST is public information and is committed as the default so a consumer
// needs no configuration to resolve pre-releases. The OWNER and the TOKEN are not: the
// token is a credential, and the owner is an account name this public repository does not
// name. Both come from registry.env or the environment.
const DEFAULT_REGISTRY = "https://gitea.mealing.com";
const BASE = (cfg("MO_REGISTRY_BASE") || DEFAULT_REGISTRY).replace(/\/$/, "");
const OWNER = cfg("MO_REGISTRY_OWNER");
const TOKEN = cfg("MO_REGISTRY_TOKEN");
if (!OWNER || !TOKEN)
  die(`publishing needs MO_REGISTRY_OWNER and MO_REGISTRY_TOKEN (reads are anonymous, writes are not) —\n` +
      `  set them in the environment, or create ${envFile} from tools/prerelease/registry.env.example`);

// GATE 1 + 2 — the target must be the configured registry, and must not be a public one.
const PUBLIC_HOSTS = [
  "registry.npmjs.org", "registry.yarnpkg.com",
  "pypi.org", "upload.pypi.org", "files.pythonhosted.org", "test.pypi.org",
  "api.nuget.org", "www.nuget.org",
  "central.sonatype.com", "repo1.maven.org", "repo.maven.apache.org",
  "oss.sonatype.org", "s01.oss.sonatype.org",
];
const expectedHost = new URL(BASE).host;
const assertTarget = (url, what) => {
  const u = new URL(url);
  if (PUBLIC_HOSTS.includes(u.hostname))
    die(`refusing to publish ${what}: ${u.hostname} is a PUBLIC registry`);
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(u.hostname);
  if (u.host !== expectedHost && !loopback)
    die(`refusing to publish ${what}: ${u.host} is neither the configured registry (${expectedHost}) nor loopback`);
  return url;
};
assertTarget(BASE, "registry base");

const NPM_REG   = assertTarget(`${BASE}/api/packages/${OWNER}/npm/`, "npm");
const PYPI_URL  = assertTarget(`${BASE}/api/packages/${OWNER}/pypi`, "pypi");
const NUGET_SRC = assertTarget(`${BASE}/api/packages/${OWNER}/nuget/index.json`, "nuget");
const MAVEN_URL = assertTarget(`${BASE}/api/packages/${OWNER}/maven`, "maven");

// ── version scheme ────────────────────────────────────────────────────────────────────
const cliPkg = JSON.parse(readFileSync(join(ROOT, "server/typescript/packages/cli/package.json"), "utf8"));
const RELEASED = cliPkg.version;
const BASEVER = flag("base", (() => {
  const [maj, min] = RELEASED.split(".").map(Number);
  return `${maj}.${min + 1}.0`;
})());
if (!/^\d+\.\d+\.\d+$/.test(BASEVER)) die(`--base must be a plain x.y.z, got ${BASEVER}`);

// The lockstep package names, needed before the iteration number is chosen.
const LOCKSTEP = sh("ls -d server/typescript/packages/*/ client/web/packages/*/").trim().split("\n")
  .map((d) => d.replace(/\/$/, ""))
  .map((dir) => ({ dir, pkg: JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8")) }))
  .filter(({ pkg }) => !pkg.private && pkg.version === RELEASED);

const ITER_RE = new RegExp(`^\\d+\\.${BASEVER.split(".").slice(1).join("\\.")}(?:-rc\\.|rc)(\\d+)$`);

// Iteration: explicit, else 1 + the highest already taken — across ALL FOUR ecosystems on
// the pre-release registry, so `--only npm` today and `--only csharp` tomorrow cannot
// collide (a used number is a hard 409 on every one of them).
const usedIters = () => {
  try {
    const list = JSON.parse(sh(`curl -fsS --max-time 10 -u "${OWNER}:${TOKEN}" "${BASE}/api/v1/packages/${OWNER}?limit=1000"`));
    return list.map((p) => (p.version.match(ITER_RE) || [])[1]).filter(Boolean).map(Number);
  } catch { return []; }
};

// ...and across PUBLIC npm as well. A version published there is permanent — unpublish is
// refused outright once anything depends on it, and deprecation does not free the number.
// `@metaobjectsdev/metadata@0.24.0-rc.1` is burned exactly that way. Reusing a burned
// number privately costs nothing today and guarantees a failure the day that iteration is
// promoted to a public RC, so the counter skips it here instead of failing there.
const burnedPublicIters = async () => {
  const results = await Promise.all(LOCKSTEP.map(async ({ pkg }) => {
    try {
      const r = await fetch(`https://registry.npmjs.org/${pkg.name.replace("/", "%2f")}`,
        { headers: { accept: "application/vnd.npm.install-v1+json" }, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) return [];
      const doc = await r.json();
      return Object.keys(doc.versions || {}).map((v) => (v.match(ITER_RE) || [])[1]).filter(Boolean).map(Number);
    } catch { return null; }   // offline: fail OPEN, the release preflight is the backstop
  }));
  if (results.some((r) => r === null))
    console.warn(`\x1b[33m! could not reach public npm — the iteration number may reuse one that is already burned there\x1b[0m`);
  return results.filter(Boolean).flat();
};

const explicitIter = flag("iter", null);
const burned = await burnedPublicIters();
const ITER = Number(explicitIter ?? (() => {
  const taken = [...usedIters(), ...burned];
  return taken.length ? Math.max(...taken) + 1 : 1;
})());
if (!Number.isInteger(ITER) || ITER < 1) die(`--iter must be a positive integer, got ${ITER}`);
if (explicitIter && burned.includes(ITER))
  console.warn(`\x1b[33m! ${BASEVER}-rc.${ITER} is already published on PUBLIC npm for at least one package.\n` +
               `  Publishing it privately is fine, but that number can never be used for a public RC.\x1b[0m`);

const CANON = `${BASEVER}-rc.${ITER}`;
const MAVEN_MAJOR = 7;
// The ONE place per-ecosystem normalization lives.
const V = {
  npm:   CANON,
  nuget: CANON,
  pypi:  `${BASEVER}rc${ITER}`,
  maven: `${MAVEN_MAJOR}.${BASEVER.split(".").slice(1).join(".")}-rc.${ITER}`,
};

const ALL = ["npm", "python", "csharp", "java"];
const onlyArg = flag("only", "npm");
const ONLY = onlyArg === "all" ? ALL : onlyArg.split(",").map((s) => s.trim());
const unknown = ONLY.filter((p) => !ALL.includes(p));
if (unknown.length) die(`--only expects ${ALL.join("|")}|all, got '${unknown.join(",")}'`);
const wants = (p) => ONLY.includes(p);

console.log(`\n── pre-release ${CANON}${DRY ? "  (DRY RUN)" : ""} → ${expectedHost} ──\n`);
info(`released: ${RELEASED}   base: ${BASEVER}   iteration: ${ITER}`);
info(`npm ${V.npm}  ·  pypi ${V.pypi}  ·  nuget ${V.nuget}  ·  maven ${V.maven}`);
info(`ports: ${ONLY.join(", ")}\n`);
ok(`publish target verified: ${expectedHost} (configured registry; not a public one)`);

// ── GATE 6 — version-bearing files must be clean, so restore is unambiguous ────────────
const VERSION_FILES = [
  "server/typescript/packages/*/package.json", "client/web/packages/*/package.json",
  "server/java/**/pom.xml", "server/python/pyproject.toml", "server/csharp/Directory.Build.props",
  "bun.lock",
];
const dirty = sh(`git status --porcelain -- ${VERSION_FILES.map((f) => `'${f}'`).join(" ")}`).trim();
if (dirty) die(`version-bearing files are dirty — commit or stash first:\n${dirty}`);
ok("version-bearing files clean");

// Only the files this run actually wrote are reverted — never whole trees, or a maintainer's
// unrelated unstaged WIP anywhere under them would be silently destroyed on exit (even on a
// clean --dry-run). GATE 6 guarantees each of these was clean before the run, so restoring
// from the index is unambiguous.
let restored = false;
const touched = [];
const touch = (...files) => touched.push(...files);
const restore = () => {
  if (restored) return; restored = true;
  if (!touched.length) return;
  try { sh(`git checkout -- ${touched.map((f) => `'${f}'`).join(" ")}`); } catch {}
};
process.on("exit", restore);
process.on("SIGINT", () => { restore(); process.exit(130); });

const scratch = (name) => { const d = join(SCRATCH, name); rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }); return d; };
// Kept between runs (so Maven does not re-download the world every time) and deliberately
// NOT the user's ~/.m2: a pre-release must never land in the local repository that ordinary
// builds resolve from, or an unrelated `mvn` picks it up with no way to tell.
const keptScratch = (name) => { const d = join(SCRATCH, name); mkdirSync(d, { recursive: true }); return d; };

// ── npm ───────────────────────────────────────────────────────────────────────────────
if (wants("npm")) {
  const set = [];
  for (const { dir, pkg } of LOCKSTEP) {   // same lockstep rule as scripts/release.mjs
    const p = { ...pkg, version: V.npm };
    const f = join(dir, "package.json");
    writeFileSync(join(ROOT, f), JSON.stringify(p, null, 2) + "\n");
    touch(f);
    set.push({ dir, short: p.name.replace("@metaobjectsdev/", "") });
  }
  if (!set.length) die("no packages matched the lockstep set");
  ok(`npm lockstep set: ${set.length} packages → ${V.npm}`);

  sh("rm -f bun.lock && bun install");                  // re-pins workspace:* to V.npm
  touch("bun.lock");
  sh("bun run clean && bun run build");
  ok("relocked + clean rebuild");

  const p = scratch("pack");
  sh(`cd server/typescript/packages/cli && bun pm pack --destination ${p}`);
  const pj = JSON.parse(sh(`tar -xzOf ${p}/*.tgz package/package.json`));
  const bad = Object.entries(pj.dependencies || {}).filter(([k, v]) => k.startsWith("@metaobjectsdev/") && v !== V.npm);
  if (bad.length) die(`packed cli pins stale sibling deps: ${JSON.stringify(bad)}`);
  ok(`packed deps pinned to ${V.npm}`);

  const home = scratch("npmhome");
  writeFileSync(join(home, ".npmrc"),
    `@metaobjectsdev:registry=${NPM_REG}\n${NPM_REG.replace(/^https?:/, "")}:_authToken=${TOKEN}\n`);

  const TIERS = ["metadata", "render", "codegen-ts", "runtime-ts", "migrate-ts", "sdk", "docs-site",
                 "runtime-web", "codegen-ts-react", "codegen-ts-tanstack", "react", "tanstack", "cli", "ai-runtime"];
  const ordered = [...set].sort((a, b) => TIERS.indexOf(a.short) - TIERS.indexOf(b.short));

  // GATE 3 — ask bun where it would actually publish, and believe only that.
  const probe = execFileSync("bun", ["publish", "--dry-run"],
    { cwd: join(ROOT, ordered[0].dir), env: { ...process.env, HOME: home }, encoding: "utf8" });
  const seen = (probe.match(/^Registry:\s*(\S+)/m) || [])[1];
  if (seen !== NPM_REG) die(`bun would publish to ${seen}, not ${NPM_REG} — aborting`);
  ok(`bun publish target verified by dry-run: ${seen}`);

  if (!DRY) for (const pkg of ordered) {
    execFileSync("bun", ["publish", "--tag", "prerelease"],
      { cwd: join(ROOT, pkg.dir), env: { ...process.env, HOME: home }, stdio: "pipe" });
    info(`published ${pkg.short}@${V.npm}`);
  }
  ok(DRY ? "npm: dry run, nothing published" : `npm: ${ordered.length} packages @ ${V.npm} (dist-tag prerelease)`);
}

// ── python ────────────────────────────────────────────────────────────────────────────
if (wants("python")) {
  const f = "server/python/pyproject.toml";
  writeFileSync(join(ROOT, f), readFileSync(join(ROOT, f), "utf8").replace(/^version = ".*"$/m, `version = "${V.pypi}"`));
  touch(f);
  const dist = scratch("pydist");
  sh(`cd server/python && uv build --out-dir ${dist}`);
  ok(`python built ${V.pypi}`);
  if (!DRY) {
    sh(`cd server/python && uv publish --publish-url "${PYPI_URL}" --username "${OWNER}" --password "${TOKEN}" ${dist}/*`);
    ok(`python: metaobjects ${V.pypi} → ${expectedHost}`);
  } else ok("python: dry run, nothing published");
}

// ── csharp ────────────────────────────────────────────────────────────────────────────
if (wants("csharp")) {
  // No file edit needed — dotnet takes the version on the command line.
  const out = scratch("nupkg");
  const projs = ["MetaObjects/MetaObjects", "MetaObjects.Render/MetaObjects.Render",
                 "MetaObjects.Codegen/MetaObjects.Codegen", "MetaObjects.Cli/MetaObjects.Cli"];
  for (const p of projs) sh(`cd server/csharp && dotnet pack ${p}.csproj -c Release -o ${out} -p:Version=${V.nuget} --nologo -v q`);
  ok(`csharp packed ${V.nuget} (4 packages)`);
  if (!DRY) {
    sh(`dotnet nuget push "${out}/*.nupkg" --source "${NUGET_SRC}" --api-key "${TOKEN}"`);
    ok(`csharp: 4 packages @ ${V.nuget} → ${expectedHost}`);
  } else ok("csharp: dry run, nothing published");
}

// ── java / kotlin ─────────────────────────────────────────────────────────────────────
if (wants("java")) {
  const javaReleased = readFileSync(join(ROOT, "server/java/pom.xml"), "utf8").match(/<version>([^<]+)<\/version>/)[1];
  // Tree-wide sed, NOT `mvn versions:set` — versions:set walks only the reactor and
  // silently skips the two reactor-EXCLUDED integration-test modules, whose parent
  // version then lags (see scripts/check-pom-versions.sh, docs/RELEASING.md).
  const poms = sh(`grep -rl '${javaReleased}' --include=pom.xml server/java`).trim().split("\n").filter(Boolean);
  sh(`sed -i 's/${javaReleased.replace(/\./g, "\\.")}/${V.maven}/g' ${poms.map((f) => `'${f}'`).join(" ")}`);
  touch(...poms);
  sh("scripts/check-pom-versions.sh");
  ok(`java poms → ${V.maven}`);
  const settings = join(scratch("m2"), "settings.xml");
  writeFileSync(settings,
    `<settings xmlns="http://maven.apache.org/SETTINGS/1.0.0"><servers><server>` +
    `<id>mo-prerelease</id><username>${OWNER}</username><password>${TOKEN}</password>` +
    `</server></servers></settings>\n`);
  // `package` for a dry run, not `install`: a dry run must not write artifacts anywhere.
  const goal = DRY ? "package" : "deploy";
  const repo = keptScratch("m2repo");
  sh(`cd server/java && mvn -B -s ${settings} -Dmaven.repo.local=${repo} ${goal} -DskipTests` +
     ` -DaltDeploymentRepository="mo-prerelease::${MAVEN_URL}"`,
     { stdio: "inherit" });
  ok(DRY ? "java: dry run (install only)" : `java: reactor @ ${V.maven} → ${expectedHost}`);
}

restore();
console.log(`\n\x1b[32m\x1b[1m✅ ${CANON} is on the pre-release registry.\x1b[0m`);
console.log(`   link a consumer: tools/prerelease/prerelease-link.sh link --project <dir> --version ${CANON}`);
console.log(`   consumer guide:  docs/features/prerelease.md\n`);
