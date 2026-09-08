// The advisory that tells an adopter their scaffold landed in an ignored directory.
//
// It shipped with no test, and it was silent for every caller that did not happen to run
// from the project directory. `meta init` hands it REPO-RELATIVE paths (".claude/skills/…",
// ".metaobjects/config.json"), and `relative(cwd, p)` resolves BOTH sides against the
// ambient `process.cwd()` — so under `--cwd` every entry came back "../"-prefixed, the
// filter dropped all of them, and the function returned before consulting git. Silent, on
// the exact path the check exists for.
//
// A real git repository in a tmpdir, because the thing being asked is what git ignores,
// and because a test whose process.cwd() equals the project would reproduce nothing.

import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportIgnoredScaffold } from "../src/lib/ignored-scaffold-check.js";
import { log } from "../src/lib/log.js";

let root: string;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ignored-scaffold-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function gitInit(): void {
  spawnSync("git", ["-C", root, "init", "-q"], { encoding: "utf-8" });
}

/** The paths `meta init` actually records — repo-relative, one of them decorated. */
const SCAFFOLDED = [
  "metaobjects",
  ".metaobjects",
  ".metaobjects/config.json",
  ".metaobjects/AGENTS.md",
  ".claude/skills/metaobjects-authoring/SKILL.md",
  ".claude/skills/metaobjects-codegen/SKILL.md",
  "metaobjects.config.ts",
];

function captureWarnings(fn: () => void): string[] {
  const seen: string[] = [];
  const spy = spyOn(log, "warn").mockImplementation((m: string) => { seen.push(m); });
  try { fn(); } finally { spy.mockRestore(); }
  return seen;
}

describe("reportIgnoredScaffold", () => {
  test("fires when the project is NOT the process cwd (the --cwd path)", () => {
    // The regression. `root` is a tmpdir, so process.cwd() can never equal it — which is
    // the condition under which this advisory used to say nothing at all.
    gitInit();
    writeFileSync(join(root, ".gitignore"), ".claude/\n");
    expect(root).not.toBe(process.cwd());

    const warns = captureWarnings(() => reportIgnoredScaffold(root, SCAFFOLDED));
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain(".claude/");
    expect(warns[0]).toContain("2 of 7");
  });

  test("names the DIRECTORY, not every file", () => {
    gitInit();
    writeFileSync(join(root, ".gitignore"), ".claude/\n");
    const warns = captureWarnings(() => reportIgnoredScaffold(root, SCAFFOLDED));
    expect(warns[0]).not.toContain("SKILL.md");
  });

  test("silent when nothing is ignored", () => {
    gitInit();
    writeFileSync(join(root, ".gitignore"), "node_modules/\n");
    expect(captureWarnings(() => reportIgnoredScaffold(root, SCAFFOLDED))).toEqual([]);
  });

  test("silent when the project is not a git repository", () => {
    // "cannot say" must never be reported as "there is a problem".
    expect(captureWarnings(() => reportIgnoredScaffold(root, SCAFFOLDED))).toEqual([]);
  });

  test("a DECORATED entry is matched by its path, not its display text", () => {
    // `meta init` records the root-memory write as
    // "CLAUDE.md (created with MetaObjects @import)" because the same array is printed to
    // the user. Handed to git verbatim that is not a path, so a repo ignoring CLAUDE.md
    // was never told its scaffolded memory file would not be committed.
    gitInit();
    writeFileSync(join(root, ".gitignore"), "CLAUDE.md\n");
    const warns = captureWarnings(() =>
      reportIgnoredScaffold(root, ["CLAUDE.md (created with MetaObjects @import)", "metaobjects.config.ts"]),
    );
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain("1 of 2");
    expect(warns[0]).toContain("CLAUDE.md");
  });

  test("an ABSOLUTE entry is still made relative to the project", () => {
    // The signature takes `cwd` for a reason; an absolute path must not leak through as-is.
    gitInit();
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(join(root, ".gitignore"), ".claude/\n");
    const warns = captureWarnings(() =>
      reportIgnoredScaffold(root, [join(root, ".claude", "skills", "x", "SKILL.md"), "metaobjects.config.ts"]),
    );
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain(".claude/");
  });

  test("an entry OUTSIDE the project is dropped, not asked about", () => {
    gitInit();
    writeFileSync(join(root, ".gitignore"), ".claude/\n");
    const warns = captureWarnings(() =>
      reportIgnoredScaffold(root, ["../elsewhere/thing.ts", ".claude/skills/x/SKILL.md"]),
    );
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain("1 of 1");
  });
});
