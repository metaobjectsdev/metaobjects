// The eject release gate (scripts/eject-release-gate.mjs): a final version is refused while
// the eject contract's pending list has entries or its switch is still on. Both release
// scripts call it, so what it refuses and what it lets through are pinned here, and the
// wiring is pinned by reading the two scripts: an unwired gate refuses nothing.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { EJECT_MANIFEST, RELEASE_SWITCH, ejectReleaseRefusal, ejectReleaseRefusalAt } from "./eject-release-gate.mjs";

const REPO = resolve(import.meta.dirname, "..");
const ENTRY = { generator: "entity", port: "typescript", assertion: "depth", gap: 3 };
const manifest = (pending: (typeof ENTRY)[], mayBeNonEmpty: boolean) => ({
  eject: { [RELEASE_SWITCH]: mayBeNonEmpty, pending },
});

const created: string[] = [];
afterAll(() => { for (const d of created) rmSync(d, { recursive: true, force: true }); });

/** A throwaway repository root holding the gate and one shared file. */
function repoWith(body: string | undefined): string {
  const root = mkdtempSync(join(tmpdir(), "eject-release-gate-"));
  created.push(root);
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts/eject-release-gate.mjs"), readFileSync(join(REPO, "scripts/eject-release-gate.mjs")));
  if (body !== undefined) {
    mkdirSync(dirname(join(root, EJECT_MANIFEST)), { recursive: true });
    writeFileSync(join(root, EJECT_MANIFEST), body);
  }
  return root;
}

describe("eject release gate — what it refuses", () => {
  test("a final version with entries left, naming how many per port", () => {
    const refusal = ejectReleaseRefusal("1.1.0", manifest([ENTRY, { ...ENTRY, port: "java" }, ENTRY], true));
    expect(refusal).toContain("1.1.0 is a final release");
    expect(refusal).toContain("3 entries are left");
    expect(refusal).toContain("java 1, typescript 2");
    expect(refusal).toContain(`${RELEASE_SWITCH} is still true`);
  });

  test("a final version with entries left even when the switch says false", () => {
    const refusal = ejectReleaseRefusal("1.1.0", manifest([ENTRY], false));
    expect(refusal).toContain("1 entry is left");
    expect(refusal).not.toContain("is still true");
  });

  test("a final version with an empty list while the switch is still true", () => {
    const refusal = ejectReleaseRefusal("1.1.0", manifest([], true));
    expect(refusal).toContain(`${RELEASE_SWITCH} is still true`);
    expect(refusal).not.toContain("left in eject.pending");
  });

  test("a shared file it cannot read the list or the switch from", () => {
    for (const broken of [{}, { eject: {} }, { eject: { pending: [] } }, { eject: { [RELEASE_SWITCH]: "false", pending: [] } }]) {
      expect(ejectReleaseRefusal("1.1.0", broken as never)).toContain("no readable eject.pending");
    }
  });

  test("a missing or malformed shared file", () => {
    expect(ejectReleaseRefusalAt("1.1.0", repoWith(undefined))).toContain("is missing");
    expect(ejectReleaseRefusalAt("1.1.0", repoWith("{ not json"))).toContain("is not valid JSON");
  });
});

describe("eject release gate — what it lets through", () => {
  test("a final version once the list is empty and the switch is false", () => {
    expect(ejectReleaseRefusal("1.1.0", manifest([], false))).toBeNull();
  });

  test("a prerelease, whatever the list and the switch say", () => {
    for (const version of ["1.1.0-rc.1", "1.1.0-rc.3", "2.0.0-beta.1"]) {
      expect(ejectReleaseRefusal(version, manifest([ENTRY], true))).toBeNull();
      expect(ejectReleaseRefusalAt(version, repoWith(undefined))).toBeNull();
    }
  });
});

describe("eject release gate — the command and its wiring", () => {
  const run = (root: string, ...args: string[]) => {
    const r = spawnSync("node", [join(root, "scripts/eject-release-gate.mjs"), ...args], { encoding: "utf8" });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };

  test("exits 1 with the reason for a refused version, 0 otherwise, 2 for a bad argument", () => {
    const blocked = repoWith(JSON.stringify(manifest([ENTRY], true)));
    expect(run(blocked, "1.1.0").code).toBe(1);
    expect(run(blocked, "1.1.0").out).toContain("1 entry is left");
    expect(run(blocked, "1.1.0-rc.3").code).toBe(0);
    expect(run(repoWith(JSON.stringify(manifest([], false))), "1.1.0").code).toBe(0);
    expect(run(blocked).code).toBe(2);
    expect(run(blocked, "latest").code).toBe(2);
  });

  test("both release scripts ask the gate before they do anything irreversible", () => {
    const release = readFileSync(join(REPO, "scripts/release.mjs"), "utf8");
    // In the preflight: before the version is written into the package manifests.
    expect(release.indexOf("ejectReleaseRefusalAt(VERSION")).toBeGreaterThan(-1);
    expect(release.indexOf("ejectReleaseRefusalAt(VERSION")).toBeLessThan(release.indexOf("PREFLIGHT_ONLY) {"));
    const finish = readFileSync(join(REPO, "scripts/finish-release.mjs"), "utf8");
    // Before the tag: `git tag -a` is the first irreversible line of that script.
    expect(finish.indexOf("ejectReleaseRefusalAt(VERSION")).toBeGreaterThan(-1);
    expect(finish.indexOf("ejectReleaseRefusalAt(VERSION")).toBeLessThan(finish.search(/git tag -a|"tag", "-a"|git tag \$\{/));
  });

  test("the shared file in this repository is one the gate can read", () => {
    const refusal = ejectReleaseRefusalAt("1.1.0", REPO);
    // Refused or not is the release branch's business; "cannot read it" is a defect here.
    if (refusal !== null) expect(refusal).not.toContain("no readable");
    expect(ejectReleaseRefusalAt("1.1.0-rc.1", REPO)).toBeNull();
  });
});
