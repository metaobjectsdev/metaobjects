#!/usr/bin/env bun
/**
 * Gate — core and the independent packs stay separable (ADR-0069, "The boundary").
 *
 * Core is released from `main` at any moment, with pack work in flight, only while
 * these hold. Each is a property a refactor could quietly break, so each is checked:
 *
 *  1. Core never refers to a pack. No manifest, import or build file outside packs/
 *     names a pack's coordinate (`@metaobjectsdev/pack-*`, `com.metaobjects.packs`,
 *     `metaobjects-pack-*`, `metaobjects_pack_*`, `MetaObjects.Packs.*`) or reaches into
 *     packs/ by path. The one sanctioned mention is the root workspace glob, which is
 *     how a pack builds against core's working tree; core's own build and typecheck
 *     scripts are scoped so that glob never pulls a pack into them.
 *  2. No independent pack is in the default bundle. No pack's provider id appears in
 *     core's source or shared fixtures, and no type a pack pins appears in
 *     fixtures/registry-conformance/expected-registry.json, so a pack can never move
 *     `metamodelVersion`.
 *  3. Core's release tooling does not enumerate packs/. Today that is true because the
 *     publish set and its two gates list two workspace directories by name; this gate
 *     plants a public pack package in a scratch copy of the release manifests and
 *     asserts none of them sees it, so a later "every package.json" refactor fails here.
 *
 * The fourth rule of the ADR — a pack-only change selects only the packs lane — is a
 * row in scripts/ci-lane-map.txt, asserted by scripts/test-ci-lane-selection.sh.
 *
 * scripts/ is release and CI tooling, not core product, so it may know about packs and
 * is not scanned. Markdown is not scanned: the ADR and the policy pages describe packs.
 *
 * Usage: bun scripts/check-pack-boundary.ts [--root <dir>] [--skip-release-scan]
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PACK_VOCABULARY, REPO_ROOT, listPackDirs, packsById } from "./lib/packs.js";

/** Top-level trees that hold core product, its shared corpora and its spec. */
export const CORE_TREES = [
  "server", "client", "examples", "library", "spec", "fixtures", "templates",
  "agent-context", "agent-context-shipped", "tools", "metaobjects",
] as const;

/** Files a build, an installer or a loader reads. Prose (.md) is deliberately absent. */
const SCANNED = /(\.(ts|tsx|mts|cts|js|mjs|cjs|json|jsonc|ya?ml|java|kt|kts|cs|csproj|props|targets|py|rs|toml|xml|gradle|sh)|(^|\/)(package\.json|pom\.xml|Cargo\.toml|pyproject\.toml))$/;

const PACK_COORDINATE = /@metaobjectsdev\/pack-[a-z0-9]|com\.metaobjects\.packs|metaobjects-pack-[a-z0-9]|metaobjects_pack_[a-z0-9]|MetaObjects\.Packs\./;
const INTO_PACKS = /(^|[^A-Za-z0-9_.-])(\.\.\/)+packs\//;

/** The root workspace entry that lets a pack join the Bun workspace (ADR-0069). */
export const PACK_WORKSPACE_GLOB = "packs/*/typescript";

const SKIP_DIRS = new Set(["node_modules", ".git", ".stryker-tmp", "target", "obj", ".venv", "__pycache__"]);

function walk(root: string, rel: string, out: string[]): void {
  const abs = join(root, rel);
  if (!existsSync(abs)) return;
  if (statSync(abs).isFile()) {
    out.push(rel);
    return;
  }
  for (const n of readdirSync(abs)) {
    if (SKIP_DIRS.has(n)) continue;
    walk(root, rel === "" ? n : `${rel}/${n}`, out);
  }
}

