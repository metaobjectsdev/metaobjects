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
//
// A refusal names what was tried and the fix. All are `ERR_DEPENDENCY_UNRESOLVED`
// (the package, the interpreter or the directory could not be found); a
// directory that exists but holds no manifest is the manifest read's
// `ERR_DEPENDENCY_MANIFEST_INVALID`, not this module's.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { codeSource, ParseError } from "@metaobjectsdev/metadata";
import { dependencyName, type DependencySpec } from "@metaobjectsdev/sdk";

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
  if (result.error === "missing" || result.error === "import") {
    unresolved(
      name,
      `the Python package "${module}" is not installed in ${used} (from ${interp.from})` +
        (result.error === "import" && result.detail !== undefined ? ` — ${result.detail}` : "") +
        `. Install the distribution that provides it into that environment (for example ` +
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
  return resolvePython(configDir, name, spec.python, spec.dir, env);
}
