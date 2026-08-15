// `meta verify` — the `@verifiedBy` check.
//
// A requirement's `@verifiedBy` names the tests that prove the behaviour. verify
// checks each name EXISTS and is NOT SKIPPED; it never runs them. Running them is
// the test runner's job, and a requirement gate that shelled out to one would be
// slow, ecosystem-specific, and wrong in CI.
//
// Until this existed, `@verifiedBy` was registered vocabulary that nothing read —
// the precise pattern ADR-0007 Amendment 2 and the `@role` shrink exist to punish.
// An attribute the loader accepts and no consumer dispatches on teaches authors
// that declaring is free and means nothing.
//
// PRECISION OVER RECALL, deliberately. The scan matches a name anywhere in the
// test corpus, as a whole word, in any language. That is the most generous
// possible reading, so a "missing" verdict means the name appears in NO test file
// at all — which is a broken claim in any ecosystem. The repo's standing rule for
// drift checks is to bias toward under-flagging, and a nagging gate gets disabled,
// which costs more than the misses.
//
// FAIL-OPEN ON INABILITY. If the project has no test files this scan can see, it
// says NOTHING rather than reporting every name missing. Absence of evidence is
// not evidence of absence, and a monorepo whose tests live outside `--cwd` must
// not be told its requirements are unverified.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
  TYPE_REQUIREMENT,
  type MetaData,
  type MetaRequirement,
} from "@metaobjectsdev/metadata";

export const ERR_REQUIREMENT_TEST_MISSING = "ERR_REQUIREMENT_TEST_MISSING";
export const WARN_REQUIREMENT_TEST_SKIPPED = "WARN_REQUIREMENT_TEST_SKIPPED";
export const WARN_REQUIREMENT_TEST_COMMENT_ONLY = "WARN_REQUIREMENT_TEST_COMMENT_ONLY";

export interface VerifiedByDiagnostic {
  severity: "error" | "warn";
  code: string;
  name?: string;
  message: string;
}

const IGNORE_SEGMENTS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", "coverage",
  ".metaobjects", "generated", "target", "bin", "obj", "__pycache__", ".venv", "venv",
]);

/** Test files across the five ecosystems this project ports to. */
const TEST_FILE = new RegExp(
  [
    "\\.(?:test|spec)\\.[cm]?[jt]sx?$", // bun / jest / vitest / mocha
    "(?:^|[./_-])[Tt]est[^/]*\\.java$", // JUnit — TestFoo.java
    "[A-Za-z0-9]Test(?:s)?\\.java$", //     JUnit — FooTest.java / FooTests.java
    "[A-Za-z0-9]Tests?\\.cs$", //           xUnit / NUnit
    "^test_[^/]*\\.py$", //                 pytest
    "[^/]*_test\\.py$", //                  pytest, trailing convention
    "[A-Za-z0-9]Test(?:s)?\\.kt$", //       Kotlin
  ].join("|"),
);

/** Markers that a test exists but is disabled, across the same ecosystems. */
const SKIP_MARKER = new RegExp(
  [
    "\\b(?:it|test|describe)\\.(?:skip|todo)\\b", // jest/vitest/bun
    "\\bx(?:it|test|describe)\\b", //               mocha/jasmine
    "@Disabled\\b", //                              JUnit 5
    "@Ignore\\b", //                                JUnit 4 / Kotlin
    "@pytest\\.mark\\.skip", //                     pytest
    "\\[Ignore[\\](]", //                           MSTest / NUnit
    "\\bSkip\\s*=", //                              xUnit  [Fact(Skip = "...")]
  ].join("|"),
);

interface TestCorpus {
  files: number;
  /** rel path -> lines, kept so a skip marker can be located near the name. */
  byFile: Map<string, string[]>;
}

function walk(dir: string, root: string, acc: TestCorpus, depth = 0): void {
  if (depth > 12) return; // pathological trees; the scan is advisory, not exhaustive
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (IGNORE_SEGMENTS.has(e.name) || e.name.startsWith(".")) continue;
      walk(join(dir, e.name), root, acc, depth + 1);
      continue;
    }
    if (!e.isFile() || !TEST_FILE.test(e.name)) continue;
    const abs = join(dir, e.name);
    try {
      if (statSync(abs).size > 512 * 1024) continue;
      acc.byFile.set(relative(root, abs).split(sep).join("/"), readFileSync(abs, "utf8").split("\n"));
      acc.files++;
    } catch {
      /* unreadable file is not a finding */
    }
  }
}

/** Every `requirement.*` node in the tree, at any nesting depth. */
function collect(root: MetaData): MetaRequirement[] {
  const out: MetaRequirement[] = [];
  const rec = (n: MetaData): void => {
    for (const c of n.children()) {
      if (c.type === TYPE_REQUIREMENT) out.push(c as MetaRequirement);
      rec(c);
    }
  };
  rec(root);
  return out;
}

