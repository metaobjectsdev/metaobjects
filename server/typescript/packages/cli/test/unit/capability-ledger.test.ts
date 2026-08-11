// Capability ledger (#290) — schema, status enum, the link boundary, and
// status-conditional reference resolution.
//
// THE FALSE-CONFIDENCE BOUNDARY. A green run here proves REFERENTIAL INTEGRITY:
// statuses parse, levels are in range, links sit at or below the link floor, and
// references resolve against the loaded model. It cannot prove that a status is
// TRUE, or that a node actually implements the capability claiming it. No test
// can. That truth is the adopter's job, and no amount of green here substitutes
// for it.

import { describe, test, expect } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { loadMemory } from "@metaobjectsdev/sdk";
import type { MetaData } from "@metaobjectsdev/metadata";
import {
  loadCapabilityLedger,
  validateCapabilityLedger,
  splitMemberRef,
  CAPABILITY_STATUSES,
  OBJECT_COVERAGE_SEVERITY,
  LINK_FLOOR_LEVEL,
  MAX_LEVEL,
  LEDGER_PATH,
  ERR_LEDGER_PARSE,
  ERR_LEDGER_DUPLICATE_ID,
  ERR_LEDGER_BAD_STATUS,
  ERR_LEDGER_BAD_LEVEL,
  ERR_LEDGER_LINK_ABOVE_FLOOR,
  ERR_LEDGER_DANGLING_REF,
  ERR_LEDGER_BAD_PARENT,
  ERR_LEDGER_L4_NOT_OBJECT,
  ERR_LEDGER_L5_NOT_MEMBER,
  ERR_LEDGER_ARCH_NO_IMPLEMENTERS,
  ERR_LEDGER_MISSING_VIOLATION,
  WARN_LEDGER_OBJECT_UNCLAIMED,
  type Diagnostic,
} from "../../src/lib/capability-ledger.js";

const FIXTURE = resolve(import.meta.dirname, "../fixtures/capability-ledger-meta");

/** A ledger claiming both fixture entities, so the coverage gate stays quiet and
 *  each test's own entries are the only thing under measurement. */
const COVER = `
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
  - id: L4-BILLING-ORDER
    level: 4
    parent: SVC
    status: live
    statement: "Billing orders are recorded"
    violation: "An invoice with no order behind it"
    implementedBy: [acme::billing::Order]
`;

const SPINE = `
  - id: SOLN
    level: 1
    statement: "The commerce solution"
  - id: APP
    level: 2
    parent: SOLN
    status: live
    statement: "Storefront application"
    violation: "The storefront is unreachable"
  - id: SVC
    level: 3
    parent: APP
    status: live
    statement: "Order service records every placed order"
    violation: "A placed order absent from the service"
`;

let cachedRoot: MetaData | undefined;
async function fixtureRoot(): Promise<MetaData> {
  if (cachedRoot === undefined) cachedRoot = await loadMemory(FIXTURE);
  return cachedRoot;
}

/** Write a ledger body into a throwaway copy of the fixture and validate it. */
async function check(yaml: string): Promise<Diagnostic[]> {
  const dir = mkdtempSync(join(tmpdir(), "cap-ledger-"));
  try {
    cpSync(FIXTURE, dir, { recursive: true });
    const p = join(dir, LEDGER_PATH);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, yaml);
    return validateCapabilityLedger(loadCapabilityLedger(dir), await fixtureRoot());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const codes = (d: Diagnostic[]): string[] => d.map((x) => x.code);
const errors = (d: Diagnostic[]): Diagnostic[] => d.filter((x) => x.severity === "error");

describe("capability ledger — presence", () => {
  test("an absent ledger is silent: the feature is opt-in by existence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cap-ledger-none-"));
    try {
      cpSync(FIXTURE, dir, { recursive: true });
      const ledger = loadCapabilityLedger(dir);
      expect(ledger.present).toBe(false);
      expect(validateCapabilityLedger(ledger, await fixtureRoot())).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a fully-claimed ledger is clean", async () => {
    const d = await check(`capabilities:${SPINE}${COVER}`);
    expect(d).toEqual([]);
  });
});

