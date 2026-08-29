// Gate — MetaObjects' own requirements ledger loads, verifies, and says exactly
// what we expect it to say.
//
// WHY THIS PINS WARNINGS RATHER THAN JUST CHECKING THE EXIT CODE.
// `meta verify` exits 0 on warnings, so an exit-code-only gate would pass on a
// ledger that had quietly started emitting a hundred new ones. This ledger also
// emits a KNOWN warning by construction: it omits @implementedBy on every node
// (its subject is a solution, not a domain model, and this repo declares no
// object.entity at all), so WARN_REQUIREMENT_NOTHING_IMPLEMENTS fires on every
// live functional node — the rule is `!architectural && live &&
// !subtreeClaimsAnything(req)`. Pinning the SET of codes turns that from noise
// into a fact under test: a new code, or the known one disappearing, both fail.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/** The one diagnostic code this ledger is expected to emit, and why. */
const EXPECTED_WARNING = "WARN_REQUIREMENT_NOTHING_IMPLEMENTS";

// Resolved against THIS FILE, not the working directory: the self-test runs the
// gate from a temp directory holding a throwaway ledger, so a cwd-relative path
// to the CLI would resolve to nothing there and every case would "fail" for the
// wrong reason.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = resolve(REPO_ROOT, "server/typescript/packages/cli/bin/meta.ts");

function main(): number {
  const run = spawnSync("bun", [CLI, "verify", "--cwd", "."], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;

  if (run.status !== 0) {
    console.error("requirements-ledger: `meta verify` exited non-zero.\n");
    console.error(output);
    return 1;
  }

  // Every diagnostic code the run mentioned, in first-seen order.
  const codes = [...output.matchAll(/\b(ERR_[A-Z0-9_]+|WARN_[A-Z0-9_]+)\b/g)].map((m) => m[1]);
  const errors = codes.filter((c) => c.startsWith("ERR_"));
  if (errors.length > 0) {
    console.error(`requirements-ledger: ${errors.length} error(s): ${[...new Set(errors)].join(", ")}\n`);
    console.error(output);
    return 1;
  }

  const unexpected = [...new Set(codes.filter((c) => c !== EXPECTED_WARNING))];
  if (unexpected.length > 0) {
    console.error(
      `requirements-ledger: unexpected diagnostic code(s): ${unexpected.join(", ")}.\n` +
      `Only ${EXPECTED_WARNING} is expected. If a new code is correct, decide deliberately\n` +
      `and add it here with a reason — do not widen this check to make a run pass.\n`,
    );
    console.error(output);
    return 1;
  }

  const summary = output.split("\n").find((l) => l.includes("meta verify — requirements:"));
  if (summary === undefined) {
    console.error("requirements-ledger: no requirements summary line — did the ledger load at all?\n");
    console.error(output);
    return 1;
  }

  console.log(`requirements-ledger: OK — ${summary.trim()}`);
  console.log(`requirements-ledger: ${codes.length} × ${EXPECTED_WARNING} (expected; @implementedBy is omitted by design)`);
  return 0;
}

process.exit(main());
