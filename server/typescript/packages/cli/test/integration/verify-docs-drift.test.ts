// `meta verify --docs` — the docs-drift gate, end to end against a real project.
//
// It is exercised here rather than as a unit test because the whole point of the gate is
// that it runs THE DOCS COMMAND: a unit test over a stubbed docs run would prove the diff
// logic and nothing about whether the gate and the door agree. This also exercises the
// `agent/schema.md` surface against a REAL expected-schema snapshot from migrate-ts —
// the one thing the codegen-ts unit tests deliberately cannot reach.
//
// THE GATE IS SHOWN TO FAIL, three ways, and shown NOT to fail on a hand-written file. A
// gate committed green-only proves that it ran, not that it can convict.

import { describe, test, expect } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { run } from "../../src/index.js";

// test/integration/ -> cli -> packages -> typescript -> server -> repo root
const SHOWCASE = resolve(import.meta.dirname, "../../../../../../examples/showcase");

// The docs root, taken from the CONFIG default rather than a `--out` flag — because the
// gate reads the config and `--out` does not survive the run. The test used to pass
// `--out <dir>/docs` while `verify --docs` resolved the default, and it only agreed
// because the two happened to be the same string. When the default moved to
// `docs/generated`, that coincidence ended and every case here failed at once: the two
// doors onto one directory were never actually being compared.
const DOCS_ROOT = join("docs", "generated");

/** A throwaway copy of the showcase with a freshly generated docs tree. */
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "verify-docs-"));
  cpSync(SHOWCASE, dir, { recursive: true });
  return dir;
}

async function generateDocs(dir: string): Promise<void> {
  expect(await run(["docs", dir])).toBe(0);
}

