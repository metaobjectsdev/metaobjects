// server/typescript/packages/sdk/test/no-hardcoded-metadata-dir.test.ts
//
// THE enforcer for the rule the whole source-resolution design rests on:
//
//   `metaobjects/` is the DEFAULT VALUE of `sources` and nothing else.
//   Everywhere else reads the config, through `resolveCollection`.
//
// Eight independent call sites once hardcoded that directory; routing them
// through one authority fixed the eight, and fixed nothing about the ninth
// somebody adds next month. This test is the part that lasts. It walks the
// `sdk` and `cli` source trees and fails when a file outside the allowlist
// names the directory in CODE.
//
// Three properties keep it from becoming a gate that passes because it checks
// nothing:
//
// 1. The allowlist is file + REASON. A fifth entry costs a sentence explaining
//    why that file is allowed to know the name.
// 2. A STALE entry fails. An allowlisted file that no longer contains the
//    reference silently re-opens the hole it was covering, so the allowlist
//    must be exact in both directions.
// 3. Comments are excluded, so the paragraph explaining the rule is not itself
//    a violation — and that exclusion is tested against a real file that
//    mentions the directory only in a comment, not merely asserted.
//
// WHAT IT DOES NOT CATCH — write these down or the guard becomes a claim rather
// than a check. Measured, not assumed (each row was run):
//
//   CAUGHT   join(d, "metaobjects")            a plain literal, either quote
//   CAUGHT   `${d}/metaobjects`                a template literal, end or mid
//   CAUGHT   "no metaobjects/ here"            a message naming the directory
//   MISSED   join(d, "meta" + "objects")       any computed spelling
//   MISSED   const N = "meta"; N + "objects"   the same, through a variable
//   MISSED   "author under metaobjects"        the word with no trailing `/`
//
// The last is deliberate, not an oversight: `metaobjects` followed by a space
// is the PRODUCT name far more often than a path ("the metaobjects ledger",
// the `metaobjects:` error prefix), and three such lines were the guard's first
// false positives. No lexical rule separates them. The computed-spelling misses
// are the honest ceiling of a source-text check — this catches the way the
// violation is actually written, which is how all eight original ones were
// written, and it will not catch someone evading it on purpose.
//
// It also scans TypeScript SOURCE only: the four other language ports, the
// `docs/` tree, and JSON/YAML fixtures are outside it.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { DEFAULT_METADATA_DIR } from "../src/metadata-files.js";

/** `packages/`, so both trees are reachable from this one test file. */
const PACKAGES = resolve(import.meta.dirname, "../..");
const TREES = [join(PACKAGES, "sdk", "src"), join(PACKAGES, "cli", "src")];

/**
 * The complete set of files permitted to name the default metadata directory,
 * each with the reason it is permitted. Adding an entry is a deliberate act:
 * write down why that file needs to know, or route it through
 * `resolveCollection` instead.
 *
 * Paths are relative to `packages/`.
 */
const ALLOWED: ReadonlyMap<string, string> = new Map([
  [
    "sdk/src/metadata-files.ts",
    "the constant's single definition — DEFAULT_METADATA_DIR is declared here and nowhere else",
  ],
  [
    "sdk/src/sources.ts",
    "DEFAULT_SOURCES — THE default, the value config resolution applies when a project declares no sources",
  ],
  [
    "sdk/src/collection.ts",
    "inside resolveCollection, the one authority: it APPLIES that default (the does-it-exist probe and the ERR_COLLECTION_NOT_FOUND text naming it)",
  ],
  [
    "sdk/src/index.ts",
    "package barrel — a bare re-export of the constant, so `meta init` can import it instead of restating the literal. No use.",
  ],
  [
    "cli/src/commands/init.ts",
    "the scaffolder WRITING the default layout — creating that directory, never assuming one exists",
  ],
  [
    "sdk/src/agent-docs/body.ts",
    "the agent-docs PROSE `meta init` scaffolds beside that layout — documentation content, reachable by no read path; it teaches the default a fresh project gets. A project that declares `sources` elsewhere is given docs that name the default, which is a known wording gap, not a resolution one.",
  ],
]);

