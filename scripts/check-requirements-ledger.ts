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
// WHY THE TOTAL IS PINNED TOO, AND WHY THIS GATE NO LONGER SCRAPES TEXT.
// This check used to read `meta verify`'s HUMAN output and reconstruct the total
// as "codes printed + the N in each '…and N more.' line", because the text
// output caps each section at 20 warnings. That left exactly one shape blind: a
// new code REPLACING an existing one one-for-one past position 20, leaving the
// total unchanged. The header said so, and said closing it "needs a
// machine-readable verify output, which is a product change".
//
// That product change shipped: `meta verify --format json` emits every gate's
// verdict and every requirement diagnostic UNCAPPED. So the gate reads the
// payload, and the blind spot is gone — the diagnostic SET is compared, not a
// sample of it, and the total is counted rather than reconstructed.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { REPO_ROOT } from "./lib/requirement-vocabulary.js";

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
 *  Overridable by `--expect-warnings=<n>` for ONE caller — the self-test, which
 *  drives this gate against throwaway ledgers of a few nodes. CI invokes the gate
 *  bare, so the pin is what runs against the real ledger.
 *
 *  A NAMED flag, not a positional one. The sibling gate beside this in the same lane
 *  reads its first POSITIONAL argument as a ledger directory, so
 *  `check-requirements-ledger.ts metaobjects` — the invocation a reader infers from
 *  the neighbour — became `Number("metaobjects")`, i.e. NaN. Every comparison against
 *  NaN is unequal, so the gate failed reporting "expected NaN" and a remedy paragraph
 *  about updating the pin. */
const DEFAULT_EXPECTED_WARNING_COUNT = 148;

function expectedWarnings(argv: readonly string[]): number {
  const flag = argv.find((a) => a.startsWith("--expect-warnings="));
  if (flag === undefined) {
    const stray = argv.find((a) => !a.startsWith("--"));
    if (stray !== undefined) {
      console.error(
        `requirements-ledger: unexpected argument '${stray}'. This gate takes only\n` +
        `--expect-warnings=<n>, and does NOT take a ledger directory — that is\n` +
        `check-requirements-vocabulary.ts, which sits beside it in the same lane.\n`,
      );
      process.exit(2);
    }
    return DEFAULT_EXPECTED_WARNING_COUNT;
  }
  const n = Number(flag.slice("--expect-warnings=".length));
  if (!Number.isInteger(n) || n < 0) {
    console.error(`requirements-ledger: --expect-warnings must be a non-negative integer, got '${flag}'.\n`);
    process.exit(2);
  }
  return n;
}

const EXPECTED_WARNING_COUNT = expectedWarnings(process.argv.slice(2));

// REPO_ROOT (shared with the sibling gates, resolved against THAT FILE rather than the
// working directory) is what makes this safe to resolve here too: the self-test runs
// the gate from a temp directory holding a throwaway ledger, so a cwd-relative path to
// the CLI would resolve to nothing there and every case would "fail" for the wrong
// reason.
const CLI = resolve(REPO_ROOT, "server/typescript/packages/cli/bin/meta.ts");

/** The requirement diagnostics `meta verify --format json` reports. Mirrors the
 *  CLI's `AdvisoryDiagnosticRow`; declared here rather than imported because this
 *  gate consumes the CLI as a PRODUCT — over a process boundary, the same way an
 *  adopter does — and importing its internals would make the gate pass on a shape
 *  no published CLI actually emits. */
interface DiagnosticRow {
  code: string;
  path: string;
  severity: string;
  source: string;
  message: string;
}

function main(): number {
  // --format json, not the human text: the payload carries EVERY diagnostic, so
  // the set under test is the real one rather than the first 20 of each section.
  const run = spawnSync("bun", [CLI, "verify", "--format", "json", "--cwd", "."], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = run.stdout ?? "";
  const output = `${stdout}${run.stderr ?? ""}`;

  if (run.status !== 0) {
    console.error("requirements-ledger: `meta verify` exited non-zero.\n");
    console.error(output);
    return 1;
  }

  let payload: { requirements?: { status?: string; rows?: DiagnosticRow[] }; summary?: string };
  try {
    payload = JSON.parse(stdout) as typeof payload;
  } catch {
    // A parse failure means verify put something other than one document on
    // stdout. Reported loudly rather than degraded into a text scrape: a gate
    // that silently falls back to the weaker check is a gate that stops testing
    // what it claims to.
    console.error(
      "requirements-ledger: `meta verify --format json` did not emit parseable JSON on stdout.\n",
    );
    console.error(output);
    return 1;
  }

  const section = payload.requirements;
  if (section?.status !== "ran" || section.rows === undefined) {
    console.error(
      `requirements-ledger: the payload's requirements section did not run ` +
      `(status '${section?.status ?? "absent"}') — did the ledger load at all?\n`,
    );
    console.error(output);
    return 1;
  }
  const rows = section.rows;

  const errors = rows.filter((r) => r.severity === "error");
  if (errors.length > 0) {
    const codes = [...new Set(errors.map((e) => e.code))];
    console.error(`requirements-ledger: ${errors.length} error(s): ${codes.join(", ")}\n`);
    console.error(output);
    return 1;
  }

  const warnings = rows.filter((r) => r.severity === "warn");
  const unexpected = [...new Set(warnings.map((w) => w.code).filter((c) => c !== EXPECTED_WARNING))];
  if (unexpected.length > 0) {
    console.error(
      `requirements-ledger: unexpected diagnostic code(s): ${unexpected.join(", ")}.\n` +
      `Only ${EXPECTED_WARNING} is expected. If a new code is correct, decide deliberately\n` +
      `and add it here with a reason — do not widen this check to make a run pass.\n`,
    );
    console.error(output);
    return 1;
  }

  // The summary line still comes from the human narration (stderr in a structured
  // run) — it is a sentence for a person, and the payload carries the same counts
  // as fields for everything this gate actually decides on.
  const summary = output.split("\n").find((l) => l.includes("meta verify — requirements:"));
  if (summary === undefined) {
    console.error("requirements-ledger: no requirements summary line — did the ledger load at all?\n");
    console.error(output);
    return 1;
  }

  // Counted, not reconstructed: the payload is uncapped.
  const total = warnings.length;
  if (total !== EXPECTED_WARNING_COUNT) {
    console.error(
      `requirements-ledger: ${total} warning(s), expected ${EXPECTED_WARNING_COUNT}.\n` +
      `One per live functional node. If the ledger grew, update EXPECTED_WARNING_COUNT\n` +
      `in the same commit; if it did not, something new is being reported.\n`,
    );
    console.error(output);
    return 1;
  }

  // The narration reaches stderr with the CLI's own `meta: ` prefix in a structured
  // run; strip it so this gate's OK line reads as one sentence.
  console.log(`requirements-ledger: OK — ${summary.trim().replace(/^meta: /, "")}`);
  console.log(`requirements-ledger: ${total} × ${EXPECTED_WARNING} (expected; implementedBy is omitted by design)`);
  return 0;
}

process.exit(main());
