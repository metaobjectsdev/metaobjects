// Self-test for scripts/check-requirements-ledger.ts.
//
// A gate nobody has seen fail is a gate nobody knows works. This drives the check
// against throwaway ledgers in a temp directory and asserts each one is caught.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHECK = "scripts/check-requirements-ledger.ts";
const REPO = process.cwd();

/** Run the gate with `metaobjects/meta.requirements.yaml` set to `yaml`.
 *
 *  `expectWarnings` is the gate's warning-count pin. These fixtures are a few
 *  nodes each, not the real ledger's live-functional count, so every case must
 *  say what it expects — which is also what lets one case drive the pin WRONG
 *  and prove the count check fires. */
function runAgainst(yaml: string, expectWarnings = 1): { status: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "mo-ledger-"));
  try {
    mkdirSync(join(dir, "metaobjects"), { recursive: true });
    writeFileSync(join(dir, "metaobjects", "meta.requirements.yaml"), yaml);
    const run = spawnSync("bun", [join(REPO, CHECK), `--expect-warnings=${expectWarnings}`], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: run.status ?? 1, output: `${run.stdout ?? ""}${run.stderr ?? ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const VALID = `
metadata.root:
  package: metaobjects
  children:
    - requirement.functional:
        name: root
        level: 1
        status: live
        statement: "A thing is true."
        counterexample: "The thing is not true."
`;

/** Nesting that does not strictly descend — ERR_REQUIREMENT_LEVEL_NESTING. */
const BAD_NESTING = `
metadata.root:
  package: metaobjects
  children:
    - requirement.functional:
        name: root
        level: 2
        status: live
        statement: "A thing is true."
        counterexample: "The thing is not true."
        children:
          - requirement.functional:
              name: child
              level: 2
              status: live
              statement: "Another thing is true."
              counterexample: "It is not."
`;

/** implementedBy above the L4 link floor — ERR_REQUIREMENT_LINK_ABOVE_FLOOR. */
const LINK_ABOVE_FLOOR = `
metadata.root:
  package: metaobjects
  children:
    - requirement.functional:
        name: root
        level: 1
        status: live
        statement: "A thing is true."
        counterexample: "The thing is not true."
        implementedBy: ["metaobjects::Nope"]
`;

let failures = 0;
function expect(label: string, ok: boolean, detail: string): void {
  if (ok) console.log(`  ok   ${label}`);
  else { console.error(`  FAIL ${label}\n${detail}`); failures++; }
}

console.log("test-requirements-ledger:");

const ok = runAgainst(VALID);
expect("a well-formed ledger passes", ok.status === 0, ok.output);

const nesting = runAgainst(BAD_NESTING);
expect("non-descending nesting is caught", nesting.status !== 0, nesting.output);

const floor = runAgainst(LINK_ABOVE_FLOOR);
expect("implementedBy above the link floor is caught", floor.status !== 0, floor.output);

const missing = runAgainst("");
expect("an empty ledger is caught", missing.status !== 0, missing.output);

// The count check, driven wrong on a ledger that is otherwise perfect. This is
// the case that matters most: `meta verify` prints at most 20 warnings per
// section and then truncates, so the printed codes are a sample and the TOTAL is
// what makes a warning past the cap visible at all. A gate whose count check
// never fires would leave that hole open while looking closed.
const miscounted = runAgainst(VALID, 2);
expect(
  "a wrong warning count is caught",
  miscounted.status !== 0 && miscounted.output.includes("expected 2"),
  miscounted.output,
);

// The sibling gate in the same lane takes a ledger DIRECTORY as its first positional
// argument. Passing one here used to become Number("metaobjects") — NaN — and the gate
// failed reporting "expected NaN" instead of saying the argument was wrong.
const stray = spawnSync("bun", [join(REPO, CHECK), "metaobjects"], {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
});
expect(
  "a positional argument is refused, not silently read as a count",
  (stray.status ?? 0) === 2 && `${stray.stderr}`.includes("unexpected argument"),
  `${stray.stdout}${stray.stderr}`,
);

if (failures > 0) {
  console.error(`test-requirements-ledger: ${failures} failure(s)`);
  process.exit(1);
}
console.log("test-requirements-ledger: all passed");
