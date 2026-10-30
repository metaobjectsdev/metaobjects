// FR-023 DESIGN §2.1 — `meta deps sync` / `check` from an INSTALLED package:
// the `npm` transport (a temp `node_modules`), the `python` transport (a temp
// import path, a `.venv`, `$VIRTUAL_ENV`, `$METAOBJECTS_PYTHON`, and one real
// virtualenv). Nothing touches a network or a package manager: each test lays
// out on disk what an install would leave there.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { METAMODEL_VERSION } from "@metaobjectsdev/metadata";
import { sha256Integrity } from "@metaobjectsdev/sdk";
import { run } from "../src/index.js";
import { packageVersionWarning } from "../src/lib/dependency-sync.js";
import { METAOBJECTS_PYTHON_ENV, resolveTransport } from "../src/lib/dependency-transports.js";

const DEP = "acme-common";
const ARTIFACT = "acme-common.metaobjects.json";
const NODES = ["acme::common::Address", "acme::common::Audited", "acme::common::Customer"];
const CORPUS = resolve(import.meta.dirname, "../../../../../fixtures/dependency-conformance/artifacts");
const V1 = readFileSync(join(CORPUS, "acme-common-v1.json"));
const WIDENED = readFileSync(join(CORPUS, "acme-common-v1-widened.json"));
const PYTHON = process.platform === "win32" ? "python" : "python3";
const hasPython = spawnSync(PYTHON, ["--version"]).status === 0;

const APP = JSON.stringify({
  "metadata.root": {
    package: "app",
    children: [
      {
        "object.entity": {
          name: "Order",
          children: [
            { "source.rdb": { "@table": "orders" } },
            { "field.long": { name: "id" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
    ],
  },
});

/** What a publisher's `sharedModelFile()` output looks like inside its package. */
function publish(dir: string, version: string, artifact: Buffer = V1): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ARTIFACT), artifact);
  writeFileSync(
    join(dir, "metaobjects.pkg.json"),
    JSON.stringify({
      schema_version: 1,
      name: DEP,
      version,
      metamodelVersion: METAMODEL_VERSION,
      artifact: ARTIFACT,
      integrity: sha256Integrity(artifact),
      packages: ["acme::common"],
      nodes: NODES,
    }),
  );
}

const roots: string[] = [];
afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

function consumer(dependency: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "deps-pkg-")));
  roots.push(root);
  mkdirSync(join(root, "metaobjects"), { recursive: true });
  writeFileSync(join(root, "metaobjects", "meta.app.json"), APP);
  mkdirSync(join(root, ".metaobjects"), { recursive: true });
  writeFileSync(
    join(root, ".metaobjects", "config.json"),
    JSON.stringify({ schema_version: 1, sources: [], dependencies: [{ name: DEP, ...dependency }] }),
  );
  return root;
}

function npmInstall(root: string, version: string, opts: { manifestVersion?: string; artifact?: Buffer } = {}): void {
  const pkg = join(root, "node_modules", "@acme", "common-model");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@acme/common-model", version, files: ["metaobjects"] }));
  publish(join(pkg, "metaobjects"), opts.manifestVersion ?? version, opts.artifact);
}

function lockOf(root: string): { dependencies: Record<string, Record<string, unknown>> } {
  return JSON.parse(readFileSync(join(root, ".metaobjects", "deps.lock.json"), "utf8"));
}