describe("meta verify --docs", () => {
  test("a freshly generated docs tree is clean, and it includes the agent surface", async () => {
    const dir = project();
    try {
      await generateDocs(dir);
      // The agent surface materialises only with a loadable gen config, which the
      // showcase has. Assert the pages exist before asserting the gate is green, so a
      // green result cannot come from the surface having silently emitted nothing.
      expect(existsSync(join(dir, DOCS_ROOT, "agent", "schema.md"))).toBe(true);
      expect(existsSync(join(dir, DOCS_ROOT, "agent", "requirements.md"))).toBe(true);
      // NO ui.md, and that is the assertion. The showcase wires entity/queries/routes/
      // prompt generators and not one UI generator, so nothing here emits a form, a hook
      // or a grid — the page's metadata predicate (`servesReadApi`) said otherwise and
      // produced a control table for forms that do not exist plus endpoints for a client
      // that was never generated. Whether the tier exists is a GENERATOR fact.
      expect(existsSync(join(dir, DOCS_ROOT, "agent", "ui.md"))).toBe(false);
      // Built from the REAL migrate-ts snapshot: the dialect comes from the project's
      // own config, not from `meta docs`'s neutral "sqlite" placeholder.
      const schema = readFileSync(join(dir, DOCS_ROOT, "agent", "schema.md"), "utf8");
      expect(schema).toContain("`subscribers`");
      expect(schema).toContain("Declared by `acme::Subscriber`.");

      expect(await run(["verify", "--cwd", dir, "--docs"])).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("FAILS when a committed page's content no longer matches the model", async () => {
    const dir = project();
    try {
      await generateDocs(dir);
      const page = join(dir, DOCS_ROOT, "agent", "schema.md");
      writeFileSync(page, readFileSync(page, "utf8").replace("subscribers", "subscribersRENAMED"));
      expect(await run(["verify", "--cwd", dir, "--docs"])).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("FAILS when a page a fresh run emits was never committed", async () => {
    const dir = project();
    try {
      await generateDocs(dir);
      // A page the showcase DOES emit — ui.md is not one of them (no UI generator).
      rmSync(join(dir, DOCS_ROOT, "agent", "schema.md"));
      expect(await run(["verify", "--cwd", dir, "--docs"])).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("FAILS when the MODEL moved and nobody re-ran `meta docs`", async () => {
    const dir = project();
    try {
      await generateDocs(dir);
      // The real drift this gate exists for: the metadata changes, the committed pages
      // keep describing the previous model, and every other gate stays green.
      const meta = join(dir, "metaobjects", "meta.subscriber.yaml");
      writeFileSync(meta, readFileSync(meta, "utf8").replace("name: name", "name: fullName"));
      expect(await run(["verify", "--cwd", dir, "--docs"])).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does NOT fail on a hand-written file sitting in the docs directory", async () => {
    const dir = project();
    try {
      await generateDocs(dir);
      // `docs.outDir` defaults to `./docs`, which in a real repository is full of
      // hand-written documentation. Convicting those is the jurisdiction mistake
      // `verify --codegen`'s orphan branch was corrected for; with no manifest to appeal
      // to, this gate must never make it.
      writeFileSync(join(dir, DOCS_ROOT, "ARCHITECTURE.md"), "# Ours, not MetaObjects'.\n");
      // Inside `agent/` too: the gate convicts a STALE GENERATED page there, and it tells
      // the two apart by the `@generated` marker rather than by the directory alone.
      writeFileSync(join(dir, DOCS_ROOT, "agent", "NOTES.md"), "# Also ours.\n");
      expect(await run(["verify", "--cwd", dir, "--docs"])).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("FAILS when a generated `agent/` page is committed that a fresh run no longer emits", async () => {
    const dir = project();
    try {
      await generateDocs(dir);
      // The case this gate was silent on: `meta docs` SKIPS `agent/schema.md` (rather than
      // failing) when the expected schema cannot be built or no dialect is declared, so a
      // committed page describing the previous schema survived the diff — the fresh run
      // produced no counterpart to compare it against. That is the change the gate most
      // needs to flag, and it passed on it.
      //
      // Simulated by copying a generated page to a name no run emits: same shape, one
      // condition — a committed file carrying our marker that a fresh run does not
      // produce — without needing to break the project to reach it.
      const stale = readFileSync(join(dir, DOCS_ROOT, "agent", "schema.md"), "utf8");
      writeFileSync(join(dir, DOCS_ROOT, "agent", "schema.postgres.md"), stale);
      expect(await run(["verify", "--cwd", dir, "--docs"])).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a dangling symlink in the docs tree does not take the gate down", async () => {
    const dir = project();
    try {
      await generateDocs(dir);
      // The committed tree is WALKED now (it was not before the orphan branch), and a real
      // repository's `docs/` may hold a symlink to a build output absent on CI. `statSync`
      // follows it and throws ENOENT, which the caller reports as "regeneration failed" —
      // the gate going red, blaming the fresh run, for a dangling link it did not create.
      symlinkSync(join(dir, DOCS_ROOT, "nowhere-at-all"), join(dir, DOCS_ROOT, "dangling.md"));
      expect(await run(["verify", "--cwd", dir, "--docs"])).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("exits 2 (a configuration problem, not drift) with no gen config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-docs-noconfig-"));
    try {
      cpSync(join(SHOWCASE, "metaobjects"), join(dir, "metaobjects"), { recursive: true });
      cpSync(join(SHOWCASE, ".metaobjects", "config.json"),
             join(dir, ".metaobjects", "config.json"), { recursive: true });
      expect(await run(["verify", "--cwd", dir, "--docs"])).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// A page the project deliberately does NOT commit is not drift.
//
// The gate diffed everything a fresh `meta docs` would emit against the committed
// tree, and called every page it did not find committed drift. An estate generating
// three surfaces and committing 2 files of 589 — gitignoring the rest, with a comment
// explaining they are a derived view of metadata that is already the source of truth —
// was told it had 588 drifted pages. EXACTLY ONE was real.
//
// `docs.outDir` is a directory, not a namespace MetaObjects owns: the jurisdiction
// ruling 0.24.3 made for `verify --codegen`. That one could key on
// `.gen-state/.hashes.json`, a record of what the generator WROTE; `meta docs` keeps no
// manifest, so the gate asks the project instead, through git.
// ---------------------------------------------------------------------------

function git(dir: string, ...args: string[]): { status: number; stderr: string } {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
  return { status: r.status ?? -1, stderr: r.stderr ?? "" };
}

/** A showcase copy that is its own git repository, with `body` as .gitignore. */
function gitProject(body: string): string {
  const dir = project();
  writeFileSync(join(dir, ".gitignore"), body);
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  return dir;
}

/** Capture what the gate printed, without printing it. */
async function runCapturingStderr(args: string[]): Promise<{ exit: number; out: string }> {
  const chunks: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { chunks.push(a.map(String).join(" ")); };
  try {
    const exit = await run(args);
    return { exit, out: chunks.join("\n") };
  } finally {
    console.error = orig;
  }
}

describe("meta verify --docs — a git-ignored page is not drift", () => {
  test("the F27 reproduction: generate all, commit two, gate is clean", async () => {
    const dir = gitProject(`${DOCS_ROOT}/*\n!${DOCS_ROOT}/requirements.md\n!${DOCS_ROOT}/requirements.toon\n`);
    try {
      await generateDocs(dir);
      git(dir, "add", "-f", ".gitignore", `${DOCS_ROOT}/requirements.md`, `${DOCS_ROOT}/requirements.toon`);
      git(dir, "commit", "-qm", "docs");

      const { exit, out } = await runCapturingStderr(["verify", "--cwd", dir, "--docs"]);
      expect(`${exit}: ${out}`).toContain("0: ");
      expect(exit).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("...and a REAL edit to one of the two committed pages still convicts", async () => {
    // The other half. A rule that exempts everything is not a fix, it is a mute button.
    const dir = gitProject(`${DOCS_ROOT}/*\n!${DOCS_ROOT}/requirements.md\n!${DOCS_ROOT}/requirements.toon\n`);
    try {
      await generateDocs(dir);
      git(dir, "add", "-f", ".gitignore", `${DOCS_ROOT}/requirements.md`, `${DOCS_ROOT}/requirements.toon`);
      git(dir, "commit", "-qm", "docs");
      writeFileSync(join(dir, DOCS_ROOT, "requirements.md"), "hand-edited\n");

      const { exit, out } = await runCapturingStderr(["verify", "--cwd", dir, "--docs"]);
      expect(exit).toBe(1);
      // Exactly ONE line, and it is the `~`. No `+` for the 587 the project ignores.
      expect(out).toContain("~ requirements.md");
      expect(out).not.toContain("+ ");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a TRACKED page is compared even when a pattern would ignore it", async () => {
    // The property the whole design rests on: git never reports a tracked path as
    // ignored. So this rule can never be used to hide a page the project commits.
    const dir = gitProject(`${DOCS_ROOT}/\n`);
    try {
      await generateDocs(dir);
      git(dir, "add", "-f", ".gitignore", `${DOCS_ROOT}/agent/schema.md`);
      git(dir, "commit", "-qm", "docs");
      writeFileSync(join(dir, DOCS_ROOT, "agent", "schema.md"), "hand-edited\n");

      const { exit, out } = await runCapturingStderr(["verify", "--cwd", dir, "--docs"]);
      expect(exit).toBe(1);
      expect(out).toContain("~ agent/schema.md");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ignoring EVERYTHING is refused, not reported clean", async () => {
    // A gate asked to check pages that could check none must not answer "no drift".
    const dir = gitProject(`${DOCS_ROOT}/\n`);
    try {
      await generateDocs(dir);
      git(dir, "add", "-f", ".gitignore");
      git(dir, "commit", "-qm", "ignore");

      const { exit, out } = await runCapturingStderr(["verify", "--cwd", dir, "--docs"]);
      expect(exit).toBe(2);
      expect(out).toContain("every one of them is git-ignored");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a page that is neither committed nor ignored is STILL drift", async () => {
    // The defect the simpler rule ("never report an absent page") would have lost: a
    // tracked page deleted by hand, or lost in a merge, produces no `~` anywhere.
    const dir = gitProject("");
    try {
      await generateDocs(dir);
      git(dir, "add", "-f", "docs");
      git(dir, "commit", "-qm", "docs");
      rmSync(join(dir, DOCS_ROOT, "README.md"));

      const { exit, out } = await runCapturingStderr(["verify", "--cwd", dir, "--docs"]);
      expect(exit).toBe(1);
      expect(out).toContain("+ README.md");
      // And it names the escape, at the point of conviction.
      expect(out).toContain("git-ignored");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an ignored ORPHAN is counted as skipped, not silently dropped", async () => {
    // The gate tests fresh pages AND owned orphans against .gitignore, then reported
    // "N git-ignored page(s) not checked" counting only the fresh half. So a stale
    // generated page sitting in an ignored path was skipped and the line that exists to
    // say how much was skipped did not mention it — and with no fresh page ignored, the
    // count was 0 and the line did not print at all. The run was clean and SILENT about
    // a page it had decided not to look at.
    //
    // Untracked on purpose: git never reports a TRACKED path as ignored (the test
    // above), so the only way to reach this branch is the real-world shape — a leftover
    // generated page on a machine that has run `meta docs`, under an ignored path.
    const dir = gitProject(`${DOCS_ROOT}/agent/stale-page.md\n`);
    try {
      await generateDocs(dir);
      git(dir, "add", "-f", ".gitignore", "docs");
      git(dir, "commit", "-qm", "docs");
      // Ours by both halves of `isOurs`: under `agent/`, carrying the generated marker.
      writeFileSync(
        join(dir, DOCS_ROOT, "agent", "stale-page.md"),
        "<!-- @generated by meta docs -->\n\nA page a fresh run no longer emits.\n",
      );

      const { exit, out } = await runCapturingStderr(["verify", "--cwd", dir, "--docs"]);
      // Still clean — the page IS ignored, and an ignored page is not drift.
      expect(exit).toBe(0);
      expect(out).not.toContain("- agent/stale-page.md");
      // ...but the gate must say it skipped something. This is the assertion that fails
      // without the fix: the count was 0, so no line printed.
      expect(out).toContain("1 git-ignored page(s) not checked");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("git unavailable degrades to the FULL check, and says so", async () => {
    // Fails closed, loudly. It must never silently treat "cannot say" as "nothing is
    // ignored" while reporting a denominator that implies it checked everything.
    //
    // Stated as a CONTRAST on one fixture, because that is the only form that proves
    // the exemption is what produced the clean run: the same project, the same missing
    // page, exempt when git can answer and convicted when it cannot.
    const dir = gitProject(`${DOCS_ROOT}/*\n!${DOCS_ROOT}/requirements.md\n!${DOCS_ROOT}/requirements.toon\n`);
    try {
      await generateDocs(dir);
      git(dir, "add", "-f", ".gitignore", `${DOCS_ROOT}/requirements.md`, `${DOCS_ROOT}/requirements.toon`);
      git(dir, "commit", "-qm", "docs");
      // An ignored page that is NOT on disk — the fresh-clone shape.
      rmSync(join(dir, DOCS_ROOT, "README.md"));

      const withGit = await runCapturingStderr(["verify", "--cwd", dir, "--docs"]);
      expect(withGit.exit).toBe(0);

      const prev = process.env.META_GEN_GIT;
      process.env.META_GEN_GIT = join(dir, "no-such-git-binary");
      try {
        const { exit, out } = await runCapturingStderr(["verify", "--cwd", dir, "--docs"]);
        expect(exit).toBe(1);
        expect(out).toContain("+ README.md");
        expect(out).toContain(".gitignore not consulted");
      } finally {
        if (prev === undefined) delete process.env.META_GEN_GIT;
        else process.env.META_GEN_GIT = prev;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the verdict does not depend on which files this machine happens to have", async () => {
    // The exemption is computed over the fresh set BY NAME, on disk or not. Deciding
    // per-file-existence would have made `checked` a property of the machine: a dev box
    // that has run `meta docs` has all 589 pages present and a CI runner has two.
    const body = `${DOCS_ROOT}/*\n!${DOCS_ROOT}/requirements.md\n!${DOCS_ROOT}/requirements.toon\n`;
    const withPages = gitProject(body);
    const withoutPages = gitProject(body);
    try {
      for (const dir of [withPages, withoutPages]) {
        await generateDocs(dir);
        git(dir, "add", "-f", ".gitignore", `${DOCS_ROOT}/requirements.md`, `${DOCS_ROOT}/requirements.toon`);
        git(dir, "commit", "-qm", "docs");
      }
      // One machine keeps every locally generated page; the other is a fresh clone.
      rmSync(join(withoutPages, DOCS_ROOT, "README.md"));
      rmSync(join(withoutPages, DOCS_ROOT, "agent"), { recursive: true, force: true });

      const a = await runCapturingStderr(["verify", "--cwd", withPages, "--docs"]);
      const b = await runCapturingStderr(["verify", "--cwd", withoutPages, "--docs"]);
      expect(a.exit).toBe(0);
      expect(b.exit).toBe(0);
    } finally {
      rmSync(withPages, { recursive: true, force: true });
      rmSync(withoutPages, { recursive: true, force: true });
    }
  });
});
