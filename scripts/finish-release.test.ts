// The release tag gate, exercised against throwaway repositories.
//
// `scripts/finish-release.mjs` decides whether `v<version>` is cut, and the website's
// Pages deploy RESOLVES that tag, clones the tree and publishes what it finds. So every
// refusal in it is the difference between metaobjects.dev stating the release and
// metaobjects.dev stating something that never shipped. Until this file it had zero
// automated tests and ran in no lane — a code review found eight defects in 172 lines,
// which is the measure of what an untested release gate can hide. Each case below maps
// to one of those, so a regression fails here rather than on release day.
//
// ── Why a fixture repository, and why the script is COPIED into it ─────────────
//
// The script computes its repo root from its OWN location
// (`resolve(dirname(fileURLToPath(import.meta.url)), "..")`), which is the right thing
// for a release tool — there is no flag or environment variable that could point it at
// the wrong tree. So the test copies the real file, byte for byte, beside a fixture
// repository instead of teaching the production script a test-only escape hatch. The
// copy is made from `scripts/finish-release.mjs` on every run, so it cannot drift.
//
// The fixture is a PAIR — a bare `origin` and a working repository pushed to it —
// because half of gate 1 and all of gate 2 are claims about `origin`: that HEAD matches
// it, that the fetch which justifies saying so actually succeeded, and that the tag is
// free there as well as locally. A single-repository fixture would pass all of that
// without testing any of it.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const SCRIPT = readFileSync(resolve(REPO, "scripts/finish-release.mjs"), "utf8");

const created: string[] = [];
afterAll(() => { for (const d of created) rmSync(d, { recursive: true, force: true }); });

type Coords = { npm: string; pypi: string; nuget: string; maven: string };

/** The release every fixture describes unless a case says otherwise. */
const RELEASE = "0.24.6";
const SHIPPED: Coords = { npm: "0.24.6", pypi: "0.24.6", nuget: "0.24.6", maven: "7.24.6" };

/**
 * The two llms mirrors, shaped like the real ones: a `> A cross-language …` summary
 * line, some prose that names no registry, and an `## Implementations` heading that
 * repeats every coordinate. Gate 5 reads the summary and the claim lines separately, and
 * the whole point is that they can disagree.
 */
function llms(c: Coords, extra = ""): string {
  return [
    "# MetaObjects",
    "",
    `> A cross-language metadata standard for declaring typed entity models across five languages. Apache 2.0. Shipping at \`${c.npm}\` on npm and \`${c.maven}\` on Maven Central.`,
    "",
    "The metamodel is the durable spine; generated code is the disposable artifact.",
    extra,
    "",
    `## Implementations (npm \`${c.npm}\` · PyPI \`${c.pypi}\` · NuGet \`${c.nuget}\` · Maven Central \`${c.maven}\`)`,
    "",
  ].join("\n");
}

type Spec = {
  /** What the committed payload SAYS shipped. */
  payload?: Partial<Coords>;
  /** What each port's own manifest reads — the discriminator that makes `--sat-out` safe. */
  manifest?: Partial<Coords>;
  /** Whole-file body for both mirrors. Defaults to one consistent with `payload`. */
  llms?: string;
  /** Extra tags to create locally before the run (gate 6's tag line). */
  tags?: string[];
  /** Files the tree deliberately does NOT carry (gate 4 / gate 5). */
  omit?: string[];
  /** Verbatim overrides, applied last. */
  files?: Record<string, string>;
  /** Delete the bare origin after pushing, so `git fetch` fails (gate 1). */
  breakOrigin?: boolean;
};

type Fixture = {
  work: string;
  origin: string;
  run: (...args: string[]) => { code: number; out: string };
  git: (repo: string, ...args: string[]) => string;
};

function git(repo: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return (r.stdout ?? "").trim();
}

