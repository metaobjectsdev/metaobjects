// The eject release gate (scripts/eject-release-gate.mjs): a final version is refused while
// the eject contract's pending list has entries. Both release scripts call it, so what it
// refuses and what it lets through are pinned here. The wiring is pinned by running the
// scripts: `release.mjs` below, `finish-release.mjs` in scripts/finish-release.test.ts
// (gate 0). An unwired gate refuses nothing.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  if (body !== undefined) {
    mkdirSync(dirname(join(root, EJECT_MANIFEST)), { recursive: true });
    writeFileSync(join(root, EJECT_MANIFEST), body);
  }
  return root;
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

  test("a prerelease, whatever the list says", () => {
    for (const version of ["1.1.0-rc.1", "1.1.0-rc.3", "2.0.0-beta.1"]) {
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
    expect(run(blocked, "1.1.0-rc.3").code).toBe(0);
    expect(run(repoWith(JSON.stringify(manifest([]))), "1.1.0").code).toBe(0);
    expect(run(blocked).code).toBe(2);
    expect(run(blocked, "latest").code).toBe(2);
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
