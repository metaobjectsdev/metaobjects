// server/typescript/packages/cli/src/lib/dependency-transports.ts
//
// FR-023 DESIGN §2.1 "Transports": a transport answers one question at sync
// time — which directory holds the publisher's `metaobjects.pkg.json`? Node
// `meta deps sync` / `check` are the only callers; every port then loads the
// committed snapshot, never the installed package.
//
//   path   — the directory, relative to the declaring config's directory.
//   npm    — the installed package's root (found in `node_modules` up the tree
//            from the consumer's config directory, as Node does), then `dir`.
//   python — the installed package's directory, as the consumer's own Python
//            interpreter's `importlib.util.find_spec` reports it, then `dir`.
//   maven  — a `groupId:artifactId` at `version` in the LOCAL Maven repository
//            (`~/.m2/repository` layout, the location overridable): the jar's
//            `dir` resource (default `metaobjects`), unpacked to a temp directory.
//   nuget  — a package id at `version` in the NuGet global packages folder
//            (`$NUGET_PACKAGES` or `~/.nuget/packages`): its `dir` content
//            (default `metaobjects`).
//
// `maven` and `nuget` never download. A package missing from the local cache is
// refused with the command that fetches it (`mvn dependency:get`, `dotnet restore`).
//
// A refusal names what was tried and the fix. All are `ERR_DEPENDENCY_UNRESOLVED`
// (the package, the interpreter or the directory could not be found); a
// directory that exists but holds no manifest is the manifest read's
// `ERR_DEPENDENCY_MANIFEST_INVALID`, not this module's.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { codeSource, ParseError } from "@metaobjectsdev/metadata";
import { dependencyName, type DependencySpec } from "@metaobjectsdev/sdk";
import { readZipEntries } from "./zip-read.js";

/** Where a transport found the publisher's manifest directory. */
export interface ResolvedTransport {
  /** Absolute directory expected to hold `metaobjects.pkg.json`. */
  readonly dir: string;
  /** The installed package's own version (npm `package.json` / the Python
   *  distribution's metadata), when the transport can read one. Compared with
   *  the manifest's `version` by the caller; never written to the lock. */
  readonly packageVersion?: string | undefined;
  /** How it was found, for the report — e.g. the Python interpreter used. */
  readonly note?: string | undefined;
}

/** The env keys the python transport reads (DESIGN §2.1 interpreter ladder). */
export const METAOBJECTS_PYTHON_ENV = "METAOBJECTS_PYTHON";
const VIRTUAL_ENV_ENV = "VIRTUAL_ENV";

/** Where a Maven jar / NuGet package carries the shared model, unless `dir` says otherwise. */
export const PACKAGED_MODEL_DIR = "metaobjects";

/** The env keys the maven and nuget transports read for an overridden cache. */
export const MAVEN_REPO_LOCAL_ENV = "MAVEN_REPO_LOCAL";
export const NUGET_PACKAGES_ENV = "NUGET_PACKAGES";

const MAVEN_COORDINATE = /^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$/;
const PACKAGE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const NUGET_ID = /^[A-Za-z0-9_.-]+$/;
const NPM_PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const PYTHON_MODULE_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const PYTHON_TIMEOUT_MS = 60_000;

function unresolved(name: string, detail: string): never {
  throw new ParseError(`dependency "${name}": ${detail}`, {
    code: "ERR_DEPENDENCY_UNRESOLVED",
    source: codeSource("resolveTransport"),
  });
}

function isDirectory(p: string): boolean {
  return existsSync(p) && statSync(p).isDirectory();
}

/** `dir` applied to a package root. Refuses an absolute `dir` or one that climbs
 *  out of the package: the artifact is part of what the package ships. */
function applyDir(name: string, kind: string, pkg: string, root: string, dir: string | undefined): string {
  if (dir === undefined) return root;
  const target = resolve(root, dir);
  const rel = relative(root, target);
  if (isAbsolute(dir) || rel === ".." || rel.startsWith(`..${sep}`)) {
    unresolved(name, `"dir": "${dir}" must be a path inside the ${kind} package "${pkg}" (relative, no "..")`);
  }
  if (!isDirectory(target)) {
    unresolved(
      name,
      `the ${kind} package "${pkg}" is installed at ${root}, but has no "${dir}" directory. ` +
        `Check "dir" in .metaobjects/config.json, or ask the publisher to ship the shared-model ` +
        `output in the package (${kind === "npm" ? `package.json "files"` : "package data"}).`,
    );
  }
  return target;
}