/**
 * A whole-word match, so `OrderServiceTest` never satisfies a claim naming `Order`.
 *
 * `_` counts as a SEPARATOR, not a word character: pytest's `def test_OrderServiceTest`
 * plainly is the test a claim naming `OrderServiceTest` means, and refusing it would
 * emit the confident false error this scan is built to avoid. Camel-case boundaries
 * stay strict, which is what actually prevents a short name matching a longer one.
 */
/**
 * Is this whole line a comment?
 *
 * WHOLE-LINE ONLY, deliberately. Stripping from the first `//` would truncate a code
 * line containing one inside a string — a test titled with a URL is the obvious case —
 * and turn a real match into a confident false error, which is the failure this scan is
 * built to avoid. A trailing comment after code therefore still counts as code; that
 * under-flags, which is the repo's standing bias for drift checks.
 *
 * `#` is Python-only: in TypeScript it opens a private field, not a comment.
 */
function isCommentLine(line: string, file: string): boolean {
  const t = line.trimStart();
  if (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*")) return true;
  return file.endsWith(".py") && t.startsWith("#");
}

function wordRx(name: string): RegExp {
  return new RegExp(`(?:^|[^A-Za-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`);
}

/**
 * Check every `@verifiedBy` name against the project's test corpus.
 *
 * Severity mirrors `@implementedBy`: a broken claim is an ERROR on `live`/`partial`
 * and silent on `abandoned`/`superseded`, because a retired requirement naming a
 * deleted test is the entry doing its job, not drift.
 */
export function checkVerifiedBy(root: MetaData, cwd: string): VerifiedByDiagnostic[] {
  const reqs = collect(root).filter((r) => r.verifiedBy().length > 0);
  if (reqs.length === 0) return []; // opt-in by declaration

  const corpus: TestCorpus = { files: 0, byFile: new Map() };
  walk(cwd, cwd, corpus);
  if (corpus.files === 0) return []; // fail open: nothing to judge against

  const out: VerifiedByDiagnostic[] = [];
  for (const req of reqs) {
    for (const test of req.verifiedBy()) {
      const rx = wordRx(test);
      let foundIn: string | undefined;
      let skippedAt: string | undefined;
      // #293-adjacent (the `verifiedBy` audit): a name that occurs ONLY in comments
      // satisfied this scan, because the match is line-agnostic. That is how a claim
      // came to name `mountCrudRoutes`, whose single occurrence in an entire corpus was
      // inside a `// via mountCrudRoutes(...)` note. Tracked separately so the name can
      // still be reported as found (it is) while saying what it was found in.
      let commentOnlyAt: string | undefined;
      for (const [file, lines] of corpus.byFile) {
        for (let i = 0; i < lines.length; i++) {
          if (!rx.test(lines[i] ?? "")) continue;
          if (isCommentLine(lines[i] ?? "", file)) {
            commentOnlyAt ??= `${file}:${i + 1}`;
            continue;
          }
          foundIn ??= file;
          // a decorator/annotation sits above the declaration it disables
          const window = lines.slice(Math.max(0, i - 3), i + 1).join("\n");
          if (SKIP_MARKER.test(window)) skippedAt ??= `${file}:${i + 1}`;
        }
        if (foundIn !== undefined && skippedAt !== undefined) break;
      }

      // Found, but only ever in prose. Not an error — the scan's job is to catch a name
      // that has gone missing, and this one has not — but a comment proves nothing, so
      // the claim is reported rather than silently accepted.
      if (foundIn === undefined && commentOnlyAt !== undefined) {
        out.push({
          severity: "warn",
          code: WARN_REQUIREMENT_TEST_COMMENT_ONLY,
          name: req.name,
          message:
            `'verifiedBy' names '${test}', which appears only in a comment (${commentOnlyAt}) ` +
            `and in no test declaration. A comment proves nothing — name the test that asserts it.`,
        });
        continue;
      }

      if (foundIn === undefined) {
        if (req.requiresLiveNodes()) {
          out.push({
            severity: "error",
            code: ERR_REQUIREMENT_TEST_MISSING,
            name: req.name,
            message:
              `'verifiedBy' names '${test}', which appears in none of the ` +
              `${corpus.files} test file(s) found under this project. Either the test was ` +
              `renamed or removed, or the claim was never true.`,
          });
        }
        continue;
      }
      if (skippedAt !== undefined) {
        out.push({
          severity: "warn",
          code: WARN_REQUIREMENT_TEST_SKIPPED,
          name: req.name,
          message:
            `'verifiedBy' names '${test}', but it is disabled at ${skippedAt}. ` +
            `A skipped test proves nothing — the requirement reads as verified and is not.`,
        });
      }
    }
  }
  return out;
}