function makeRepo(spec: Spec = {}): Fixture {
  const base = mkdtempSync(join(tmpdir(), "mo-finish-release-"));
  created.push(base);
  const work = join(base, "work");
  const origin = join(base, "origin.git");

  const payload: Coords = { ...SHIPPED, ...spec.payload };
  const manifest: Coords = { ...SHIPPED, ...spec.manifest };
  const mirror = spec.llms ?? llms(payload);

  const files: Record<string, string> = {
    "examples/showcase/site-payload.json":
      `${JSON.stringify({ registries: { ...payload, metamodel: "0.13" }, snippets: {} }, null, 2)}\n`,
    "server/typescript/packages/cli/package.json":
      `${JSON.stringify({ name: "@metaobjectsdev/cli", version: manifest.npm }, null, 2)}\n`,
    "server/python/pyproject.toml":
      `[project]\nname = "metaobjects"\nversion = "${manifest.pypi}"\n`,
    "server/csharp/Directory.Build.props":
      `<Project>\n  <PropertyGroup>\n    <Version>${manifest.nuget}</Version>\n  </PropertyGroup>\n</Project>\n`,
    // `<modelVersion>` comes first in the real pom, exactly as here: the manifest regex
    // must anchor on `<version>` and not be satisfied by the `4.0.0` above it.
    "server/java/pom.xml":
      `<project>\n  <modelVersion>4.0.0</modelVersion>\n  <version>${manifest.maven}</version>\n</project>\n`,
    "scripts/site-inject-ci.mjs": "// deploy entrypoint (stub)\n",
    "scripts/site/inject.mjs": "// imported by the entrypoint (stub)\n",
    "site-reference/index.html": "<!doctype html><title>reference</title>\n",
    "docs/llms/llms.txt": mirror,
    "docs/llms/llms-full.txt": mirror,
    ...spec.files,
  };
  for (const rel of spec.omit ?? []) delete files[rel];

  spawnSync("git", ["init", "-b", "main", "--quiet", work], { encoding: "utf8" });
  spawnSync("git", ["init", "--bare", "-b", "main", "--quiet", origin], { encoding: "utf8" });
  // `core.hooksPath` off: this repository points it at `.githooks`, whose pre-commit
  // guard scans staged lines and whose pre-push runs a TypeScript typecheck. Neither has
  // anything to say about a fixture, and both would make these tests depend on the
  // developer's checkout.
  //
  // `fetch.pruneTags` off is not cosmetic. It is git's default, but this maintainer's
  // GLOBAL config turns it on — and with it on, gate 1's own `git fetch origin` deletes
  // any local tag origin does not have. Four of these tests silently lost the state they
  // were setting up and passed the gate they meant to trip. A fixture must describe git's
  // documented defaults, not whatever the operator happens to have configured.
  //
  // (For the record, the production script is unharmed by that setting: pruning a stray
  // local tag before gate 2 reads it makes the tag free, so a re-run after a failed push
  // proceeds and re-cuts it on the current tree instead of printing gate 2's recovery
  // advice. That is the same end state, reached quietly.)
  for (const [k, v] of Object.entries({
    "user.name": "Fixture", "user.email": "fixture@example.invalid",
    "core.hooksPath": "/dev/null", "commit.gpgsign": "false", "tag.gpgsign": "false",
    "fetch.prune": "false", "fetch.pruneTags": "false",
  })) git(work, "config", k, v);

  // The script under test lives INSIDE the tree it reasons about, so it is committed
  // like any other file — otherwise gate 1 would report the fixture dirty.
  for (const [rel, body] of Object.entries({ ...files, "scripts/finish-release.mjs": SCRIPT })) {
    const full = join(work, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", "fixture");
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "--quiet", "-u", "origin", "main");
  for (const t of spec.tags ?? []) git(work, "tag", t);
  if (spec.breakOrigin === true) rmSync(origin, { recursive: true, force: true });

  return {
    work, origin, git,
    run: (...args) => {
      const r = spawnSync("node", [join(work, "scripts/finish-release.mjs"), ...args],
        { encoding: "utf8", cwd: work });
      return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
    },
  };
}

describe("finish-release: the version argument", () => {
  test("refuses a missing version", () => {
    const r = makeRepo().run("--check");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("usage:");
  });

  test("refuses a non-semver version rather than deriving a Maven coordinate from it", () => {
    const r = makeRepo().run("v0.24.6", "--check");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("usage:");
  });
});

describe("finish-release gate 1: the tree that will be tagged", () => {
  test("a dirty tree is refused — a tag names a COMMIT, not the disk", () => {
    const f = makeRepo();
    writeFileSync(join(f.work, "examples/showcase/site-payload.json"), "{}");
    const r = f.run(RELEASE, "--check");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("working tree is dirty");
  });

  test("a branch other than main is refused", () => {
    const f = makeRepo();
    f.git(f.work, "checkout", "--quiet", "-b", "release-prep");
    const r = f.run(RELEASE, "--check");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("not on main");
  });

  test("an unpushed HEAD is refused — the deploy clones the REMOTE tag", () => {
    const f = makeRepo();
    writeFileSync(join(f.work, "NOTES.md"), "unpushed\n");
    f.git(f.work, "add", "-A");
    f.git(f.work, "commit", "--quiet", "-m", "local only");
    const r = f.run(RELEASE, "--check");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("HEAD is not origin/main");
  });

  // The defect: the fetch was `|| true`, so a failure left `origin/main` at a stale
  // remote-tracking ref and the very next line printed "synced with origin" having
  // verified nothing. The realistic case is the port-bump commit pushed from another
  // checkout — HEAD matches the stale ref and the tag is cut on a tree that predates it.
  test("a FAILED fetch is refused, and does not claim the tree is synced", () => {
    const r = makeRepo({ breakOrigin: true }).run(RELEASE, "--check");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("git fetch origin failed");
    // The refusal QUOTES the claim it is declining to make, so the assertion has to be
    // on the green tick, not on the phrase.
    expect(r.out).not.toContain("on main, clean, synced with origin");
  });
});

describe("finish-release gate 2: the tag is free", () => {
  test("a tag that exists on both local and origin is refused outright", () => {
    const f = makeRepo();
    f.git(f.work, "tag", `v${RELEASE}`);
    f.git(f.work, "push", "--quiet", "origin", `v${RELEASE}`);
    const r = f.run(RELEASE, "--check");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("never move a release tag");
  });

  // The one recoverable case, and it says so: a previous run tagged and failed to push.
  test("a tag local-only names the one safe remedy", () => {
    const f = makeRepo({ tags: [`v${RELEASE}`] });
    const r = f.run(RELEASE, "--check");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("exists LOCALLY but not on origin");
    expect(r.out).toContain(`git tag -d v${RELEASE}`);
  });
});

describe("finish-release gate 3: the payload states what shipped", () => {
  test("a payload naming every coordinate passes", () => {
    const r = makeRepo().run(RELEASE, "--check");
    expect(r.out).toContain("payload states all four coordinates");
    expect(r.code).toBe(0);
  });

  test("a missing payload is named, not crashed on", () => {
    const r = makeRepo({ omit: ["examples/showcase/site-payload.json"] }).run(RELEASE, "--check");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("missing");
    expect(r.out).toContain("site-payload.json");
  });

  test("an unparseable payload names the file rather than throwing a stack trace", () => {
    const r = makeRepo({ files: { "examples/showcase/site-payload.json": "{ nope\n" } })
      .run(RELEASE, "--check");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("is not valid JSON");
    expect(r.out).not.toContain("at JSON.parse");
  });

  // ── the `--sat-out` ruling ──────────────────────────────────────────────────
  //
  // Under publish-what-changed a registry may legitimately keep its old number, so a
  // mismatch is not automatically an error. But `--sat-out` used to be offered as a
  // ready-made remedy for ANY mismatch — and the overwhelmingly likely cause of a
  // mismatch is not a sit-out, it is `bun run site:payload` not having been re-run after
  // the bump. An operator following the tool's own advice would have silenced three real
  // mismatches and cut a tag stating three versions that were never released: v0.24.5's
  // defect, reproduced by the tool written to prevent it.
  //
  // The discriminator is the port's OWN manifest. A registry that sat out has an unmoved
  // one; a payload that was not rebuilt sits beside a manifest that DID move.

  test("a STALE payload is refused and no --sat-out is offered", () => {
    // Manifests all moved to 0.24.6. The payload still reads 0.24.5 for two of them —
    // the shape of a forgotten `site:payload` rebuild.
    const r = makeRepo({
      payload: { pypi: "0.24.5", nuget: "0.24.5" },
      llms: llms(SHIPPED),
    }).run(RELEASE, "--check");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("manifest already moved — payload is STALE");
    expect(r.out).not.toContain("--sat-out");
  });

  test("a declared --sat-out its own manifest contradicts is refused", () => {
    const r = makeRepo({ payload: { pypi: "0.24.5" }, llms: llms(SHIPPED) })
      .run(RELEASE, "--sat-out", "pypi", "--check");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("declared --sat-out, but their own manifests say otherwise");
    expect(r.out).toContain("manifest says 0.24.6, payload says 0.24.5");
  });

  test("a GENUINE sit-out passes — manifest and payload both unmoved", () => {
    const r = makeRepo({
      payload: { pypi: "0.24.5" }, manifest: { pypi: "0.24.5" }, llms: llms(SHIPPED),
    }).run(RELEASE, "--sat-out", "pypi", "--check");
    expect(r.out).toContain("pypi sat this release out, manifests agree");
    expect(r.code).toBe(0);
  });

  test("a genuine sit-out still has to be DECLARED", () => {
    const f = makeRepo({
      payload: { pypi: "0.24.5" }, manifest: { pypi: "0.24.5" }, llms: llms(SHIPPED),
    });
    const r = f.run(RELEASE, "--check");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("manifest agrees with the payload — may have sat out");
    expect(r.out).toContain("--sat-out pypi");
  });

  // `--sat-out --check` used to make "--check" a registry name, which was harmless only
  // because no registry is called that. It must not silently become an empty declaration
  // either — the mismatch is still unexplained and must still refuse.
  test("a following FLAG is not a --sat-out value", () => {
    const r = makeRepo({
      payload: { pypi: "0.24.5" }, manifest: { pypi: "0.24.5" }, llms: llms(SHIPPED),
    }).run(RELEASE, "--sat-out", "--check");
    expect(r.code).not.toBe(0);
    expect(r.out).not.toContain("sat this release out, manifests agree");
    // It must refuse for the RIGHT reason. Treating "--check" as a registry name also
    // refuses — as an implausible declaration — so asserting only on the exit code
    // cannot tell the fix from the defect. The unexplained mismatch is pypi's.
    expect(r.out).toContain("the site payload does not state this release");
    expect(r.out).toContain("pypi");
  });

  // npm cannot sit out: `<version>` IS the npm version, written into all 14 package.json
  // files by release.mjs. The accurate message used to fire only when an operator typed
  // `npm` explicitly, which nobody does, so the generic branch answered instead.
  test("an npm mismatch gets the npm-specific message, never an empty --sat-out", () => {
    const r = makeRepo({ payload: { npm: "0.24.5" }, llms: llms(SHIPPED) })
      .run(RELEASE, "--check");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("npm cannot sit out");
    expect(r.out).toContain("bun run site:payload");
    expect(r.out).not.toContain("--sat-out ");
  });

  test("npm cannot be waived by declaring it", () => {
    const r = makeRepo({ payload: { npm: "0.24.5" }, manifest: { npm: "0.24.5" }, llms: llms(SHIPPED) })
      .run(RELEASE, "--sat-out", "npm", "--check");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("npm cannot sit out");
  });
});

describe("finish-release gate 4: the deploy's own files are in the tree", () => {
  // The deploy runs the injector FROM the tag. Each of these fails the deploy or, worse,
  // publishes a site that renders as though nothing is wrong.
  for (const rel of [
    "scripts/site-inject-ci.mjs",
    "scripts/site/inject.mjs",
    "site-reference/index.html",
  ]) {
    test(`${rel} missing from the tree is refused`, () => {
      const r = makeRepo({ omit: [rel] }).run(RELEASE, "--check");
      expect(r.code).not.toBe(0);
      expect(r.out).toContain(`${rel} is not in the tree being tagged`);
    });
  }
});

describe("finish-release gate 5: the llms mirrors state this release", () => {
  test("mirrors naming this release pass", () => {
    const r = makeRepo().run(RELEASE, "--check");
    expect(r.out).toContain("the llms mirrors state this release");
    expect(r.code).toBe(0);
  });

  test("a mirror missing from the tree is refused, with a diagnostic not a stack trace", () => {
    const r = makeRepo({ omit: ["docs/llms/llms-full.txt"] }).run(RELEASE, "--check");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("docs/llms/llms-full.txt is not in the tree being tagged");
    expect(r.out).not.toContain("Command failed");
  });

  test("an unrefreshed summary is refused", () => {
    const r = makeRepo({ llms: llms({ ...SHIPPED, npm: "0.24.5", maven: "7.24.5" }) })
      .run(RELEASE, "--check");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("does not name npm 0.24.6 or Maven 7.24.6");
  });

  test("a summary refreshed for npm but not for Maven is refused", () => {
    const body = llms(SHIPPED).replace(
      "`7.24.6` on Maven Central.", "`7.24.5` on Maven Central.");
    const r = makeRepo({ llms: body }).run(RELEASE, "--check");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("does not name Maven 7.24.6");
  });

  test("a mirror with no summary line at all is refused", () => {
    const r = makeRepo({ llms: "# MetaObjects\n\nno summary here\n" }).run(RELEASE, "--check");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(`has no "> A cross-language …" summary line`);
  });

  // The worse half, and the one a summary-only check leaves open: a refreshed headline
  // beside an install block that still names the previous release.
  test("a refreshed summary beside a stale claim line is refused", () => {
    const body = llms(SHIPPED).replace(
      "## Implementations (npm `0.24.6`",
      "## Implementations (npm `0.24.5`");
    const r = makeRepo({ llms: body }).run(RELEASE, "--check");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("names a version this release did not ship");
    expect(r.out).toContain("0.24.5");
  });

  // The stale-version scan used to look for the `0.x.y` and `7.x.y` FAMILIES rather than
  // for "not one of the two coordinates". Both literals stop matching at 1.0.0 / 8.0.0,
  // so the gate went silently blind on the one release whose mirrors have the most to get
  // wrong — the same hardcoded 7 that MAVEN_MAJOR exists to avoid, one gate further down.
  test("a stale claim line is caught AFTER 1.0.0, where the version families change", () => {
    const coords: Coords = { npm: "1.0.1", pypi: "1.0.1", nuget: "1.0.1", maven: "8.0.1" };
    const body = llms(coords).replace("## Implementations (npm `1.0.1`", "## Implementations (npm `1.0.0`");
    const r = makeRepo({ payload: coords, manifest: coords, llms: body }).run("1.0.1", "--check");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("names a version this release did not ship");
    expect(r.out).toContain("1.0.0");
  });

  test("a stale MAVEN claim line is caught after the JVM line moves to 8", () => {
    const coords: Coords = { npm: "1.0.1", pypi: "1.0.1", nuget: "1.0.1", maven: "8.0.1" };
    const body = llms(coords).replace("Maven Central `8.0.1`", "Maven Central `8.0.0`");
    const r = makeRepo({ payload: coords, manifest: coords, llms: body }).run("1.0.1", "--check");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("8.0.0");
  });

  // The false-failure this deliberately avoids. A version named on a line that makes NO
  // registry claim is history, and an earlier blanket rule tripped on exactly this
  // sentence — which is correct prose in the shipped mirrors.
  test("a HISTORICAL version on a non-claim line passes", () => {
    const r = makeRepo({
      llms: llms(SHIPPED, "\n`abandoned` and `superseded` were retired in `0.24.0`.\n"),
    }).run(RELEASE, "--check");
    expect(r.out).toContain("the llms mirrors state this release");
    expect(r.code).toBe(0);
  });
});

describe("finish-release gate 6: the tag the deploy will resolve", () => {
  // The deploy resolves `git tag -l 'v0.*' | grep -E '^v0\.[0-9]+\.[0-9]+$' | sort -V |
  // tail -1`. This mirrors that filter, so a change to either is caught here rather than
  // on a deploy nobody is watching — and the comparison is NUMERIC, which a plain string
  // sort gets wrong at every ten-fold boundary.
  const cases: Array<{ existing: string[]; cutting: string; passes: boolean; why: string }> = [
    { existing: ["v0.9.0"], cutting: "0.10.0", passes: true, why: "0.10.0 is newer than 0.9.0" },
    { existing: ["v0.24.9"], cutting: "0.24.10", passes: true, why: "0.24.10 is newer than 0.24.9" },
    { existing: ["v0.10.0"], cutting: "0.9.0", passes: false, why: "0.9.0 is OLDER than 0.10.0" },
    { existing: ["v0.24.10"], cutting: "0.24.9", passes: false, why: "0.24.9 is OLDER than 0.24.10" },
  ];
  for (const c of cases) {
    test(`cutting v${c.cutting} over ${c.existing.join(",")} ${c.passes ? "passes" : "is refused"} — ${c.why}`, () => {
      const coords: Coords = {
        npm: c.cutting, pypi: c.cutting, nuget: c.cutting,
        maven: `7.${c.cutting.split(".").slice(1).join(".")}`,
      };
      const r = makeRepo({ payload: coords, manifest: coords, llms: llms(coords), tags: c.existing })
        .run(c.cutting, "--check");
      if (c.passes) {
        expect(r.out).toContain(`the site deploy will resolve v${c.cutting}`);
        expect(r.code).toBe(0);
      } else {
        expect(r.code).not.toBe(0);
        expect(r.out).toContain("the deploy would still resolve");
      }
    });
  }

  // The repository carries two tag lines and a bare `v*` sort returns v7.20.12, a tree
  // with no examples/showcase at all. The grep is what keeps the JVM line out.
  test("the JVM tag line does not count as the newest tag", () => {
    const r = makeRepo({ tags: ["v7.20.12", "v0.24.5"] }).run(RELEASE, "--check");
    expect(r.out).toContain(`the site deploy will resolve v${RELEASE}`);
    expect(r.code).toBe(0);
  });
});

describe("finish-release gate 7: cutting the tag", () => {
  test("tags and pushes, naming both coordinates in the message", () => {
    const f = makeRepo();
    const r = f.run(RELEASE);
    expect(r.out).toContain(`cut and pushed v${RELEASE}`);
    expect(r.code).toBe(0);
    expect(f.git(f.work, "tag", "-l", "--format=%(contents)", `v${RELEASE}`))
      .toContain(`metaobjects ${RELEASE} / 7.${RELEASE.split(".").slice(1).join(".")}`);
    // Pushed, not merely created: the deploy clones the REMOTE tag.
    expect(f.git(f.origin, "tag", "-l")).toContain(`v${RELEASE}`);
  });

  test("--check cuts nothing", () => {
    const f = makeRepo();
    expect(f.run(RELEASE, "--check").code).toBe(0);
    expect(f.git(f.work, "tag", "-l")).toBe("");
    expect(f.git(f.origin, "tag", "-l")).toBe("");
  });

  // ADR-0035 and docs/1.0-readiness.md fix the JVM coordinate at 8.0.0 when the other
  // three cut 1.0.0 — a forward major, not a continuation. A hardcoded 7 would demand
  // 7.0.0 while the manifest and Maven Central both said 8.0.0, and the only ways past
  // would be to declare Maven (which definitely published) as --sat-out or to write a
  // wrong coordinate into the payload. Both defeat the gate.
  test("1.0.0 derives Maven 8.0.0, not 7.0.0", () => {
    const coords: Coords = { npm: "1.0.0", pypi: "1.0.0", nuget: "1.0.0", maven: "8.0.0" };
    const f = makeRepo({ payload: coords, manifest: coords, llms: llms(coords) });
    const r = f.run("1.0.0");
    expect(r.out).toContain("Maven 8.0.0");
    expect(r.code).toBe(0);
    expect(f.git(f.work, "tag", "-l", "--format=%(contents)", "v1.0.0"))
      .toContain("metaobjects 1.0.0 / 8.0.0");
  });
});