function readVersion(packageJson: string): string | undefined {
  try {
    const v = (JSON.parse(readFileSync(packageJson, "utf8")) as { version?: unknown }).version;
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The installed npm package's `package.json`, found the way Node's resolver
 * finds a package from the consumer's config directory: `node_modules/<pkg>` in
 * that directory, then in each parent (DESIGN §2.1). A nested, hoisted
 * (workspace) or pnpm-symlinked install all appear there. This deliberately does
 * not ask `require.resolve` for the package.json subpath: a package whose `exports` map does
 * not expose `./package.json` refuses that subpath, and a model-only package may
 * have no entry point to resolve and walk up from.
 */
function findNpmPackageJson(configDir: string, pkg: string): string | undefined {
  let dir = configDir;
  for (;;) {
    const candidate = join(dir, "node_modules", pkg, "package.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function resolveNpm(configDir: string, name: string, pkg: string, dir: string | undefined): ResolvedTransport {
  if (!NPM_PACKAGE_NAME.test(pkg)) {
    unresolved(name, `"npm": "${pkg}" is not an npm package name`);
  }
  const packageJson = findNpmPackageJson(configDir, pkg);
  if (packageJson === undefined) {
    unresolved(
      name,
      `the npm package "${pkg}" is not installed where ${configDir} can resolve it. ` +
        `Install it (\`npm install ${pkg}\`, or your package manager's equivalent), then re-run.`,
    );
  }
  const root = realpathSync(dirname(packageJson));
  return { dir: applyDir(name, "npm", pkg, root, dir), packageVersion: readVersion(packageJson) };
}

/** The interpreter ladder (DESIGN §2.1): `$METAOBJECTS_PYTHON` →
 *  `$VIRTUAL_ENV`'s python → `<configDir>/.venv`'s python → `python3`. An
 *  explicitly named interpreter that does not exist is refused, never skipped:
 *  falling through to another environment would read a different install. */
function pythonInterpreter(
  configDir: string,
  name: string,
  env: NodeJS.ProcessEnv,
): { readonly exe: string; readonly from: string } {
  const explicit = env[METAOBJECTS_PYTHON_ENV];
  if (explicit !== undefined && explicit !== "") return { exe: explicit, from: `$${METAOBJECTS_PYTHON_ENV}` };
  const venvPython = (venv: string): string | undefined =>
    [join(venv, "bin", "python"), join(venv, "Scripts", "python.exe")].find((p) => existsSync(p));
  const active = env[VIRTUAL_ENV_ENV];
  if (active !== undefined && active !== "") {
    const exe = venvPython(active);
    if (exe === undefined) {
      unresolved(
        name,
        `$${VIRTUAL_ENV_ENV} is ${active}, but it has no python interpreter. Re-create or ` +
          `deactivate that virtualenv, or point $${METAOBJECTS_PYTHON_ENV} at an interpreter.`,
      );
    }
    return { exe, from: `$${VIRTUAL_ENV_ENV}` };
  }
  const local = venvPython(join(configDir, ".venv"));
  if (local !== undefined) return { exe: local, from: ".venv" };
  return { exe: process.platform === "win32" ? "python" : "python3", from: "PATH" };
}

// Prints one JSON line. `find_spec` imports the parent packages of a dotted
// name, so this runs inside the consumer's own environment (DESIGN §11 risks).
const FIND_SPEC_SCRIPT = `
import importlib.util, json, sys
name = sys.argv[1]
out = {"executable": sys.executable}
try:
    spec = importlib.util.find_spec(name)
except ModuleNotFoundError as e:
    # A parent of a dotted name that is itself absent is "not installed"; any
    # other missing module was raised by a parent's own import.
    if e.name and (name == e.name or name.startswith(e.name + ".")):
        out["error"] = "missing"
    else:
        out["error"] = "import"
        out["detail"] = type(e).__name__ + ": " + str(e)
    spec = None
except Exception as e:
    out["error"] = "import"
    out["detail"] = type(e).__name__ + ": " + str(e)
    spec = None
if "error" not in out:
    if spec is None:
        out["error"] = "missing"
    elif not spec.submodule_search_locations:
        out["error"] = "module"
        out["detail"] = str(spec.origin)
    else:
        out["locations"] = list(spec.submodule_search_locations)
        try:
            import importlib.metadata as md
            dists = md.packages_distributions().get(name.split(".")[0], [])
            if len(set(dists)) == 1:
                out["version"] = md.version(dists[0])
        except Exception:
            pass
print(json.dumps(out))
`;

interface FindSpecResult {
  readonly executable?: string;
  readonly error?: "import" | "missing" | "module";
  readonly detail?: string;
  readonly locations?: readonly string[];
  readonly version?: string;
}

function resolvePython(
  configDir: string,
  name: string,
  module: string,
  dir: string | undefined,
  env: NodeJS.ProcessEnv,
): ResolvedTransport {
  if (!PYTHON_MODULE_NAME.test(module)) {
    unresolved(name, `"python": "${module}" is not a Python module name (dotted identifiers, e.g. acme_model)`);
  }
  const interp = pythonInterpreter(configDir, name, env);
  const run = spawnSync(interp.exe, ["-c", FIND_SPEC_SCRIPT, module], {
    cwd: configDir,
    env: { ...env, PYTHONDONTWRITEBYTECODE: "1" },
    encoding: "utf8",
    timeout: PYTHON_TIMEOUT_MS,
  });
  const tried = `${interp.exe} (from ${interp.from})`;
  if (run.error !== undefined) {
    const enoent = (run.error as NodeJS.ErrnoException).code === "ENOENT";
    unresolved(
      name,
      enoent
        ? `no Python interpreter at ${tried}. Install Python, activate the project's virtualenv, ` +
            `or point $${METAOBJECTS_PYTHON_ENV} at the interpreter that has "${module}" installed.`
        : `running ${tried} failed: ${run.error.message}`,
    );
  }
  let result: FindSpecResult;
  try {
    const lastLine = run.stdout.trim().split("\n").pop() ?? "";
    result = JSON.parse(lastLine) as FindSpecResult;
  } catch {
    unresolved(
      name,
      `${tried} exited ${run.status ?? "abnormally"} without reporting where "${module}" is` +
        (run.stderr.trim() !== "" ? `: ${run.stderr.trim().split("\n").pop()}` : ""),
    );
  }
  const used = result.executable ?? interp.exe;
  if (result.error === "import") {
    unresolved(
      name,
      `importing the parent package of "${module}" in ${used} (from ${interp.from}) raised ` +
        `${result.detail ?? "an error"}. Fix that environment so the import succeeds, then re-run.`,
    );
  }
  if (result.error === "missing") {
    unresolved(
      name,
      `the Python package "${module}" is not installed in ${used} (from ${interp.from}). Install the distribution that provides it into that environment (for example ` +
        `\`pip install ${module.split(".")[0]!.replace(/_/g, "-")}\`), or point ` +
        `$${METAOBJECTS_PYTHON_ENV} at the interpreter that has it.`,
    );
  }
  if (result.error === "module" || result.locations === undefined || result.locations.length === 0) {
    unresolved(
      name,
      `"${module}" is a module (${result.detail ?? "no directory"}), not a package directory — ` +
        `the shared-model files must ship as package data inside a package.`,
    );
  }
  // A namespace package can span several directories; take the first that holds `dir`.
  const root =
    result.locations.find((loc) => dir === undefined || isDirectory(resolve(loc, dir))) ?? result.locations[0]!;
  return {
    dir: applyDir(name, "python", module, root, dir),
    packageVersion: result.version,
    note: `python: ${used} (from ${interp.from})`,
  };
}

// ---------------------------------------------------------------------------
// maven / nuget — read a published package out of the machine's local cache.
// ---------------------------------------------------------------------------

function homeDir(env: NodeJS.ProcessEnv): string {
  const home = env.HOME ?? env.USERPROFILE;
  return home !== undefined && home !== "" ? home : homedir();
}

/** The directories a packaged model is unpacked into; removed when the process exits. */
const unpackedDirs: string[] = [];
let cleanupRegistered = false;

function newUnpackDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mo-dep-pkg-"));
  unpackedDirs.push(dir);
  if (!cleanupRegistered) {
    cleanupRegistered = true;
    process.once("exit", () => {
      for (const d of unpackedDirs) rmSync(d, { recursive: true, force: true });
    });
  }
  return dir;
}

/** `dir` for a packaged model: the default `metaobjects`, same rules as {@link applyDir}'s `dir`. */
function packagedDir(name: string, kind: string, dir: string | undefined): string {
  const chosen = dir ?? PACKAGED_MODEL_DIR;
  const normalized = chosen.split("\\").join("/").replace(/\/+$/, "");
  if (isAbsolute(chosen) || normalized === "" || normalized.split("/").includes("..")) {
    unresolved(name, `"dir": "${chosen}" must be a path inside the ${kind} package (relative, no "..")`);
  }
  return normalized;
}

/** Writes every entry of `zip` under `<dir>/` to a fresh temp directory (with `<dir>/` stripped);
 *  returns it, or `undefined` when the archive has nothing there. */
function unpackZipDir(zip: string, dir: string): string | undefined {
  const prefix = `${dir}/`;
  const entries = readZipEntries(zip, prefix);
  if (entries.length === 0) return undefined;
  const target = newUnpackDir();
  for (const entry of entries) {
    const dest = join(target, ...entry.name.slice(prefix.length).split("/"));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, entry.data);
  }
  return target;
}

function readZipOrRefuse(name: string, what: string, zip: string, dir: string): string {
  let unpacked: string | undefined;
  try {
    unpacked = unpackZipDir(zip, dir);
  } catch (err) {
    unresolved(name, `${what} (${zip}) could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (unpacked === undefined) {
    unresolved(
      name,
      `${what} (${zip}) has no "${dir}/" directory. Check "dir" in .metaobjects/config.json, or ask the ` +
        `publisher to ship the shared-model output (metaobjects.pkg.json and the artifact) under "${dir}/" in the package.`,
    );
  }
  return unpacked;
}

/** `-Dmaven.repo.local=<path>` out of a `MAVEN_ARGS` / `MAVEN_OPTS` style string. */
function repoLocalFromOptions(options: string | undefined): string | undefined {
  if (options === undefined) return undefined;
  const m = /(?:^|\s)-Dmaven\.repo\.local=(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(options);
  return m?.[1] ?? m?.[2] ?? m?.[3];
}

/** `<localRepository>` out of a Maven `settings.xml` (comments ignored); `${user.home}` / `${env.X}` expanded. */
function repoLocalFromSettings(file: string, home: string, env: NodeJS.ProcessEnv): string | undefined {
  if (!existsSync(file)) return undefined;
  const xml = readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->/g, "");
  const raw = /<localRepository>\s*([^<]*?)\s*<\/localRepository>/.exec(xml)?.[1];
  if (raw === undefined || raw === "") return undefined;
  return raw
    .replace(/\$\{user\.home\}/g, home)
    .replace(/\$\{env\.([^}]+)\}/g, (_, key: string) => env[key] ?? "");
}

/** The local Maven repository and how it was chosen — Maven's own ladder, with `$MAVEN_REPO_LOCAL`
 *  first: that, `-Dmaven.repo.local` in `$MAVEN_ARGS` / `$MAVEN_OPTS`, `<localRepository>` in
 *  `~/.m2/settings.xml`, then `~/.m2/repository`. */
export function mavenLocalRepository(env: NodeJS.ProcessEnv): { readonly dir: string; readonly from: string } {
  const home = homeDir(env);
  const explicit = env[MAVEN_REPO_LOCAL_ENV];
  if (explicit !== undefined && explicit !== "") return { dir: resolve(explicit), from: `$${MAVEN_REPO_LOCAL_ENV}` };
  for (const key of ["MAVEN_ARGS", "MAVEN_OPTS"]) {
    const fromOptions = repoLocalFromOptions(env[key]);
    if (fromOptions !== undefined) return { dir: resolve(fromOptions), from: `-Dmaven.repo.local in $${key}` };
  }
  const settings = join(home, ".m2", "settings.xml");
  const fromSettings = repoLocalFromSettings(settings, home, env);
  if (fromSettings !== undefined) return { dir: resolve(join(home, ".m2"), fromSettings), from: settings };
  return { dir: join(home, ".m2", "repository"), from: "the default ~/.m2/repository" };
}

function resolveMaven(
  name: string,
  coordinate: string,
  version: string,
  dir: string | undefined,
  env: NodeJS.ProcessEnv,
): ResolvedTransport {
  if (!MAVEN_COORDINATE.test(coordinate)) {
    unresolved(
      name,
      `"maven": "${coordinate}" is not a groupId:artifactId pair (for example com.acme:acme-model); ` +
        `the version goes in "version", not in this value`,
    );
  }
  if (!PACKAGE_VERSION.test(version)) unresolved(name, `"version": "${version}" is not a Maven version`);
  const inside = packagedDir(name, "Maven", dir);
  const [groupId, artifactId] = coordinate.split(":") as [string, string];
  const repo = mavenLocalRepository(env);
  const jar = join(repo.dir, ...groupId.split("."), artifactId, version, `${artifactId}-${version}.jar`);
  if (!existsSync(jar)) {
    unresolved(
      name,
      `the Maven artifact ${coordinate}:${version} is not in the local repository ${repo.dir} (${repo.from}); ` +
        `expected ${jar}. Fetch it with \`mvn dependency:get -Dartifact=${coordinate}:${version}\` ` +
        `(add -DremoteRepositories=<url> for a repository other than Central), then re-run. ` +
        `meta deps sync does not download.`,
    );
  }
  const unpacked = readZipOrRefuse(name, `the jar of ${coordinate}:${version}`, jar, inside);
  return { dir: unpacked, packageVersion: version, note: `maven: ${jar}` };
}

/** NuGet's normalized version (lower case; four-part `1.0.0.0` → `1.0.0`; `1.0` → `1.0.0`; the
 *  `+build` metadata dropped) — the form the global packages folder names its directories by. */
export function normalizeNuGetVersion(version: string): string {
  const lower = version.trim().toLowerCase().replace(/\+.*$/, "");
  const dash = lower.indexOf("-");
  const core = dash < 0 ? lower : lower.slice(0, dash);
  const pre = dash < 0 ? "" : lower.slice(dash);
  const parts = core.split(".");
  if (parts.length > 4 || !parts.every((p) => /^\d+$/.test(p))) return lower;
  const numbers = parts.map((p) => String(Number(p)));
  while (numbers.length < 3) numbers.push("0");
  if (numbers.length === 4 && numbers[3] === "0") numbers.pop();
  return numbers.join(".") + pre;
}

/** The NuGet global packages folder and how it was chosen: `$NUGET_PACKAGES`, else `~/.nuget/packages`. */
export function nugetPackagesFolder(env: NodeJS.ProcessEnv): { readonly dir: string; readonly from: string } {
  const explicit = env[NUGET_PACKAGES_ENV];
  if (explicit !== undefined && explicit !== "") return { dir: resolve(explicit), from: `$${NUGET_PACKAGES_ENV}` };
  return { dir: join(homeDir(env), ".nuget", "packages"), from: "the default ~/.nuget/packages" };
}

function resolveNuget(
  name: string,
  id: string,
  version: string,
  dir: string | undefined,
  env: NodeJS.ProcessEnv,
): ResolvedTransport {
  if (!NUGET_ID.test(id)) unresolved(name, `"nuget": "${id}" is not a NuGet package id`);
  if (!PACKAGE_VERSION.test(version)) unresolved(name, `"version": "${version}" is not a NuGet version`);
  const inside = packagedDir(name, "NuGet", dir);
  const cache = nugetPackagesFolder(env);
  const normalized = normalizeNuGetVersion(version);
  const folder = join(cache.dir, id.toLowerCase(), normalized);
  if (!isDirectory(folder)) {
    unresolved(
      name,
      `the NuGet package ${id} ${version} is not in the global packages folder ${cache.dir} (${cache.from}); ` +
        `expected ${folder}. Fetch it with \`dotnet restore\` in a project that references ${id} ${version} ` +
        `(or \`dotnet add package ${id} --version ${version}\`), then re-run. meta deps sync does not download.`,
    );
  }
  const extracted = join(folder, ...inside.split("/"));
  if (isDirectory(extracted)) return { dir: extracted, packageVersion: version };
  // A cache that kept only the archive: read the shared model out of it.
  const nupkg = join(folder, `${id.toLowerCase()}.${normalized}.nupkg`);
  if (existsSync(nupkg)) {
    const unpacked = readZipOrRefuse(name, `the package ${id} ${version}`, nupkg, inside);
    return { dir: unpacked, packageVersion: version, note: `nuget: ${nupkg}` };
  }
  unresolved(
    name,
    `the NuGet package ${id} ${version} is in the cache at ${folder}, but has no "${inside}" directory. ` +
      `Check "dir" in .metaobjects/config.json, or ask the publisher to pack the shared-model output ` +
      `(metaobjects.pkg.json and the artifact) under "${inside}/" in the package.`,
  );
}

/**
 * DESIGN §4.1 step 1 — resolve a dependency spec's transport to the directory
 * that should hold its `metaobjects.pkg.json`. Throws `ERR_DEPENDENCY_UNRESOLVED`
 * naming what was tried and the fix.
 */
export function resolveTransport(
  configDir: string,
  spec: DependencySpec,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedTransport {
  const name = dependencyName(spec);
  if ("path" in spec) {
    const dir = resolve(configDir, spec.path);
    if (!isDirectory(dir)) {
      unresolved(name, `the "path" transport resolved to ${dir}, but no directory exists there`);
    }
    return { dir };
  }
  if ("npm" in spec) return resolveNpm(configDir, name, spec.npm, spec.dir);
  if ("maven" in spec) return resolveMaven(name, spec.maven, spec.version, spec.dir, env);
  if ("nuget" in spec) return resolveNuget(name, spec.nuget, spec.version, spec.dir, env);
  return resolvePython(configDir, name, spec.python, spec.dir, env);
}