let out: string[];
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = [METAOBJECTS_PYTHON_ENV, "VIRTUAL_ENV", "PYTHONPATH"];
let origLog: typeof console.log;
let origErr: typeof console.error;
beforeEach(() => {
  out = [];
  origLog = console.log;
  origErr = console.error;
  console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  console.log = origLog;
  console.error = origErr;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const sync = (root: string): Promise<number> => run(["deps", "sync", "--format", "text", "--cwd", root]);
const check = (root: string): Promise<number> => run(["deps", "check", "--format", "text", "--cwd", root]);

describe("meta deps sync — the npm transport", () => {
  test("syncs an installed package's shared model and records the transport verbatim", async () => {
    const root = consumer({ npm: "@acme/common-model", dir: "metaobjects" });
    npmInstall(root, "1.0.0");

    expect(await sync(root)).toBe(0);
    expect(readFileSync(join(root, ".metaobjects", "deps", DEP, ARTIFACT))).toEqual(V1);
    const entry = lockOf(root).dependencies[DEP]!;
    expect(entry.resolvedFrom).toEqual({ npm: "@acme/common-model", dir: "metaobjects" });
    expect(entry.version).toBe("1.0.0");
    expect(JSON.stringify(lockOf(root))).not.toContain(root);
  });

  test("a newer installed release is drift to check, and sync takes it", async () => {
    const root = consumer({ npm: "@acme/common-model", dir: "metaobjects" });
    npmInstall(root, "1.0.0");
    expect(await sync(root)).toBe(0);

    npmInstall(root, "1.1.0", { artifact: WIDENED });
    out = [];
    expect(await check(root)).toBe(1);
    expect(out.join("\n")).toContain("drifted");

    out = [];
    expect(await sync(root)).toBe(0);
    expect(out.join("\n")).toContain("synced acme-common 1.0.0→1.1.0");
    expect(lockOf(root).dependencies[DEP]!.version).toBe("1.1.0");
    out = [];
    expect(await check(root)).toBe(0);
  });

  test("an installed version that differs from the manifest's is warned about", async () => {
    const root = consumer({ npm: "@acme/common-model", dir: "metaobjects" });
    npmInstall(root, "1.2.0", { manifestVersion: "1.1.0" });
    expect(await sync(root)).toBe(0);
    const printed = out.join("\n");
    expect(printed).toContain("is 1.2.0, but its shared-model manifest records 1.1.0");
    expect(lockOf(root).dependencies[DEP]!.version).toBe("1.1.0");
  });

  test("an installed package with no manifest at dir names the publisher fix", async () => {
    const root = consumer({ npm: "@acme/common-model", dir: "metaobjects" });
    const pkg = join(root, "node_modules", "@acme", "common-model");
    mkdirSync(join(pkg, "metaobjects"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@acme/common-model", version: "1.0.0" }));
    expect(await sync(root)).toBe(1);
    const printed = out.join("\n");
    expect(printed).toContain('package.json "files"');
  });
});

/** A Python package laid out on an import path; optionally with dist-info so
 *  `importlib.metadata` can report its distribution version. */
function pyInstall(site: string, version: string, opts: { distVersion?: string } = {}): void {
  const pkg = join(site, "acme_common");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "__init__.py"), "");
  publish(join(pkg, "metaobjects"), version);
  if (opts.distVersion !== undefined) {
    const info = join(site, `acme_common-${opts.distVersion}.dist-info`);
    mkdirSync(info, { recursive: true });
    writeFileSync(join(info, "METADATA"), `Metadata-Version: 2.1\nName: acme-common\nVersion: ${opts.distVersion}\n`);
    writeFileSync(join(info, "top_level.txt"), "acme_common\n");
  }
}

describe.skipIf(!hasPython)("meta deps sync — the python transport", () => {
  test("syncs from the interpreter on PATH, prints it, and keeps it out of the lock", async () => {
    const root = consumer({ python: "acme_common", dir: "metaobjects" });
    pyInstall(join(root, "site"), "1.0.0");
    process.env.PYTHONPATH = join(root, "site");

    expect(await sync(root)).toBe(0);
    expect(out.join("\n")).toMatch(/synced acme-common \(new\)→1\.0\.0 .* — python: .* \(from PATH\)/);
    const lock = lockOf(root);
    expect(lock.dependencies[DEP]!.resolvedFrom).toEqual({ python: "acme_common", dir: "metaobjects" });
    expect(JSON.stringify(lock)).not.toContain("python3");
    expect(JSON.stringify(lock)).not.toContain(root);
    out = [];
    expect(await check(root)).toBe(0);
  });

  test("reads the installed distribution's version and warns when the manifest disagrees", async () => {
    const root = consumer({ python: "acme_common", dir: "metaobjects" });
    pyInstall(join(root, "site"), "1.0.0", { distVersion: "1.3.0" });
    process.env.PYTHONPATH = join(root, "site");
    const resolved = resolveTransport(root, { name: DEP, python: "acme_common", dir: "metaobjects" });
    expect(resolved.packageVersion).toBe("1.3.0");

    expect(await sync(root)).toBe(0);
    expect(out.join("\n")).toContain('Python package "acme_common" is 1.3.0, but its shared-model manifest records 1.0.0');
  });

  test("not installed: refuses and names the pip command", async () => {
    const root = consumer({ python: "acme_common", dir: "metaobjects" });
    expect(await sync(root)).toBe(1);
    const printed = out.join("\n");
    expect(printed).toContain("pip install acme-common");
  });

  test("a missing interpreter is refused by name", async () => {
    const root = consumer({ python: "acme_common", dir: "metaobjects" });
    process.env[METAOBJECTS_PYTHON_ENV] = join(root, "no-such-python");
    expect(await sync(root)).toBe(1);
    expect(out.join("\n")).toContain(`no Python interpreter at ${join(root, "no-such-python")}`);
  });

  test("the interpreter ladder: $METAOBJECTS_PYTHON, then $VIRTUAL_ENV, then ./.venv, then PATH", () => {
    const root = consumer({ python: "acme_common", dir: "metaobjects" });
    const site = join(root, "site");
    pyInstall(site, "1.0.0");
    const real = spawnSync(PYTHON, ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim();
    const fakeVenv = (dir: string): string => {
      mkdirSync(join(dir, "bin"), { recursive: true });
      symlinkSync(real, join(dir, "bin", "python"));
      return dir;
    };
    fakeVenv(join(root, ".venv"));
    const active = fakeVenv(join(root, "active-venv"));
    const spec = { name: DEP, python: "acme_common", dir: "metaobjects" } as const;
    const base = { ...process.env, PYTHONPATH: site };

    expect(resolveTransport(root, spec, base).note).toContain("(from .venv)");
    expect(resolveTransport(root, spec, { ...base, VIRTUAL_ENV: active }).note).toContain("(from $VIRTUAL_ENV)");
    expect(
      resolveTransport(root, spec, { ...base, VIRTUAL_ENV: active, [METAOBJECTS_PYTHON_ENV]: real }).note,
    ).toContain(`(from $${METAOBJECTS_PYTHON_ENV})`);
    rmSync(join(root, ".venv"), { recursive: true });
    expect(resolveTransport(root, spec, base).note).toContain("(from PATH)");
  });

  test("a $VIRTUAL_ENV with no interpreter is refused, not skipped for a working ./.venv", () => {
    const root = consumer({ python: "acme_common", dir: "metaobjects" });
    const site = join(root, "site");
    pyInstall(site, "1.0.0");
    const real = spawnSync(PYTHON, ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim();
    mkdirSync(join(root, ".venv", "bin"), { recursive: true });
    symlinkSync(real, join(root, ".venv", "bin", "python"));
    const empty = join(root, "empty-venv");
    mkdirSync(empty);
    const spec = { name: DEP, python: "acme_common", dir: "metaobjects" } as const;
    const base = { ...process.env, PYTHONPATH: site };
    expect(resolveTransport(root, spec, base).note).toContain("(from .venv)");

    expect(() => resolveTransport(root, spec, { ...base, VIRTUAL_ENV: empty })).toThrow(
      expect.objectContaining({ code: "ERR_DEPENDENCY_UNRESOLVED", message: expect.stringContaining("has no python interpreter") }),
    );
  });

  test("a dotted name whose parent package is not installed is 'not installed', with the pip hint", async () => {
    const root = consumer({ python: "acme.model", dir: "metaobjects" });
    process.env.PYTHONPATH = join(root, "site");

    expect(await sync(root)).toBe(1);
    const printed = out.join("\n");
    expect(printed).toContain('the Python package "acme.model" is not installed');
    expect(printed).toContain("pip install acme");
    expect(printed).not.toContain("importing the parent package");
  });

  test("a parent package that fails to import is reported as such, without a pip install hint", async () => {
    const root = consumer({ python: "acme.model", dir: "metaobjects" });
    const site = join(root, "site");
    mkdirSync(join(site, "acme", "model"), { recursive: true });
    writeFileSync(join(site, "acme", "__init__.py"), "import acme_missing_optional_dependency\n");
    writeFileSync(join(site, "acme", "model", "__init__.py"), "");
    process.env.PYTHONPATH = site;

    expect(await sync(root)).toBe(1);
    const printed = out.join("\n");
    expect(printed).toContain('importing the parent package of "acme.model"');
    expect(printed).toContain("ModuleNotFoundError");
    expect(printed).not.toContain("pip install");
    expect(printed).not.toContain("is not installed");
  });

  test("a PEP 440-equivalent manifest version does not warn", async () => {
    const root = consumer({ python: "acme_common", dir: "metaobjects" });
    pyInstall(join(root, "site"), "1.0.0-rc.1", { distVersion: "1.0.0rc1" });
    process.env.PYTHONPATH = join(root, "site");

    expect(await sync(root)).toBe(0);
    expect(out.join("\n")).not.toContain("shared-model manifest records");
  });

  test("a package installed into a real virtualenv resolves through $VIRTUAL_ENV", async () => {
    const root = consumer({ python: "acme_common", dir: "metaobjects" });
    const venv = join(root, "venv");
    const made = spawnSync(PYTHON, ["-m", "venv", "--without-pip", venv], { encoding: "utf8" });
    if (made.status !== 0) {
      console.warn(`skipping: ${PYTHON} -m venv failed: ${made.stderr}`);
      return;
    }
    const exe = process.platform === "win32" ? join(venv, "Scripts", "python.exe") : join(venv, "bin", "python");
    const purelib = spawnSync(exe, ["-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"], {
      encoding: "utf8",
    }).stdout.trim();
    pyInstall(purelib, "1.0.0", { distVersion: "1.0.0" });
    process.env.VIRTUAL_ENV = venv;

    expect(await sync(root)).toBe(0);
    expect(out.join("\n")).toContain("(from $VIRTUAL_ENV)");
    expect(readFileSync(join(root, ".metaobjects", "deps", DEP, ARTIFACT))).toEqual(V1);
  });
});

// Oracle: PEP 440 "Normalization" (packaging.python.org, version specifiers) —
// each pair spells the same version, as `importlib.metadata` reports it.
describe("the installed-vs-manifest version warning", () => {
  const py = { name: DEP, python: "acme_common" } as const;
  const npm = { name: DEP, npm: "@acme/common-model" } as const;

  test.each([
    ["1.0.0rc1", "1.0.0-rc.1"],
    ["1.0.0rc1", "1.0.0.RC1"],
    ["1.0.0rc1.post2", "1.0.0-rc1-post2"],
    ["1.0.0+abc", "1.0.0+abc"],
    ["1.0.post1", "1.0-1"],
    ["1.0.0+ubuntu.1", "1.0.0+Ubuntu-1"],
    ["1!2.0", "1!2.0"],
    ["2.0", "0!2.0"],
    ["1.0a0", "1.0-alpha"],
    ["1.0b2", "1.0.beta.2"],
    ["1.0rc2", "1.0c2"],
    ["1.0rc1", "1.0-preview1"],
    ["1.0rc1", "1.0pre1"],
    ["1.0.post1", "1.0-post1"],
    ["1.0.post0", "1.0post"],
    ["1.0.post2", "1.0-rev2"],
    ["1.0.dev0", "1.0-dev"],
    ["1.0.dev3", "1.0_dev3"],
    ["1.0.0", "v1.0.0"],
    // PEP 440 ignores trailing zero release segments: 1.0 is 1.0.0.
    ["1.0", "1.0.0"],
    ["1.0.0", "1.0"],
    ["2", "2.0.0"],
    ["1.0.0rc1", "1.0rc1"],
    ["1!1.0", "1!1.0.0"],
  ])("python: installed %s matches manifest %s", (installed, manifest) => {
    expect(packageVersionWarning(DEP, py, installed, manifest)).toBeUndefined();
  });

  test("python: a genuinely different version still warns", () => {
    expect(packageVersionWarning(DEP, py, "1.0.0rc2", "1.0.0-rc.1")).toContain("records 1.0.0-rc.1");
    expect(packageVersionWarning(DEP, py, "1.0.0rc1", "1.0.0rc2")).toContain("records 1.0.0rc2");
    expect(packageVersionWarning(DEP, py, "1.0.0rc1.post2", "1.0.0rc1")).toContain("records 1.0.0rc1");
    expect(packageVersionWarning(DEP, py, "1.0.1", "1.0")).toContain("records 1.0");
    expect(packageVersionWarning(DEP, py, "1.10", "1.1")).toContain("records 1.1");
    expect(packageVersionWarning(DEP, py, "1.1.0", "1.0.0")).toContain("is 1.1.0");
  });

  test("npm: the comparison stays exact", () => {
    expect(packageVersionWarning(DEP, npm, "1.0.0", "1.0.0")).toBeUndefined();
    expect(packageVersionWarning(DEP, npm, "1.0.0-rc.1", "1.0.0rc1")).toContain("is 1.0.0-rc.1");
  });
});
