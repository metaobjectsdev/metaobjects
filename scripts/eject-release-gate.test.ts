// The eject release gate (scripts/eject-release-gate.mjs): a final version is refused while
// the eject contract's pending list has entries. Both release scripts and the four publish
// workflows call it, so what it refuses and what it lets through are pinned here. The wiring
// is pinned by running it: `release.mjs` and each workflow's gate step below,
// `finish-release.mjs` in scripts/finish-release.test.ts (gate 0). An unwired gate refuses
// nothing.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { EJECT_MANIFEST, ejectReleaseRefusal, ejectReleaseRefusalAt } from "./eject-release-gate.mjs";

const REPO = resolve(import.meta.dirname, "..");
const ENTRY = { generator: "entity", port: "typescript", assertion: "depth", gap: 3 };
const manifest = (pending: (typeof ENTRY)[]) => ({ eject: { pending } });

const created: string[] = [];
afterAll(() => { for (const d of created) rmSync(d, { recursive: true, force: true }); });

/** A throwaway repository root holding the gate, any other `scripts`, and one shared file. */
function repoWith(body: string | undefined, scripts: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), "eject-release-gate-"));
  created.push(root);
  mkdirSync(join(root, "scripts"), { recursive: true });
  for (const script of ["eject-release-gate.mjs", ...scripts]) {
    writeFileSync(join(root, "scripts", script), readFileSync(join(REPO, "scripts", script)));
  }
  if (body !== undefined) put(root, EJECT_MANIFEST, body);
  return root;
}