describe("capability ledger — the status x resolution matrix", () => {
  // ONE table-driven matrix, not four separate tests. The asymmetry INVERTS as a
  // pair: dangling is an error on live/partial and silent on abandoned/superseded.
  // A partial test set stays green straight through that inversion, which is
  // exactly how a broken pair survives review.
  const RESOLVES = "acme::shop::Order";
  const DANGLING = "acme::shop::Nonexistent";

  const cases: Array<{ status: string; ref: string; expectDangling: boolean }> = [];
  for (const status of CAPABILITY_STATUSES) {
    const requiresLiveNodes = status === "live" || status === "partial";
    cases.push({ status, ref: RESOLVES, expectDangling: false });
    cases.push({ status, ref: DANGLING, expectDangling: requiresLiveNodes });
  }

  test("covers all 8 cells", () => {
    expect(cases.length).toBe(CAPABILITY_STATUSES.length * 2);
  });

  for (const c of cases) {
    const label = c.ref === RESOLVES ? "resolves" : "dangling";
    test(`${c.status} x ${label} -> ${c.expectDangling ? "error" : "no diagnostic"}`, async () => {
      const d = await check(`capabilities:${SPINE}${COVER}
  - id: UNDER-TEST
    level: 4
    parent: SVC
    status: ${c.status}
    statement: "Under test"
    violation: "The thing under test is broken"
    implementedBy: ["${c.ref}"]
`);
      const dangling = d.filter((x) => x.code === ERR_LEDGER_DANGLING_REF);
      expect(dangling.length).toBe(c.expectDangling ? 1 : 0);
      if (c.expectDangling) expect(dangling[0]!.severity).toBe("error");
    });
  }
});

describe("capability ledger — status enum", () => {
  test("an unknown status is a hard error, not a silently-ignored string", async () => {
    const d = await check(`capabilities:${SPINE}${COVER}
  - id: TYPO
    level: 4
    parent: SVC
    status: abandonned
    statement: "Typo'd status"
    violation: "The status says nothing"
    implementedBy: [acme::shop::Order]
`);
    expect(codes(d)).toContain(ERR_LEDGER_BAD_STATUS);
    expect(errors(d).length).toBeGreaterThan(0);
  });

  test("an unknown status does NOT inherit the abandoned exemption", async () => {
    // The failure this pins: a typo'd status silently taking the lenient branch
    // would disable the dangling check — the exact way a typo turns the one
    // evidence-backed field off.
    const d = await check(`capabilities:${SPINE}${COVER}
  - id: TYPO
    level: 4
    parent: SVC
    status: abandonned
    statement: "Typo'd status"
    violation: "The status says nothing"
    implementedBy: [acme::shop::Nonexistent]
`);
    expect(codes(d)).toContain(ERR_LEDGER_DANGLING_REF);
  });
});

