#!/usr/bin/env bun
/**
 * Gate — every independent pack's `pack.json` is well formed and agrees with the
 * native manifest of each port that carries it (ADR-0069).
 *
 * `pack.json` is the pack's one statement about itself: its provider id, its version,
 * its stability, the metamodel and the other packs it needs, and which ports carry it.
 * An installer never reads it; npm, Maven, PyPI, NuGet and Cargo read their own files.
 * So the two can drift, and when they do the installer enforces the wrong range. This
 * gate fails the build on that drift instead.
 *
 * Checked for every directory under packs/:
 *  - pack.json parses and names `metaobjects-<dir>`, an X.Y.Z version, a stability word,
 *    a bounded metamodel range, packs that exist here, and at least one port.
 *  - a port directory exists exactly for each port pack.json lists.
 *  - README.md and CHANGELOG.md exist (a pack's changelog never goes in the root one).
 *  - each native manifest carries the coordinate the naming rule gives that port, the
 *    pack's version, and the core range pack.json states.
 *  - TypeScript, in full: a `private` flag that matches `publish`, core as a bounded
 *    peer range (never a dependency, so a project never gets a second copy of
 *    `@metaobjectsdev/metadata`), a `workspace:*` dev dependency to build against core's
 *    working tree, a `typecheck` script, and the pinned vocabulary the pack lane checks.
 *
 * Usage: bun scripts/check-pack-manifests.ts [--root <dir>]
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  PACK_MANIFEST,
  PACK_PORTS,
  PACK_STABILITIES,
  PACK_VOCABULARY,
  REPO_ROOT,
  expectedPackage,
  listPackDirs,
  packageMatches,
  packProviderId,
  packsById,
  type PackManifest,
  type PackPort,
} from "./lib/packs.js";

const NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const CORE_NPM = "@metaobjectsdev/metadata";

/**
 * A range is bounded when it states an upper limit: `<X` or `<=X` (npm, PyPI, Cargo), a
 * caret or tilde range (`^1.3.0`, `~1.3`, which npm and Cargo bound at the next major or
 * minor), PyPI's compatible release `~=1.3`, or a Maven/NuGet interval with a closed or
 * open upper end (`[1.3.0,2.0.0)`). An interval with no upper end (`[1.3.0,)`) is not.
 */
export function bounded(range: string): boolean {
  const r = range.trim();
  return /<=?\s*\d/.test(r) || /^(\^|~=?)\s*\d/.test(r) || /^[[(][^,]*,\s*[^\])\s]+[\])]$/.test(r);
}

