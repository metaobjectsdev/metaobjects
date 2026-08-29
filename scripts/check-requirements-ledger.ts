// Gate — MetaObjects' own requirements ledger loads, verifies, and says exactly
// what we expect it to say.
//
// WHY THIS PINS WARNINGS RATHER THAN JUST CHECKING THE EXIT CODE.
// `meta verify` exits 0 on warnings, so an exit-code-only gate would pass on a
// ledger that had quietly started emitting a hundred new ones. This ledger also
// emits a KNOWN warning by construction: it omits `implementedBy` on every node
// (its subject is a solution, not a domain model, and this repo declares no
// object.entity at all), so WARN_REQUIREMENT_NOTHING_IMPLEMENTS fires on every
// live functional node — the rule is `!architectural && live &&
// !subtreeClaimsAnything(req)`. Pinning the SET of codes turns that from noise
// into a fact under test: a new code, or the known one disappearing, both fail.
//
// WHY THE TOTAL IS PINNED TOO, AND WHAT IS STILL BLIND.
// `meta verify` prints at most 20 warnings PER SECTION and then says "…and N
// more." (verify.ts:505). So the printed list is a SAMPLE, not the diagnostic
// set, and a gate reading only the printed codes cannot see a novel warning that
// landed at position 21. Errors are NOT capped — they print in full — so the
// error half of this check is sound as written.
//
// The total closes almost all of that: it is reconstructed as printed + N-more,
// so any new warning changes it and fails here even when its code was truncated
// away. What remains blind is exactly one shape — a new code REPLACING an
// existing one one-for-one, past position 20, leaving the total unchanged. That
// is stated rather than hidden, per the repo's own no-silent-caps rule. Removing
// it needs a machine-readable verify output, which is a product change and out
// of scope for this ledger.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/** The one diagnostic code this ledger is expected to emit, and why. */
const EXPECTED_WARNING = "WARN_REQUIREMENT_NOTHING_IMPLEMENTS";

/** One per LIVE FUNCTIONAL node. Deliberately a pin rather than a derivation:
 *  the summary line reports functional-vs-architectural and live-vs-retired but
 *  never crosses them, and deriving it by re-reading the ledger here would be a
 *  second parser of the thing under test. Update it when the ledger grows, in
 *  the same commit — a count that moves without anyone noticing is the failure
 *  this pin exists to prevent. Retired, planned and architectural nodes do not
 *  contribute.
 *
 *  Overridable by a positional argument for ONE caller — the self-test, which
 *  drives this gate against throwaway ledgers of a few nodes. CI invokes the
 *  gate bare, so the pin is what runs against the real ledger; there is no env
 *  var and nothing to set accidentally. */
const DEFAULT_EXPECTED_WARNING_COUNT = 111;
const EXPECTED_WARNING_COUNT = process.argv[2] !== undefined
  ? Number(process.argv[2])
  : DEFAULT_EXPECTED_WARNING_COUNT;

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

  // The real total, not the printed one. Every "…and N more." line the run
  // emitted is added back to the codes it actually printed.
  const suppressed = [...output.matchAll(/…and (\d+) more\./g)]
    .reduce((n, m) => n + Number(m[1]), 0);
  const total = codes.length + suppressed;
  if (total !== EXPECTED_WARNING_COUNT) {
    console.error(
      `requirements-ledger: ${total} warning(s), expected ${EXPECTED_WARNING_COUNT} ` +
      `(${codes.length} printed + ${suppressed} suppressed by the display cap).\n` +
      `One per live functional node. If the ledger grew, update EXPECTED_WARNING_COUNT\n` +
      `in the same commit; if it did not, something new is being reported.\n`,
    );
    console.error(output);
    return 1;
  }

  console.log(`requirements-ledger: OK — ${summary.trim()}`);
  console.log(`requirements-ledger: ${total} × ${EXPECTED_WARNING} (expected; implementedBy is omitted by design)`);
  return 0;
}

process.exit(main());