describe("capability ledger — the link boundary", () => {
  test(`implementedBy above L${LINK_FLOOR_LEVEL} is an error`, async () => {
    for (const level of [1, 2, 3]) {
      const d = await check(`capabilities:${SPINE}${COVER}
  - id: TOO-HIGH
    level: ${level}
    parent: SOLN
    status: live
    statement: "Links too high"
    violation: "Organisational tiers reach into the model"
    implementedBy: [acme::shop::Order]
`);
      expect(codes(d)).toContain(ERR_LEDGER_LINK_ABOVE_FLOOR);
    }
  });

  test(`L${LINK_FLOOR_LEVEL} references an object, not a member`, async () => {
    const d = await check(`capabilities:${SPINE}${COVER}
  - id: L4-MEMBER
    level: 4
    parent: SVC
    status: live
    statement: "Wrong grain"
    violation: "An object-grain entry naming a field"
    implementedBy: [acme::shop::Order.reference]
`);
    expect(codes(d)).toContain(ERR_LEDGER_L4_NOT_OBJECT);
  });

  test(`L${MAX_LEVEL} references a member, not an object`, async () => {
    const d = await check(`capabilities:${SPINE}${COVER}
  - id: L5-OBJECT
    level: 5
    parent: L4-ORDER
    status: live
    statement: "Wrong grain"
    violation: "A member-grain entry naming an object"
    implementedBy: [acme::shop::Order]
`);
    expect(codes(d)).toContain(ERR_LEDGER_L5_NOT_MEMBER);
  });

  test(`L${MAX_LEVEL} resolves a dotted member reference`, async () => {
    const d = await check(`capabilities:${SPINE}${COVER}
  - id: L5-OK
    level: 5
    parent: L4-ORDER
    status: live
    statement: "Order reference is human-transcribable"
    violation: "A reference a customer cannot read down a phone line"
    implementedBy: [acme::shop::Order.reference]
`);
    expect(d).toEqual([]);
  });

  test(`a dangling MEMBER on a live L${MAX_LEVEL} entry is caught`, async () => {
    // The object half resolves; only the member is gone. Pinned because a
    // resolver that stopped at the object would report this clean.
    const d = await check(`capabilities:${SPINE}${COVER}
  - id: L5-GONE
    level: 5
    parent: L4-ORDER
    status: live
    statement: "Renamed out from under the ledger"
    violation: "The ledger cites a field that no longer exists"
    implementedBy: [acme::shop::Order.wasRenamed]
`);
    expect(codes(d)).toContain(ERR_LEDGER_DANGLING_REF);
  });

  test("levels outside 1-5 are rejected", async () => {
    const d = await check(`capabilities:${SPINE}${COVER}
  - id: L6
    level: 6
    parent: SVC
    status: live
    statement: "Off the ladder"
    violation: "A level nobody defined"
`);
    expect(codes(d)).toContain(ERR_LEDGER_BAD_LEVEL);
  });
});

describe("capability ledger — reference resolution semantics", () => {
  test("an exact FQN binds", async () => {
    const d = await check(`capabilities:${SPINE}${COVER}`);
    expect(d).toEqual([]);
  });

  test("a bare name that exists in two packages does NOT bind", async () => {
    // Fail-closed (#244 / ADR-0042): a ledger entry has no package of its own,
    // so a bare ref can only bind a root-level object. `Order` exists in
    // acme::shop AND acme::billing; binding either would be a coin flip that
    // silently claims the wrong table.
    const d = await check(`capabilities:${SPINE}${COVER}
  - id: BARE
    level: 4
    parent: SVC
    status: live
    statement: "Bare ref"
    violation: "A bare name binding whichever package loaded first"
    implementedBy: [Order]
`);
    const dangling = d.filter((x) => x.code === ERR_LEDGER_DANGLING_REF);
    expect(dangling.length).toBe(1);
    // The did-you-mean hint names both candidates so the author can qualify it.
    expect(dangling[0]!.message).toContain("acme::shop::Order");
    expect(dangling[0]!.message).toContain("acme::billing::Order");
  });

  test("splitMemberRef splits at the first dot after the package", () => {
    expect(splitMemberRef("acme::shop::Order")).toEqual({ owner: "acme::shop::Order", path: [] });
    expect(splitMemberRef("acme::shop::Order.total")).toEqual({
      owner: "acme::shop::Order", path: ["total"],
    });
    expect(splitMemberRef("acme::shop::Order.total.display")).toEqual({
      owner: "acme::shop::Order", path: ["total", "display"],
    });
    expect(splitMemberRef("Order.total")).toEqual({ owner: "Order", path: ["total"] });
  });
});