/** Core's files: tracked and untracked-but-not-ignored when `root` is a git work tree, else a walk. */
export function coreFiles(root: string): string[] {
  const git = spawnSync("git", ["-C", root, "ls-files", "-co", "--exclude-standard", "--", ...CORE_TREES], { encoding: "utf8", maxBuffer: 1 << 28 });
  const files: string[] = [];
  if (git.status === 0 && existsSync(join(root, ".git"))) {
    files.push(...git.stdout.split("\n").filter((f) => f !== ""));
  } else {
    for (const t of CORE_TREES) walk(root, t, files);
  }
  return files.filter((f) => SCANNED.test(f) && existsSync(join(root, f)));
}

/** Rule 1 and the source half of rule 2. */
export function scanCore(root: string): string[] {
  const out: string[] = [];
  const ids = [...packsById(root).keys()];
  for (const rel of coreFiles(root)) {
    const text = readFileSync(join(root, rel), "utf8");
    if (!PACK_COORDINATE.test(text) && !INTO_PACKS.test(text) && !ids.some((id) => text.includes(id))) continue;
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      const at = `${rel}:${i + 1}`;
      if (PACK_COORDINATE.test(line)) out.push(`${at}: core names a pack coordinate — core may never depend on a pack`);
      else if (INTO_PACKS.test(line)) out.push(`${at}: core reaches into packs/ by path — core may never depend on a pack`);
      for (const id of ids) {
        if (new RegExp(`(^|[^A-Za-z0-9_-])${id}([^A-Za-z0-9_-]|$)`).test(line)) {
          out.push(`${at}: names the independent pack provider "${id}" — an independent pack is never in the default bundle`);
        }
      }
    });
  }
  // The root manifest may mention packs/ exactly once: the workspace glob.
  const rootPkgPath = join(root, "package.json");
  if (existsSync(rootPkgPath)) {
    const pkg = JSON.parse(readFileSync(rootPkgPath, "utf8")) as { workspaces?: string[]; scripts?: Record<string, string> };
    for (const ws of pkg.workspaces ?? []) {
      if (ws.startsWith("packs/") && ws !== PACK_WORKSPACE_GLOB) out.push(`package.json: workspace "${ws}" — packs join only as "${PACK_WORKSPACE_GLOB}"`);
    }
    for (const name of ["build", "typecheck"]) {
      const cmd = pkg.scripts?.[name] ?? "";
      if (/--filter\s+['"]?\*['"]?(\s|$)/.test(cmd) || /pack-/.test(cmd)) {
        out.push(`package.json: the "${name}" script must name core's workspace directories, not '*' (which takes in every pack)`);
      }
    }
  }
  return out;
}

/** The registry half of rule 2: a type a pack pins is never in the bundle's manifest. */
export function scanRegistry(root: string): string[] {
  const out: string[] = [];
  const registryPath = join(root, "fixtures/registry-conformance/expected-registry.json");
  const providersPath = join(root, "fixtures/registry-conformance/providers.json");
  const bundleTypes = existsSync(registryPath)
    ? new Set((JSON.parse(readFileSync(registryPath, "utf8")) as { types: { type: string; subType: string }[] }).types.map((t) => `${t.type}.${t.subType}`))
    : new Set<string>();
  const bundleIds = existsSync(providersPath)
    ? new Set(Object.keys((JSON.parse(readFileSync(providersPath, "utf8")) as { providers: Record<string, unknown> }).providers))
    : new Set<string>();
  for (const [id, name] of packsById(root)) {
    if (bundleIds.has(id)) out.push(`packs/${name}: provider id "${id}" is a bundled provider (fixtures/registry-conformance/providers.json)`);
    const pin = join(root, "packs", name, PACK_VOCABULARY);
    if (!existsSync(pin)) continue;
    const types = (JSON.parse(readFileSync(pin, "utf8")) as { types?: { type: string; subType: string }[] }).types ?? [];
    for (const t of types) {
      if (bundleTypes.has(`${t.type}.${t.subType}`)) {
        out.push(`packs/${name}/${PACK_VOCABULARY}: ${t.type}.${t.subType} is also in expected-registry.json — a pack type may not enter the bundle`);
      }
    }
  }
  return out;
}