function put(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

describe("eject release gate — what it refuses", () => {
  test("a final version with entries left, naming how many per port", () => {
    const refusal = ejectReleaseRefusal("1.1.0", manifest([ENTRY, { ...ENTRY, port: "java" }, ENTRY]));
    expect(refusal).toContain("1.1.0 is a final release");
    expect(refusal).toContain("3 entries are left");
    expect(refusal).toContain("java 1, typescript 2");
  });

  test("a final version with one entry left", () => {
    expect(ejectReleaseRefusal("1.1.0", manifest([ENTRY]))).toContain("1 entry is left");
  });

  test("a shared file it cannot read the list from", () => {
    for (const broken of [{}, { eject: {} }, { eject: { pending: "none" } }, { eject: { pending: null } }]) {
      expect(ejectReleaseRefusal("1.1.0", broken as never)).toContain("no readable eject.pending");
    }
  });

  test("a missing or malformed shared file", () => {
    expect(ejectReleaseRefusalAt("1.1.0", repoWith(undefined))).toContain("is missing");
    expect(ejectReleaseRefusalAt("1.1.0", repoWith("{ not json"))).toContain("is not valid JSON");
  });
});

describe("eject release gate — what it lets through", () => {
  test("a final version once the list is empty", () => {
    expect(ejectReleaseRefusal("1.1.0", manifest([]))).toBeNull();
  });

  // PyPI spells a prerelease without a hyphen (PEP 440): `rc3`, `a1`, `b2`.
  test("a prerelease in any registry's spelling, whatever the list says", () => {
    for (const version of ["1.1.0-rc.1", "1.1.0-rc.3", "2.0.0-beta.1", "1.1.0rc3", "1.1.0a1", "1.1.0b2"]) {
      expect(ejectReleaseRefusal(version, manifest([ENTRY]))).toBeNull();
      expect(ejectReleaseRefusalAt(version, repoWith(undefined))).toBeNull();
    }
  });
});

describe("eject release gate — the command and its wiring", () => {
  const node = (cwd: string, script: string, ...args: string[]) => {
    const r = spawnSync("node", [join(cwd, "scripts", script), ...args], { encoding: "utf8", cwd });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const run = (root: string, ...args: string[]) => node(root, "eject-release-gate.mjs", ...args);

  test("exits 1 with the reason for a refused version, 0 otherwise, 2 for a bad argument", () => {
    const blocked = repoWith(JSON.stringify(manifest([ENTRY])));
    expect(run(blocked, "1.1.0").code).toBe(1);
    expect(run(blocked, "1.1.0").out).toContain("1 entry is left");
    for (const candidate of ["1.1.0-rc.3", "1.1.0rc3", "1.1.0a1", "1.1.0b2"]) expect(run(blocked, candidate).code).toBe(0);
    expect(run(repoWith(JSON.stringify(manifest([]))), "1.1.0").code).toBe(0);
    expect(run(blocked).code).toBe(2);
    for (const bad of ["latest", "1.1.0rc", "1.1.0.post1"]) expect(run(blocked, bad).code).toBe(2);
  });

  test("refuses a final version when the script path goes through a symlink", () => {
    const blocked = repoWith(JSON.stringify(manifest([ENTRY])));
    const linked = join(repoWith(undefined), "linked");
    symlinkSync(blocked, linked, "dir");
    const refused = run(linked, "1.1.0");
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("1 entry is left");
  });

  // ADR-0034 Amendment 8 makes the gate the first preflight check of `release.mjs`. The
  // check after it is the branch check, so a fixture on another branch tells the two apart:
  // a refused version stops before "must be on main", and an allowed one reaches it.
  test("release.mjs asks the gate first in its preflight, and stops on a refusal", () => {
    const RELEASE_SCRIPTS = ["release.mjs", "publish-set.mjs", "maven-coordinate.mjs"];
    const onBranch = (pending: (typeof ENTRY)[]) => {
      const root = repoWith(JSON.stringify(manifest(pending)), RELEASE_SCRIPTS);
      const git = (...args: string[]) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
      git("init", "--quiet", "-b", "not-main");
      git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "core.hooksPath=/dev/null",
        "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "fixture");
      return root;
    };
    const release = (root: string, version: string) => node(root, "release.mjs", version, "--preflight-only");

    const blocked = onBranch([ENTRY]);
    const refused = release(blocked, "1.1.0");
    expect(refused.code).not.toBe(0);
    expect(refused.out).toContain("the eject contract does not hold yet");
    expect(refused.out).not.toContain("must be on main");

    for (const allowed of [release(blocked, "1.1.0-rc.1"), release(onBranch([]), "1.1.0")]) {
      expect(allowed.out).not.toContain("the eject contract does not hold yet");
      expect(allowed.out).toContain("must be on main (you are on not-main)");
    }
  });

  test("the shared file in this repository is one the gate can read", () => {
    const refusal = ejectReleaseRefusalAt("1.1.0", REPO);
    // Refused or not is the release branch's business; "cannot read it" is a defect here.
    if (refusal !== null) expect(refusal).not.toContain("no readable");
    expect(ejectReleaseRefusalAt("1.1.0-rc.1", REPO)).toBeNull();
  });
});

// A publish workflow runs on a tag push, which the repository's own checks cannot make. So
// the rule is held here (ADR-0034 Amendment 8): each workflow is parsed, its steps are
// walked in order, and its gate step is run as the shell it is against a throwaway
// repository whose committed version this test wrote.
describe("eject release gate — the publish workflows", () => {
  type Step = { uses?: string; run?: string; env?: Record<string, string> };
  type Workflow = { jobs: Record<string, { steps: Step[] }> };
  const WORKFLOWS = join(REPO, ".github/workflows");
  const VERSION_INPUT = "${{ github.event.inputs.version }}";

  /** Each publish workflow, the file its version is committed in, and that file with a given version. */
  const PUBLISHERS: { workflow: string; versionFile: string; final: string; candidate: string; committed: (v: string) => string }[] = [
    {
      workflow: "publish-npm.yml", versionFile: "server/typescript/packages/cli/package.json", final: "1.1.0", candidate: "1.1.0-rc.1",
      committed: (v) => `${JSON.stringify({ name: "@metaobjectsdev/cli", version: v }, null, 2)}\n`,
    },
    {
      workflow: "publish-python.yml", versionFile: "server/python/pyproject.toml", final: "1.1.0", candidate: "1.1.0rc1",
      committed: (v) => `[project]\nname = "metaobjects"\nversion = "${v}"\n\n[tool.other]\nversion = "9.9.9"\n`,
    },
    {
      workflow: "publish-java.yml", versionFile: "server/java/pom.xml", final: "8.1.0", candidate: "8.1.0-rc.1",
      committed: (v) => `<project>\n  <modelVersion>4.0.0</modelVersion>\n  <version>${v}</version>\n` +
        `  <dependencies>\n    <dependency>\n      <version>9.9.9</version>\n    </dependency>\n  </dependencies>\n</project>\n`,
    },
    {
      workflow: "publish-csharp.yml", versionFile: "server/csharp/Directory.Build.props", final: "1.1.0", candidate: "1.1.0-rc.1",
      committed: (v) => `<Project>\n  <PropertyGroup>\n    <Version>${v}</Version>\n  </PropertyGroup>\n</Project>\n`,
    },
  ];

  const stepsOf = (workflow: string): Step[][] =>
    Object.values((Bun.YAML.parse(readFileSync(join(WORKFLOWS, workflow), "utf8")) as Workflow).jobs).map((job) => job.steps);
  const isCheckout = (step: Step) => (step.uses ?? "").startsWith("actions/checkout@");
  const isGate = (step: Step) => (step.run ?? "").includes("scripts/eject-release-gate.mjs");
  const publishes = (step: Step) =>
    /\bbun publish\b|\bmvn\b.*\bdeploy\b|\bdotnet nuget push\b/.test(step.run ?? "") ||
    (step.uses ?? "").startsWith("pypa/gh-action-pypi-publish@");

  /** Run a workflow's gate step the way the runner does, in a repository holding `versionBody`. */
  function runGate(p: (typeof PUBLISHERS)[number], pending: (typeof ENTRY)[], versionBody: string, input = "") {
    const gate = stepsOf(p.workflow).flat().find(isGate);
    if (gate?.run === undefined) throw new Error(`${p.workflow} has no eject release gate step`);
    const root = repoWith(JSON.stringify(manifest(pending)));
    put(root, p.versionFile, versionBody);
    const env = Object.fromEntries(Object.entries(gate.env ?? {}).map(([k, v]) => [k, v.replace(VERSION_INPUT, input)]));
    const r = spawnSync("bash", ["-e", "-c", gate.run], { encoding: "utf8", cwd: root, env: { ...process.env, ...env } });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  }

  test("every publish workflow is listed here", () => {
    const found = readdirSync(WORKFLOWS).filter((f) => f.startsWith("publish-")).sort();
    expect(found).toEqual(PUBLISHERS.map((p) => p.workflow).sort());
  });

  for (const p of PUBLISHERS) {
    test(`${p.workflow} asks the gate after checkout and before its first publishing step`, () => {
      const publishing = stepsOf(p.workflow).filter((steps) => steps.some(publishes));
      expect(publishing.length).toBeGreaterThan(0);
      for (const steps of publishing) {
        const checkout = steps.findIndex(isCheckout);
        const gate = steps.findIndex(isGate);
        expect(checkout).toBeGreaterThan(-1);
        expect(gate).toBeGreaterThan(checkout);
        expect(gate).toBeLessThan(steps.findIndex(publishes));
      }
    });

    test(`${p.workflow} refuses the committed final version while an entry is left`, () => {
      const refused = runGate(p, [ENTRY], p.committed(p.final));
      expect(refused.code).toBe(1);
      expect(refused.out).toContain(`${p.final} is a final release`);
    });

    test(`${p.workflow} lets a committed release candidate through, and the version this repository commits`, () => {
      expect(runGate(p, [ENTRY], p.committed(p.candidate)).code).toBe(0);
      const real = runGate(p, [], readFileSync(join(REPO, p.versionFile), "utf8"));
      expect(real.out).toContain("may be released");
      expect(real.code).toBe(0);
    });
  }

  test("publish-csharp.yml gates the `version` input when one is given", () => {
    const csharp = PUBLISHERS.find((p) => p.workflow === "publish-csharp.yml")!;
    expect(runGate(csharp, [ENTRY], csharp.committed(csharp.final), "1.1.0-rc.1").code).toBe(0);
    const refused = runGate(csharp, [ENTRY], csharp.committed(csharp.candidate), "1.1.0");
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("1.1.0 is a final release");
  });
});