describe("capability ledger — loud failures", () => {
  test("a duplicate capability id fails", async () => {
    const d = await check(`capabilities:${SPINE}${COVER}
  - id: L4-ORDER
    level: 4
    parent: SVC
    status: live
    statement: "Second entry reusing an id"
    violation: "Two entries answering to one permanent id"
    implementedBy: [acme::shop::Order]
`);
    expect(codes(d)).toContain(ERR_LEDGER_DUPLICATE_ID);
  });

  test("a duplicate YAML key fails loudly instead of last-wins merging", async () => {
    // Pinned deliberately: a lenient loader silently merging duplicate keys is
    // what corrupted a control arm during the investigation behind this feature.
    // The parser default is strict today; this asserts we never relax it.
    const d = await check(`capabilities:
  - id: DUP
    level: 4
    parent: SVC
    status: live
    status: abandoned
    statement: "Two statuses"
    violation: "The ledger says two different things at once"
`);
    expect(codes(d)).toContain(ERR_LEDGER_PARSE);
    expect(errors(d).length).toBeGreaterThan(0);
  });

  test("an entry carrying a status must state its violation", async () => {
    const d = await check(`capabilities:${SPINE}${COVER}
  - id: NO-VIOLATION
    level: 4
    parent: SVC
    status: live
    statement: "Things are persisted"
    implementedBy: [acme::shop::Order]
`);
    expect(codes(d)).toContain(ERR_LEDGER_MISSING_VIOLATION);
  });

  test("a non-L1 entry needs a parent, and the parent must exist", async () => {
    const orphan = await check(`capabilities:${SPINE}${COVER}
  - id: ORPHAN
    level: 3
    status: live
    statement: "No parent"
    violation: "A service belonging to no segment"
`);
    expect(codes(orphan)).toContain(ERR_LEDGER_BAD_PARENT);

    const ghost = await check(`capabilities:${SPINE}${COVER}
  - id: GHOST
    level: 3
    parent: NOPE
    status: live
    statement: "Parent does not exist"
    violation: "A service pointing at a segment nobody declared"
`);
    expect(codes(ghost)).toContain(ERR_LEDGER_BAD_PARENT);
  });
});

describe("capability ledger — architectural entries", () => {
  test("architectural + live + zero implementers fails: the audited-base case", async () => {
    // The scenario the whole functional/architectural axis was justified on. In
    // the estate that motivated this feature, one shared audited base had 26
    // extenders, another 9, and a third ZERO — an architectural policy declared
    // and applied to nothing, which four independent analyses had to discover
    // the hard way. A universality check fails the build on it in one line.
    const d = await check(`capabilities:${SPINE}${COVER}
architectural:
  - id: ARCH-AUDITED
    status: live
    statement: "Every entity records who changed it and when"
    violation: "An entity with no change-attribution columns"
`);
    const arch = d.filter((x) => x.code === ERR_LEDGER_ARCH_NO_IMPLEMENTERS);
    expect(arch.length).toBe(1);
    expect(arch[0]!.severity).toBe("error");
  });

  test("an architectural entry with a claim set passes, and may link directly", async () => {
    const d = await check(`capabilities:${SPINE}${COVER}
architectural:
  - id: ARCH-UUID-PK
    status: live
    statement: "Every entity has a uuid primary key"
    violation: "An entity keyed by a composite string"
    implementedBy: [acme::shop::Order, acme::shop::Customer, acme::billing::Order]
`);
    expect(d).toEqual([]);
  });

  test("an abandoned architectural entry with no implementers is fine", async () => {
    const d = await check(`capabilities:${SPINE}${COVER}
architectural:
  - id: ARCH-GONE
    status: abandoned
    statement: "Every table carried a soft-delete flag"
    violation: "A hard delete on a table that promised soft deletes"
`);
    expect(d).toEqual([]);
  });

  test("architectural entries carry no level and no parent", async () => {
    const d = await check(`capabilities:${SPINE}${COVER}
architectural:
  - id: ARCH-LEVELLED
    level: 3
    parent: SVC
    status: live
    statement: "Levelled architectural entry"
    violation: "An object-independent rule pretending to sit in the tree"
    implementedBy: [acme::shop::Order]
`);
    expect(codes(d)).toContain(ERR_LEDGER_BAD_LEVEL);
    expect(codes(d)).toContain(ERR_LEDGER_BAD_PARENT);
  });
});