/** Copy only what core's release gates read into a scratch root. */
function releaseSkeleton(root: string, scratch: string): void {
  const copy = (rel: string): void => {
    const from = join(root, rel);
    if (!existsSync(from)) return;
    mkdirSync(dirname(join(scratch, rel)), { recursive: true });
    cpSync(from, join(scratch, rel));
  };
  for (const s of ["publish-set.mjs", "check-publish-intent.sh", "check-no-prerelease-versions.sh"]) copy(`scripts/${s}`);
  for (const ws of ["server/typescript/packages", "client/web/packages"]) {
    const dir = join(root, ws);
    if (!existsSync(dir)) continue;
    for (const n of readdirSync(dir)) copy(`${ws}/${n}/package.json`);
  }
  for (const f of ["server/python/pyproject.toml", "server/csharp/Directory.Build.props", "server/java/pom.xml", "package.json"]) copy(f);
}

/** Rule 3: plant a public pack package next to core's manifests and assert no release gate sees it. */
export function scanReleaseTooling(root: string): string[] {
  const out: string[] = [];
  if (!existsSync(join(root, "scripts/publish-set.mjs"))) return out;
  const scratch = mkdtempSync(join(process.env.DEV_SCRATCH ?? tmpdir(), "mo-pack-boundary-"));
  try {
    releaseSkeleton(root, scratch);
    const cli = JSON.parse(readFileSync(join(scratch, "server/typescript/packages/cli/package.json"), "utf8")) as { version: string };
    // Two planted packages, each the worst case for one gate: one public at core's
    // lockstep version (a publish set that swept packs/ would ship it), one public and
    // off the line at a pre-release version (publish-intent and the pre-release guard
    // would refuse it if they read packs/).
    const plant = (name: string, version: string): void => {
      const dir = join(scratch, "packs", name, "typescript");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `@metaobjectsdev/pack-${name}`, version }, null, 2));
    };
    plant("boundary-lockstep", cli.version);
    plant("boundary-offline", "0.1.0-rc.1");

    const set = spawnSync("node", ["--input-type=module", "-e",
      `import { publishSet } from ${JSON.stringify(join(scratch, "scripts/publish-set.mjs"))};` +
      `console.log(JSON.stringify(publishSet({ root: ${JSON.stringify(scratch)} }).set.map((p) => p.pkg.name)));`], { encoding: "utf8" });
    if (set.status !== 0) out.push(`scripts/publish-set.mjs: could not derive the publish set in a scratch root: ${set.stderr.trim()}`);
    else if (/pack-/.test(set.stdout)) out.push(`scripts/publish-set.mjs: the publish set took in a package under packs/ (${set.stdout.trim()})`);

    for (const gate of ["check-publish-intent.sh", "check-no-prerelease-versions.sh"]) {
      const r = spawnSync("bash", [join(scratch, "scripts", gate)], { encoding: "utf8" });
      if (r.status !== 0) out.push(`scripts/${gate}: fails once a pack package exists under packs/ — it must not enumerate packs/\n${(r.stdout + r.stderr).trim()}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return out;
}

export function checkPackBoundary(root: string = REPO_ROOT, opts: { releaseScan?: boolean } = {}): string[] {
  return [...scanCore(root), ...scanRegistry(root), ...(opts.releaseScan === false ? [] : scanReleaseTooling(root))];
}

if (import.meta.main) {
  const i = process.argv.indexOf("--root");
  const root = i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : REPO_ROOT;
  const problems = checkPackBoundary(root, { releaseScan: !process.argv.includes("--skip-release-scan") });
  if (problems.length > 0) {
    console.error(`pack boundary: ${problems.length} problem(s) (ADR-0069)`);
    for (const p of problems) console.error(`  ✖ ${p}`);
    process.exit(1);
  }
  console.log(`pack boundary: OK (${listPackDirs(root).length} pack(s); core names none, the bundle holds none, the release tooling sees none)`);
}