function readText(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

type Problems = string[];

function checkTypeScript(name: string, m: PackManifest, dir: string, out: Problems): void {
  const entry = m.ports.typescript;
  if (entry === undefined) return;
  const where = `packs/${name}/typescript/package.json`;
  const raw = readText(join(dir, "package.json"));
  if (raw === undefined) {
    out.push(`${where}: missing`);
    return;
  }
  const pkg = JSON.parse(raw) as {
    name?: string;
    version?: string;
    private?: boolean;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  if (pkg.name !== entry.package) out.push(`${where}: name is "${pkg.name}", pack.json says "${entry.package}"`);
  if (pkg.version !== m.version) out.push(`${where}: version is "${pkg.version}", pack.json says "${m.version}"`);
  if ((pkg.private === true) !== !entry.publish) {
    out.push(`${where}: "private" must be ${!entry.publish} while pack.json says publish: ${entry.publish}`);
  }
  const peer = pkg.peerDependencies?.[CORE_NPM];
  if (peer !== entry.core) out.push(`${where}: peerDependencies["${CORE_NPM}"] is "${peer}", pack.json says "${entry.core}"`);
  if (pkg.devDependencies?.[CORE_NPM] !== "workspace:*") {
    out.push(`${where}: devDependencies["${CORE_NPM}"] must be "workspace:*" so the pack builds against core's working tree`);
  }
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    if (dep.startsWith("@metaobjectsdev/") && !dep.startsWith("@metaobjectsdev/pack-")) {
      out.push(`${where}: "${dep}" is a dependency; a core package must be a peer dependency (one copy per project)`);
    }
  }
  if (pkg.scripts?.typecheck === undefined) out.push(`${where}: needs a "typecheck" script (the packs lane runs it)`);
  if (!existsSync(join(dir, "..", PACK_VOCABULARY))) {
    out.push(`packs/${name}/${PACK_VOCABULARY}: missing — run bun scripts/pack-vocabulary.ts ${name} --write`);
  }
}

/** The first value of `<tag>` at the top level of a pom, ignoring <parent> and <dependencies>. */
function pomTag(pom: string, tag: string): string | undefined {
  const top = pom.replace(/<parent>[\s\S]*?<\/parent>/, "").replace(/<dependencies>[\s\S]*?<\/dependencies>/g, "");
  return new RegExp(`<${tag}>\\s*([^<]+?)\\s*</${tag}>`).exec(top)?.[1];
}

function checkMaven(port: "java" | "kotlin", name: string, m: PackManifest, dir: string, out: Problems): void {
  const entry = m.ports[port];
  if (entry === undefined) return;
  const where = `packs/${name}/${port}/pom.xml`;
  const pom = readText(join(dir, "pom.xml"));
  if (pom === undefined) {
    out.push(`${where}: missing`);
    return;
  }
  const coord = `${pomTag(pom, "groupId")}:${pomTag(pom, "artifactId")}`;
  if (coord !== entry.package) out.push(`${where}: coordinate is "${coord}", pack.json says "${entry.package}"`);
  if (pomTag(pom, "version") !== m.version) out.push(`${where}: version is "${pomTag(pom, "version")}", pack.json says "${m.version}"`);
  // Maven cannot express a range an installer enforces the way npm does: the pom depends
  // on core's floor with `provided` scope and pack.json carries the range.
  if (!/<scope>\s*provided\s*<\/scope>/.test(pom)) out.push(`${where}: core must be a provided-scope dependency`);
}

function checkPython(name: string, m: PackManifest, dir: string, out: Problems): void {
  const entry = m.ports.python;
  if (entry === undefined) return;
  const where = `packs/${name}/python/pyproject.toml`;
  const toml = readText(join(dir, "pyproject.toml"));
  if (toml === undefined) {
    out.push(`${where}: missing`);
    return;
  }
  const field = (k: string): string | undefined => new RegExp(`^${k}\\s*=\\s*"([^"]*)"`, "m").exec(toml)?.[1];
  if (field("name") !== entry.package) out.push(`${where}: name is "${field("name")}", pack.json says "${entry.package}"`);
  if (field("version") !== m.version) out.push(`${where}: version is "${field("version")}", pack.json says "${m.version}"`);
  if (!toml.includes(`"metaobjects${entry.core}"`)) out.push(`${where}: dependencies must list "metaobjects${entry.core}"`);
}

function checkCSharp(name: string, m: PackManifest, dir: string, out: Problems): void {
  const entry = m.ports.csharp;
  if (entry === undefined) return;
  const projects = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".csproj")) : [];
  if (projects.length !== 1) {
    out.push(`packs/${name}/csharp: needs exactly one .csproj (found ${projects.length})`);
    return;
  }
  const where = `packs/${name}/csharp/${projects[0]}`;
  const proj = readFileSync(join(dir, projects[0]!), "utf8");
  const tag = (t: string): string | undefined => new RegExp(`<${t}>\\s*([^<]+?)\\s*</${t}>`).exec(proj)?.[1];
  if (tag("PackageId") !== entry.package) out.push(`${where}: PackageId is "${tag("PackageId")}", pack.json says "${entry.package}"`);
  if (tag("Version") !== m.version) out.push(`${where}: Version is "${tag("Version")}", pack.json says "${m.version}"`);
  const ref = /<PackageReference\s+Include="MetaObjects"\s+Version="([^"]+)"/.exec(proj)?.[1];
  if (ref !== entry.core) out.push(`${where}: the MetaObjects reference is "${ref}", pack.json says "${entry.core}"`);
}