// ---------------------------------------------------------------------------
// Comment stripping
// ---------------------------------------------------------------------------

/**
 * Blank out `//` and block comments, preserving every newline so reported line
 * numbers stay true.
 *
 * String and template literals are tracked so a `//` inside one is not mistaken
 * for a comment (`"https://example.com"` must keep its text). Quote states also
 * reset at a newline: an unterminated quote — which the stripper could only
 * reach by mis-scanning something exotic — then costs one line rather than the
 * rest of the file.
 */
function stripComments(src: string): string {
  type State = "code" | "line" | "block" | "sq" | "dq" | "tpl";
  let state: State = "code";
  const out: string[] = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    const next = src[i + 1];
    if (state === "code") {
      if (c === "/" && next === "/") { state = "line"; out.push(" ", " "); i++; continue; }
      if (c === "/" && next === "*") { state = "block"; out.push(" ", " "); i++; continue; }
      if (c === "'") state = "sq";
      else if (c === '"') state = "dq";
      else if (c === "`") state = "tpl";
      out.push(c);
      continue;
    }
    if (state === "line") {
      if (c === "\n") { state = "code"; out.push(c); } else out.push(" ");
      continue;
    }
    if (state === "block") {
      if (c === "*" && next === "/") { state = "code"; out.push(" ", " "); i++; continue; }
      out.push(c === "\n" ? c : " ");
      continue;
    }
    // sq / dq / tpl — literal text is kept verbatim; the opening quote was
    // consumed by the `code` branch above, so a matching quote here CLOSES.
    out.push(c);
    if (c === "\\" && next !== undefined) { out.push(next); i++; continue; }
    const closer = state === "sq" ? "'" : state === "dq" ? '"' : "`";
    if (c === closer) { state = "code"; continue; }
    if (c === "\n" && state !== "tpl") state = "code";
  }
  return out.join("");
}

// ---------------------------------------------------------------------------
// Violation detection
// ---------------------------------------------------------------------------

/** A preceding character meaning the word is part of a LONGER token, or names
 *  the STATE directory rather than the metadata one: `.metaobjects` (a fixed
 *  convention with its own constant), `@metaobjectsdev/sdk`. */
const NOT_A_DIR_BEFORE = /[A-Za-z0-9_.@]/;

/** A following character meaning this really is a path segment: a separator, or
 *  the quote that ends the literal (`join(d, "metaobjects")`).
 *
 *  Everything else is the PRODUCT name in prose — "the metaobjects ledger",
 *  "reach for metaobjects metadata", the `metaobjects:` error prefix — or a
 *  longer token (`metaobjectsdev`, `metaobjects.config.ts`,
 *  `metaobjects-authoring`). Requiring this is what keeps the guard from
 *  convicting the product's own name, and it is also the guard's sharpest
 *  limit: a message that says "under metaobjects" with no trailing slash is
 *  indistinguishable, lexically, from prose about the product. */
const PATH_SEGMENT_AFTER = /[/"'`]/;

/** Every line of `code` naming the default directory, as a path literal or via
 *  the constant. `code` must already have its comments stripped. */
function violationLines(code: string): number[] {
  const hits = new Set<number>();
  const lineOf = (index: number): number => code.slice(0, index).split("\n").length;

  for (const m of code.matchAll(/DEFAULT_METADATA_DIR/g)) hits.add(lineOf(m.index));

  for (const m of code.matchAll(new RegExp(DEFAULT_METADATA_DIR, "g"))) {
    const before = m.index === 0 ? "" : code[m.index - 1]!;
    const after = code[m.index + DEFAULT_METADATA_DIR.length] ?? "";
    if (NOT_A_DIR_BEFORE.test(before)) continue;
    if (!PATH_SEGMENT_AFTER.test(after)) continue;
    hits.add(lineOf(m.index));
  }
  return [...hits].sort((a, b) => a - b);
}

async function tsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await tsFiles(full)));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** Every scanned file naming the directory in code, keyed by `packages/`-relative
 *  path (always `/`-separated, so the allowlist reads the same on any platform). */
