#!/usr/bin/env bun
// Self-test for scripts/check-requirements-vocabulary.ts.
//
// The derived link is the whole point of Phase 2 — the requirement's NAME is the
// reference, so nobody types a link and nobody can mistype one. That only holds if
// the derivation actually refuses a name that derives nothing, a subtype promised
// twice, and an attribute its subtype does not carry. Each is driven here.
//
// The throwaway ledgers below promise almost nothing, so they ALSO fail the
// coverage half. Every case therefore asserts on the specific message rather than
// merely on a non-zero exit, or it would pass for the wrong reason.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHECK = join(process.cwd(), "scripts/check-requirements-vocabulary.ts");

function runAgainst(yaml: string): { status: number; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "mo-vocab-"));
  try {
    mkdirSync(join(dir, "metaobjects"), { recursive: true });
    writeFileSync(join(dir, "metaobjects", "meta.requirements.yaml"), yaml);
    const run = spawnSync("bun", [CHECK, join(dir, "metaobjects")], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: run.status ?? 1, output: `${run.stdout ?? ""}${run.stderr ?? ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A ledger with one L3 parent and whatever L4/L5 children the case needs. */
const ledger = (children: string): string => `
metadata.root:
  package: metaobjects
  children:
    - requirement.functional:
        name: declare
        level: 3
        status: live
        statement: "Things are declared."
        counterexample: "Nothing is declared."
        children:
${children}
`;

const l4 = (name: string, children = ""): string => `          - requirement.functional:
              name: ${name}
              level: 4
              status: live
              statement: "A thing is promised."
              counterexample: "The thing is not promised."
${children}`;

let failures = 0;
function expect(label: string, ok: boolean, detail: string): void {
  if (ok) console.log(`  ok   ${label}`);
  else { console.error(`  FAIL ${label}\n${detail}`); failures++; }
}

console.log("test-requirements-vocabulary:");

const real = spawnSync("bun", [CHECK], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
expect("the real ledger passes", (real.status ?? 1) === 0, `${real.stdout}${real.stderr}`);

const bogus = runAgainst(ledger(l4("fieldNotAThing")));
expect(
  "a name deriving no registered subtype is caught",
  bogus.output.includes("does not derive a registered subtype"),
  bogus.output,
);

const notAType = runAgainst(ledger(l4("wibbleCurrency")));
expect(
  "a name whose leading segment is not a type is caught",
  notAType.output.includes("does not derive a registered subtype"),
  notAType.output,
);

// Across two BRANCHES, deliberately. Two same-named siblings under one parent are
// not a duplicate at all — the loader's overlay merge folds them into one node, so
// the only way a subtype gets promised twice is from two different places in the
// tree. A fixture that put them side by side would have tested nothing and passed.
const dupe = runAgainst(`
metadata.root:
  package: metaobjects
  children:
    - requirement.functional:
        name: declare
        level: 3
        status: live
        statement: "Things are declared."
        counterexample: "Nothing is declared."
        children:
${l4("fieldCurrency")}    - requirement.functional:
        name: present
        level: 3
        status: live
        statement: "Things are shown."
        counterexample: "Nothing is shown."
        children:
${l4("fieldCurrency")}`);
expect(
  "one subtype promised from two branches is caught",
  dupe.output.includes("is already promised by"),
  dupe.output,
);

const badAttr = runAgainst(ledger(l4("fieldCurrency", `              children:
                - requirement.functional:
                    name: notAnAttribute
                    level: 5
                    status: live
                    statement: "An attribute is promised."
                    counterexample: "It is not."
`)));
expect(
  "an L5 naming an attribute its subtype lacks is caught",
  badAttr.output.includes("carries no attribute"),
  badAttr.output,
);

const goodAttr = runAgainst(ledger(l4("fieldCurrency", `              children:
                - requirement.functional:
                    name: currency
                    level: 5
                    status: live
                    statement: "An attribute is promised."
                    counterexample: "It is not."
`)));
expect(
  "an L5 naming a real attribute raises no attribute problem",
  !goodAttr.output.includes("carries no attribute"),
  goodAttr.output,
);

if (failures > 0) {
  console.error(`test-requirements-vocabulary: ${failures} failure(s)`);
  process.exit(1);
}
console.log("test-requirements-vocabulary: all passed");
