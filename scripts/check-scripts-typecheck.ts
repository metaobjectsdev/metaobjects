#!/usr/bin/env bun
/**
 * Gate — repo-root `scripts/` typechecks.
 *
 * `bun test` transpiles per file and never typechecks, and `bun run --filter '*'
 * typecheck` walks WORKSPACE PACKAGES only. So everything under `scripts/` — including
 * every CI gate in the `gates` lane — was never typechecked by anything.
 *
 * That gap has already cost twice, in one session: `node.title` was read as an
 * accessor that does not exist on `MetaData`, so it was always `undefined` and the
 * tool silently reported a node's NAME where it meant the authored title; and the
 * requirement harness read its two prose fields through accessors that do not exist,
 * emitting 109 empty slots and reporting success. Both are one `tsc` run away from
 * being impossible.
 *
 * ── The debt this gate landed with is GONE ──────────────────────────────────────
 *
 * `scripts/site/` carried 14 pre-existing `noUncheckedIndexedAccess` errors in real
 * subsequence-matching and highlighting logic. They were PINNED rather than excluded —
 * excluding the directory would have made the gate read as full coverage while
 * silently covering less, which is the failure this repository has a rule against.
 *
 * They are all fixed, so the pin is gone with them. Every one was closed by removing
 * the possibility (`?.` over a `.length` guard tsc cannot connect to the index, an
 * `entries()` walk over a manual counter, one checked accessor for two mandatory regex
 * groups) rather than by asserting it away — a careless `!` there would have masked a
 * real bug, which is why it was its own task. Byte-identical output was proven against
 * the 97 real YAML corpora plus a 10k-case fuzz before the pin came down.
 *
 * `scripts/` is now clean, full stop. There is deliberately no mechanism to admit new
 * debt: an error fails wherever it lands.
 *
 * ── Second half: a file cannot ESCAPE the gate ─────────────────────────────────
 *
 * "Typechecks clean" and "is typechecked" are different claims, and this gate only ever
 * made the first. `tsconfig.scripts.json` includes `scripts/**\/*.ts` and a NAMED list of
 * `.mjs`, because eight unannotated top-level `.mjs` scripts would produce 133 errors and
 * are deliberately out. So a NEW `.mjs` — written with JSDoc types, believed covered —
 * lands outside every include pattern and this gate prints OK without reading it.
 *
 * That is exactly what happened to `scripts/finish-release.mjs`, 172 lines deciding
 * whether a release tag is cut. It was authored JSDoc-typed, `bun scripts/check-scripts-
 * typecheck.ts` reported clean, and `tsc --listFilesOnly` never mentioned the file.
 *
 * So the gate now also asserts COVERAGE: any `scripts/**\/*.mjs` carrying a JSDoc type
 * annotation must be one tsc actually reads. Annotation is the signal deliberately —
 * writing `@type` or `@param` states an intent to be checked, while the eight legacy
 * files carry none and stay silently out until someone annotates one, at which point
 * this fails and asks for it to be included.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every `.mjs` under scripts/, repo-relative. */
function mjsFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) found.push(...mjsFiles(full));
    else if (name.endsWith(".mjs")) found.push(relative(REPO_ROOT, full));
  }
  return found;
}

/**
 * A JSDoc type annotation is the author saying "check me".
 *
 * Matched on the tag rather than on any `.mjs`, so the eight legacy unannotated scripts
 * stay out without an allowlist that would rot. Annotate one and this fails, which is the
 * intended prompt to add it to the include.
 *
 * Matches BOTH JSDoc forms, and the first draft did not — it required a leading `*`, so it
 * saw only the multi-line block form and missed one-liners (`/** @type {...} *\/`). That is
 * the form `finish-release.mjs` uses throughout, i.e. the check would have missed the exact
 * file that motivated it, and it looked correct because a DIFFERENT file happened to carry
 * a multi-line `@param` and got flagged. Proven now in both directions instead of one.
 */
const ANNOTATED = /\/\*\*[\s\S]*?@(type|param|returns|typedef)\b/;

function main(): number {
  // COVERAGE first: a file tsc never reads cannot produce an error, so an unread file
  // would otherwise be indistinguishable from a clean one.
  const read = new Set(
    spawnSync("node_modules/.bin/tsc", ["-p", "tsconfig.scripts.json", "--listFilesOnly"],
      { cwd: REPO_ROOT, encoding: "utf8" }).stdout
      ?.split("\n").map((l) => relative(REPO_ROOT, l.trim())).filter(Boolean) ?? []);

  const escaped = mjsFiles(join(REPO_ROOT, "scripts"))
    .filter((f) => ANNOTATED.test(readFileSync(join(REPO_ROOT, f), "utf8")))
    .filter((f) => !read.has(f));

  if (escaped.length > 0) {
    console.error(
      `scripts-typecheck: ${escaped.length} annotated .mjs file(s) are NOT typechecked:\n` +
      escaped.map((f) => `  ${f}`).join("\n") +
      `\n\n  They carry JSDoc types, so they are meant to be checked — but they match no\n` +
      `  include pattern in tsconfig.scripts.json, and tsc reporting no errors for a file\n` +
      `  it never opened reads exactly like a clean one. Add each to "include".\n`);
    return 1;
  }

  const run = spawnSync(
    "node_modules/.bin/tsc",
    ["-p", "tsconfig.scripts.json"],
    { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const errors = output.split("\n").filter((l) => /error TS\d+:/.test(l));

  if (errors.length > 0) {
    console.error(`scripts-typecheck: ${errors.length} type error(s):\n`);
    for (const e of errors) console.error(`  ${e}`);
    console.error(
      `\nscripts/ is not covered by any package tsconfig, which is how two accessor\n` +
      `defects shipped in one session. Fix the error; do not widen this gate.\n`,
    );
    return 1;
  }

  console.log("scripts-typecheck: OK — scripts/ typechecks clean.");
  return 0;
}

process.exit(main());
