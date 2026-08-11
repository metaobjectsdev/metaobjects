// Wiring pin for the capability-ledger gate (#290).
//
// The unit suite proves the validator's rules. This proves the gate is actually
// REACHED by `meta verify` and that its severities reach the exit code — the
// half a validator test cannot see. A gate that is correct and never called
// reports every repository clean.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { verifyCommand } from "../../src/commands/verify.js";
import { DEFAULT_LEDGER_PATH } from "../../src/lib/capability-ledger.js";

const FIXTURE = resolve(import.meta.dirname, "../fixtures/capability-ledger-meta");

const CLEAN = `capabilities:
  - id: SOLN
    level: 1
    statement: "The commerce solution"
  - id: SVC
    level: 3
    parent: SOLN
    status: live
    statement: "Order service records every placed order"
    violation: "A placed order absent from the service"
  - id: L4-ORDER
    level: 4
    parent: SVC
    status: live
    statement: "Orders are recorded"
    violation: "An order that is placed and never stored"
    implementedBy: [acme::shop::Order]
  - id: L4-CUSTOMER
    level: 4
    parent: SVC
    status: live
    statement: "Customers are recorded"
    violation: "A customer that cannot be found again"
    implementedBy: [acme::shop::Customer]
  - id: L4-BILLING
    level: 4
    parent: SVC
    status: live
    statement: "Billing orders are recorded"
    violation: "An invoice with no order behind it"
    implementedBy: [acme::billing::Order]
`;

describe("meta verify — capability ledger gate (#290)", () => {
  let dir: string;
  let cwdBefore: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "verify-cap-ledger-"));
    cpSync(FIXTURE, dir, { recursive: true });
    cwdBefore = process.cwd();
    process.chdir(dir);
  });
  afterEach(() => {
    process.chdir(cwdBefore);
    rmSync(dir, { recursive: true, force: true });
  });

  test("no ledger: verify is unaffected", async () => {
    expect(await verifyCommand([], dir)).toBe(0);
  });

  test("a clean ledger passes", async () => {
    writeFileSync(join(dir, DEFAULT_LEDGER_PATH), CLEAN);
    expect(await verifyCommand([], dir)).toBe(0);
  });

  test("a dangling live reference fails the build", async () => {
    writeFileSync(join(dir, DEFAULT_LEDGER_PATH), CLEAN + `  - id: STALE
    level: 4
    parent: SVC
    status: live
    statement: "Claims a node that is gone"
    violation: "The ledger cites an entity nobody declares"
    implementedBy: [acme::shop::Vanished]
`);
    expect(await verifyCommand([], dir)).toBe(1);
  });

  test("the same reference on an abandoned entry does NOT fail the build", async () => {
    // The asymmetry, end to end: an abandoned capability's nodes are supposed to
    // be gone, so its dangling reference is the entry doing its job. Paired with
    // the test above so the inversion cannot be half-broken unnoticed.
    writeFileSync(join(dir, DEFAULT_LEDGER_PATH), CLEAN + `  - id: RETIRED
    level: 4
    parent: SVC
    status: abandoned
    statement: "Turn-timer pacing, retired deliberately"
    violation: "Pacing driven by a wall clock instead of the story"
    implementedBy: [acme::shop::Vanished]
`);
    expect(await verifyCommand([], dir)).toBe(0);
  });

  test("an unknown status fails the build", async () => {
    writeFileSync(join(dir, DEFAULT_LEDGER_PATH), CLEAN + `  - id: TYPO
    level: 4
    parent: SVC
    status: abandonned
    statement: "Typo'd status"
    violation: "A status that says nothing"
    implementedBy: [acme::shop::Order]
`);
    expect(await verifyCommand([], dir)).toBe(1);
  });

  test("an unclaimed entity warns but does not fail, while the gate ships as a warning", async () => {
    writeFileSync(join(dir, DEFAULT_LEDGER_PATH), `capabilities:
  - id: SOLN
    level: 1
    statement: "The commerce solution"
`);
    expect(await verifyCommand([], dir)).toBe(0);
  });
});
