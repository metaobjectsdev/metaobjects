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
 * ── The pre-existing debt is PINNED, not excluded ───────────────────────────────
 *
 * `scripts/site/` carries 14 errors that predate this gate, all `noUncheckedIndexedAccess`
 * index-access narrowing in real matching and highlighting logic. Fixing them means
 * understanding invariants tsc cannot see, and a careless `!` there would mask a real
 * bug — so it is its own task.
 *
 * Excluding that directory would have made the gate read as full coverage while
 * silently covering less, which is the failure this repository has a rule against. So
 * the debt is pinned instead: everything outside `scripts/site/` must be CLEAN, and
 * `scripts/site/` may carry at most the known count. New errors fail wherever they
 * land, the debt can only shrink, and when it shrinks the gate says so and asks for
 * the pin to be tightened.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/** Pre-existing, all in `scripts/site/`. Lower this when you fix some; never raise it. */
const KNOWN_SITE_ERRORS = 14;
const DEBT_DIR = "scripts/site/";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function main(): number {
  const run = spawnSync(
    "node_modules/.bin/tsc",
    ["-p", "tsconfig.scripts.json"],
    { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const errors = output.split("\n").filter((l) => /error TS\d+:/.test(l));

  const fresh = errors.filter((l) => !l.startsWith(DEBT_DIR));
  if (fresh.length > 0) {
    console.error(`scripts-typecheck: ${fresh.length} type error(s) outside the known debt:\n`);
    for (const e of fresh) console.error(`  ${e}`);
    console.error(
      `\nscripts/ is not covered by any package tsconfig, which is how two accessor\n` +
      `defects shipped in one session. Fix the error; do not widen this gate.\n`,
    );
    return 1;
  }

  const debt = errors.length - fresh.length;
  if (debt > KNOWN_SITE_ERRORS) {
    console.error(
      `scripts-typecheck: ${DEBT_DIR} now has ${debt} type error(s), up from the pinned ` +
      `${KNOWN_SITE_ERRORS}.\nThe pre-existing debt may shrink, never grow.\n`,
    );
    for (const e of errors) console.error(`  ${e}`);
    return 1;
  }
  if (debt < KNOWN_SITE_ERRORS) {
    console.error(
      `scripts-typecheck: ${DEBT_DIR} is down to ${debt} error(s) from ${KNOWN_SITE_ERRORS}. ` +
      `Lower KNOWN_SITE_ERRORS in this file to lock the improvement in.\n`,
    );
    return 1;
  }

  console.log(
    `scripts-typecheck: OK — scripts/ is clean outside ${DEBT_DIR}, which holds ` +
    `${debt} pinned pre-existing error(s).`,
  );
  return 0;
}

process.exit(main());