async function scan(): Promise<Map<string, number[]>> {
  const found = new Map<string, number[]>();
  for (const tree of TREES) {
    for (const file of await tsFiles(tree)) {
      const lines = violationLines(stripComments(readFileSync(file, "utf8")));
      if (lines.length > 0) found.set(relative(PACKAGES, file).split(sep).join("/"), lines);
    }
  }
  return found;
}

describe("`metaobjects/` is a config default and nothing else", () => {
  test("no file outside the allowlist names the default metadata directory", async () => {
    const offenders = [...(await scan()).entries()]
      .filter(([file]) => !ALLOWED.has(file))
      .map(([file, lines]) => `${file}:${lines.join(",")}`);
    expect(offenders).toEqual([]);
  });

  test("every allowlisted file still contains the reference it was allowed for", async () => {
    const found = await scan();
    // A stale entry is not cosmetic: it is an allowlisted hole nobody is
    // watching, and the next file to take that path inherits the exemption.
    expect([...ALLOWED.keys()].filter((f) => !found.has(f))).toEqual([]);
  });

  test("every allowlist entry carries a reason", () => {
    expect([...ALLOWED].filter(([, why]) => why.trim().length < 20).map(([f]) => f)).toEqual([]);
  });

  test("a comment-only mention is not a violation — proven against a real file", () => {
    // `detect-stack.ts` explains, in a comment, that it reads the resolved
    // collection "rather than assuming `metaobjects/`". Saying so is the
    // opposite of a violation, and the guard must not convict it.
    const file = join(PACKAGES, "cli", "src", "lib", "detect-stack.ts");
    const raw = readFileSync(file, "utf8");
    expect(raw).toContain(`${DEFAULT_METADATA_DIR}/`); // the mention is really there
    expect(violationLines(stripComments(raw))).toEqual([]); // and it is in a comment
  });

  test("the stripper removes comments without eating code", () => {
    const cases: [string, boolean][] = [
      [`// join(dir, "${DEFAULT_METADATA_DIR}")`, false],
      [`/* a ${DEFAULT_METADATA_DIR}/ tree */`, false],
      [`/** ${DEFAULT_METADATA_DIR}/ */\nconst a = 1;`, false],
      [`const p = join(dir, "${DEFAULT_METADATA_DIR}");`, true],
      [`const p = \`\${d}/${DEFAULT_METADATA_DIR}\`;`, true],
      [`const msg = "no ${DEFAULT_METADATA_DIR}/ here";`, true],
      // A `//` inside a string is not a comment: the literal must survive.
      [`const u = "https://x/${DEFAULT_METADATA_DIR}/y";`, true],
      // Longer tokens that merely contain the word are never violations.
      [`import x from "@${DEFAULT_METADATA_DIR}dev/sdk";`, false],
      [`const f = "${DEFAULT_METADATA_DIR}.config.ts";`, false],
      [`const d = ".${DEFAULT_METADATA_DIR}/config.json";`, false],
      [`const s = ".claude/skills/${DEFAULT_METADATA_DIR}-authoring";`, false],
      // The PRODUCT name in prose is not a directory reference. This is the
      // guard's deliberate blind spot, pinned so it stays deliberate.
      [`log.error("the ${DEFAULT_METADATA_DIR} ledger is absent");`, false],
      [`throw new Error("${DEFAULT_METADATA_DIR}: could not resolve");`, false],
    ];
    for (const [src, isViolation] of cases) {
      expect(violationLines(stripComments(src)).length > 0).toBe(isViolation);
    }
  });
});
