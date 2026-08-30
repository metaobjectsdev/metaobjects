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
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function main(): number {
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