function checkRust(name: string, m: PackManifest, dir: string, out: Problems): void {
  const entry = m.ports.rust;
  if (entry === undefined) return;
  const where = `packs/${name}/rust/Cargo.toml`;
  const toml = readText(join(dir, "Cargo.toml"));
  if (toml === undefined) {
    out.push(`${where}: missing`);
    return;
  }
  const field = (k: string): string | undefined => new RegExp(`^${k}\\s*=\\s*"([^"]*)"`, "m").exec(toml)?.[1];
  if (field("name") !== entry.package) out.push(`${where}: name is "${field("name")}", pack.json says "${entry.package}"`);
  if (field("version") !== m.version) out.push(`${where}: version is "${field("version")}", pack.json says "${m.version}"`);
  if (!new RegExp(`^metaobjects\\s*=.*"${entry.core.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "m").test(toml)) {
    out.push(`${where}: the metaobjects dependency must be "${entry.core}"`);
  }
}

/** Every problem with every pack under `<root>/packs/`; empty when all agree. */
export function checkPackManifests(root: string = REPO_ROOT): string[] {
  const out: Problems = [];
  const ids = packsById(root);
  for (const name of listPackDirs(root)) {
    const base = join(root, "packs", name);
    const where = `packs/${name}/${PACK_MANIFEST}`;
    if (!NAME.test(name)) out.push(`packs/${name}: a pack directory name is lower-case kebab-case`);
    let m: PackManifest;
    try {
      m = JSON.parse(readFileSync(join(base, PACK_MANIFEST), "utf8")) as PackManifest;
    } catch (e) {
      out.push(`${where}: ${existsSync(join(base, PACK_MANIFEST)) ? `does not parse (${(e as Error).message})` : "missing"}`);
      continue;
    }
    if (m.id !== packProviderId(name)) out.push(`${where}: id is "${m.id}", must be "${packProviderId(name)}"`);
    if (typeof m.version !== "string" || !SEMVER.test(m.version)) out.push(`${where}: version "${m.version}" is not X.Y.Z`);
    if (!(PACK_STABILITIES as readonly string[]).includes(m.stability)) {
      out.push(`${where}: stability "${m.stability}" is not one of ${PACK_STABILITIES.join(", ")}`);
    }
    const metamodel = m.requires?.metamodel;
    if (typeof metamodel !== "string" || !bounded(metamodel)) {
      out.push(`${where}: requires.metamodel "${metamodel}" must be a range with an upper bound`);
    }
    for (const [dep, range] of Object.entries(m.requires?.packs ?? {})) {
      if (!ids.has(dep)) out.push(`${where}: requires pack "${dep}", which is not in packs/`);
      if (!bounded(range)) out.push(`${where}: the range on "${dep}" ("${range}") needs an upper bound`);
    }
    for (const file of ["README.md", "CHANGELOG.md"]) {
      if (!existsSync(join(base, file))) out.push(`packs/${name}/${file}: missing`);
    }
    const listed = Object.keys(m.ports ?? {});
    if (listed.length === 0) out.push(`${where}: ports lists no port`);
    for (const port of listed) {
      if (!(PACK_PORTS as readonly string[]).includes(port)) out.push(`${where}: unknown port "${port}"`);
    }
    for (const port of PACK_PORTS) {
      const entry = m.ports?.[port];
      const present = existsSync(join(base, port));
      if (entry === undefined) {
        if (present) out.push(`packs/${name}/${port}: the directory exists but pack.json does not list the port`);
        continue;
      }
      if (!present) out.push(`packs/${name}/${port}: pack.json lists the port but the directory is missing`);
      if (!packageMatches(port as PackPort, name, entry.package)) {
        out.push(`${where}: ports.${port}.package is "${entry.package}", the naming rule gives "${expectedPackage(port as PackPort, name)}"`);
      }
      if (typeof entry.core !== "string" || !bounded(entry.core)) {
        out.push(`${where}: ports.${port}.core "${entry.core}" must be a range with an upper bound`);
      }
      if (typeof entry.publish !== "boolean") out.push(`${where}: ports.${port}.publish must be true or false`);
      if (!present) continue;
      const dir = join(base, port);
      if (port === "typescript") checkTypeScript(name, m, dir, out);
      else if (port === "java" || port === "kotlin") checkMaven(port, name, m, dir, out);
      else if (port === "python") checkPython(name, m, dir, out);
      else if (port === "csharp") checkCSharp(name, m, dir, out);
      else checkRust(name, m, dir, out);
    }
  }
  return out;
}

if (import.meta.main) {
  const i = process.argv.indexOf("--root");
  const root = i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : REPO_ROOT;
  const packs = listPackDirs(root);
  const problems = checkPackManifests(root);
  if (problems.length > 0) {
    console.error(`pack manifests: ${problems.length} problem(s)`);
    for (const p of problems) console.error(`  ✖ ${p}`);
    process.exit(1);
  }
  console.log(`pack manifests: OK (${packs.length} pack${packs.length === 1 ? "" : "s"})`);
}