describe("capability ledger — object-coverage gate", () => {
  // Both severity arms are written TODAY. Promotion to error is a one-line flip
  // of OBJECT_COVERAGE_SEVERITY, which activates the assertion below rather than
  // requiring new authoring under release pressure.
  const WARN_MODE = OBJECT_COVERAGE_SEVERITY === "warn";

  test("an unclaimed entity is reported once, at the configured severity", async () => {
    const d = await check(`capabilities:${SPINE}
  - id: L4-ORDER
    level: 4
    parent: SVC
    status: live
    statement: "Orders are recorded"
    violation: "An order that is placed and never stored"
    implementedBy: [acme::shop::Order]
`);
    const unclaimed = d.filter((x) => x.code === WARN_LEDGER_OBJECT_UNCLAIMED);
    // Customer and the billing Order are both unclaimed.
    expect(unclaimed.length).toBe(2);
    for (const u of unclaimed) expect(u.severity).toBe(OBJECT_COVERAGE_SEVERITY);
  });

  test.if(WARN_MODE)("warn mode: an unclaimed entity does not fail the gate", async () => {
    const d = await check(`capabilities:${SPINE}
  - id: L4-ORDER
    level: 4
    parent: SVC
    status: live
    statement: "Orders are recorded"
    violation: "An order that is placed and never stored"
    implementedBy: [acme::shop::Order]
`);
    expect(errors(d)).toEqual([]);
  });

  test.if(!WARN_MODE)("error mode: an unclaimed entity fails the gate", async () => {
    const d = await check(`capabilities:${SPINE}
  - id: L4-ORDER
    level: 4
    parent: SVC
    status: live
    statement: "Orders are recorded"
    violation: "An order that is placed and never stored"
    implementedBy: [acme::shop::Order]
`);
    expect(errors(d).map((x) => x.code)).toContain(WARN_LEDGER_OBJECT_UNCLAIMED);
  });

  test("coverage is binary per entity — never a ratio", async () => {
    // A "% claimed" number measures what the schema can express, is biased
    // against the hardest rules, and invites optimising the number. Pinned so a
    // later convenience addition has to argue with a test.
    const d = await check(`capabilities:${SPINE}`);
    const unclaimed = d.filter((x) => x.code === WARN_LEDGER_OBJECT_UNCLAIMED);
    expect(unclaimed.length).toBe(3);
    for (const u of unclaimed) expect(u.message).not.toMatch(/%|ratio|coverage of|\d+\s*\/\s*\d+/);
  });

  test("a claim from an abandoned entry still counts as coverage", async () => {
    // Coverage asks "does anything in the ledger account for this entity", not
    // "is it live". An entity accounted for by a retired capability is recorded,
    // which is the opposite of unclaimed.
    const d = await check(`capabilities:${SPINE}${COVER}`);
    expect(d.filter((x) => x.code === WARN_LEDGER_OBJECT_UNCLAIMED)).toEqual([]);
  });
});

describe("capability ledger — reserved, not registered", () => {
  test("no capability.* type is registered in the loaded model", async () => {
    // ADR-0040 treatment. The ledger enters the metamodel registry only when a
    // shipping consumer DISPATCHES on capability records (the ADR-0007
    // Amendment 2 bar). Nothing does. This pins "reserved" against a future
    // implementer helpfully registering it — which would silently make the
    // ledger cross-port vocabulary that four other ports never agreed to.
    const root = await fixtureRoot();
    const walk = (n: MetaData): string[] =>
      [n.type, ...n.children().flatMap(walk)];
    const types = new Set(walk(root));
    for (const t of types) expect(t.startsWith("capability")).toBe(false);
    expect(types.has("capability")).toBe(false);
  });
});
