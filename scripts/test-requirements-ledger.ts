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

/** Run the gate with `metaobjects/meta.requirements.yaml` set to `yaml`. */
function runAgainst(yaml: string): { status: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "mo-ledger-"));
  try {
    mkdirSync(join(dir, "metaobjects"), { recursive: true });
    writeFileSync(join(dir, "metaobjects", "meta.requirements.yaml"), yaml);
    const run = spawnSync("bun", [join(REPO, CHECK)], {
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
function expect(label: string, condition: boolean, detail: string): void {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    console.error(`  FAIL ${label}\n${detail}`);
    failures++;
  }
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

if (failures > 0) {
  console.error(`test-requirements-ledger: ${failures} failure(s)`);
  process.exit(1);
}
console.log("test-requirements-ledger: all passed");
