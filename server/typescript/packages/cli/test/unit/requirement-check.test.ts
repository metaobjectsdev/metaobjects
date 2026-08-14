// `requirement.*` (#290) — the capability ledger AS METADATA.
//
// These tests declare requirements the way an adopter does: `requirement.functional`
// / `requirement.architectural` nodes in `metaobjects/`, loaded by the loader.
// Nothing here parses YAML by hand, and that is the point — the status enum is
// enforced by the registry's `allowedValues`, not by a string comparison in the CLI.
//
// THE FALSE-CONFIDENCE BOUNDARY. A green run proves REFERENTIAL INTEGRITY: links
// sit at or below the link floor, nesting agrees with levels, references resolve.
// It cannot prove that a status is TRUE, or that a node actually implements the
// requirement claiming it. No test can. That truth is the adopter's job.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMemory } from "@metaobjectsdev/sdk";
import {
  REQUIREMENT_STATUSES,
  REQUIREMENT_LINK_FLOOR_LEVEL,
  REQUIREMENT_MAX_LEVEL,
} from "@metaobjectsdev/metadata";
import {
  checkRequirements,
  summariseRequirements,
  collectRequirements,
  splitMemberRef,
  type RequirementSummary,
  OBJECT_COVERAGE_SEVERITY,
  ERR_REQUIREMENT_LINK_ABOVE_FLOOR,
  ERR_REQUIREMENT_DANGLING_REF,
  ERR_REQUIREMENT_BAD_LEVEL,
  ERR_REQUIREMENT_LEVEL_NESTING,
  ERR_REQUIREMENT_L4_NOT_OBJECT,
  ERR_REQUIREMENT_L5_NOT_MEMBER,
  ERR_REQUIREMENT_ARCH_NO_IMPLEMENTERS,
  WARN_REQUIREMENT_OBJECT_UNCLAIMED,
  type Diagnostic,
} from "../../src/lib/requirement-check.js";

const MODEL = `
metadata:
  package: acme::shop
  children:
    - object.entity:
        name: Order
        children:
          - source.rdb: { table: orders }
          - field.uuid: { name: id }
          - field.string: { name: reference }
          - identity.primary: { name: pk, fields: [id] }
    - object.entity:
        name: Customer
        children:
          - source.rdb: { table: customers }
          - field.uuid: { name: id }
          - identity.primary: { name: pk, fields: [id] }
`;

// A same-bare-named object in a SECOND package, for the fail-closed bare-ref test.
const OTHER = `
metadata:
  package: acme::billing
  children:
    - object.entity:
        name: Order
        children:
          - source.rdb: { table: billing_orders }
          - field.uuid: { name: id }
          - identity.primary: { name: pk, fields: [id] }
`;

/** Requirements claiming every entity, so the coverage gate stays quiet and each
 *  test's own declarations are the only thing under measurement. */
const COVER = `
          - requirement.functional:
              name: OrderRecording
              level: 4
              status: live
              statement: "Orders are recorded"
              violation: "An order placed and never stored"
              implementedBy: ["acme::shop::Order"]
          - requirement.functional:
              name: CustomerRecording
              level: 4
              status: live
              statement: "Customers are recorded"
              violation: "A customer that cannot be found again"
              implementedBy: ["acme::shop::Customer"]
          - requirement.functional:
              name: BillingOrders
              level: 4
              status: live
              statement: "Billing orders are recorded"
              violation: "An invoice with no order behind it"
              implementedBy: ["acme::billing::Order"]
`;

/** Wrap requirement declarations in the L1/L3 organisational spine. Hierarchy is
 *  NESTING, so children live inside their parent — there is no `parent` string. */
function caps(nested: string): string {
  // Re-indent the block so it is genuinely NESTED under OrderService (its
  // `children:`), not a sibling of it. Nesting is the hierarchy, so the test
  // fixture has to actually nest or it proves nothing about levels.
  const indented = nested
    .split("\n")
    .map((l) => (l.trim() === "" ? l : "      " + l))
    .join("\n");
  return `
metadata:
  package: acme::caps
  children:
    - requirement.functional:
        name: Solution
        level: 1
        status: live
        statement: "The commerce solution"
        violation: "Nothing can be sold"
        children:
          - requirement.functional:
              name: OrderService
              level: 3
              status: live
              statement: "Every placed order is recorded before payment"
              violation: "A payment against an order that was never stored"
              children:
${indented}
`;
}

interface Loaded { diags: Diagnostic[]; }

/** Load a model + requirement declarations and run the check. Returns the loader
 *  error instead when the load itself is rejected — several tests assert that the
 *  LOADER, not this CLI, is what refuses bad input. */
async function run(capsYaml: string, extraModel = ""): Promise<Loaded & { loadError?: string }> {
  const dir = mkdtempSync(join(tmpdir(), "req-check-"));
  try {
    mkdirSync(join(dir, "metaobjects"));
    writeFileSync(join(dir, "metaobjects/meta.shop.yaml"), MODEL);
    if (extraModel) writeFileSync(join(dir, "metaobjects/meta.extra.yaml"), extraModel);
    writeFileSync(join(dir, "metaobjects/meta.caps.yaml"), capsYaml);
    let root;
    try {
      root = await loadMemory(dir, { strict: true });
    } catch (err) {
      return { diags: [], loadError: (err as Error).message };
    }
    return { diags: checkRequirements(root) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Same as `run`, but also returns the SUMMARY `meta verify` prints above the
 *  diagnostics. The two are produced by separate walks over the same tree, so a
 *  test that only reads the diagnostics cannot see them disagree. */
async function runSummary(
  capsYaml: string,
  extraModel = "",
): Promise<Loaded & { summary: RequirementSummary | undefined; loadError?: string }> {
  const dir = mkdtempSync(join(tmpdir(), "req-sum-"));
  try {
    mkdirSync(join(dir, "metaobjects"));
    writeFileSync(join(dir, "metaobjects/meta.shop.yaml"), MODEL);
    if (extraModel) writeFileSync(join(dir, "metaobjects/meta.extra.yaml"), extraModel);
    writeFileSync(join(dir, "metaobjects/meta.caps.yaml"), capsYaml);
    let root;
    try {
      root = await loadMemory(dir, { strict: true });
    } catch (err) {
      return { diags: [], summary: undefined, loadError: (err as Error).message };
    }
    return { diags: checkRequirements(root), summary: summariseRequirements(root) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const codes = (d: Diagnostic[]): string[] => d.map((x) => x.code);
const errors = (d: Diagnostic[]): Diagnostic[] => d.filter((x) => x.severity === "error");

describe("requirement.* — it is metadata", () => {
  test("requirements load as first-class nodes, nested as a hierarchy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "req-meta-"));
    try {
      mkdirSync(join(dir, "metaobjects"));
      writeFileSync(join(dir, "metaobjects/meta.shop.yaml"), MODEL);
      writeFileSync(join(dir, "metaobjects/meta.extra.yaml"), OTHER);
      writeFileSync(join(dir, "metaobjects/meta.caps.yaml"), caps(COVER));
      const root = await loadMemory(dir, { strict: true });
      const reqs = collectRequirements(root);
      // 1 solution + 1 service + 3 objects, found by WALKING the nesting.
      expect(reqs.map((r) => r.name).sort()).toEqual(
        ["BillingOrders", "CustomerRecording", "OrderRecording", "OrderService", "Solution"],
      );
      const l4 = reqs.find((r) => r.name === "OrderRecording")!;
      expect(l4.level()).toBe(4);
      expect(l4.status()).toBe("live");
      expect(l4.implementedBy()).toEqual(["acme::shop::Order"]);
      // Nesting IS the hierarchy: the L4 sits under the L3, which sits under the L1.
      expect(l4.parent?.name).toBe("OrderService");
      expect(l4.parent?.parent?.name).toBe("Solution");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("THE LOADER rejects a bad status — allowedValues, not a CLI string compare", async () => {
    // This is the whole reason requirements are registered vocabulary. The typo
    // never reaches the CLI: the registry refuses it, in every port, for free.
    const r = await run(caps(COVER + `
          - requirement.functional:
              name: Typo
              level: 4
              status: abandonned
              statement: "Typo'd status"
              violation: "The status says nothing"
              implementedBy: ["acme::shop::Order"]
`), OTHER);
    expect(r.loadError ?? "").toContain("not one of the allowed values");
    // The FULL set, `planned` included. Asserting the tail alone passed by
    // substring luck and would have stayed green if `planned` were dropped.
    expect(r.loadError ?? "").toContain("planned, live, partial, abandoned, superseded");
  });

  test("THE LOADER rejects an undeclared attr on a requirement (ADR-0023)", async () => {
    const r = await run(caps(COVER + `
          - requirement.functional:
              name: Bogus
              level: 4
              status: live
              statement: "s"
              violation: "v"
              madeUpAttr: "x"
`), OTHER);
    expect(r.loadError ?? "").toMatch(/madeUpAttr|Unknown attribute|ERR_UNKNOWN_ATTR/);
  });

  test("a fully-claimed model is clean", async () => {
    const r = await run(caps(COVER), OTHER);
    expect(r.diags).toEqual([]);
  });
});

describe("requirement.* — status x resolution matrix", () => {
  // ONE table-driven matrix. The asymmetry INVERTS as a pair: dangling is an
  // error on live/partial and silent on abandoned/superseded. A partial test set
  // stays green straight through that inversion — which is also exactly why this
  // check CANNOT be a loader `references` descriptor: that pass always errors,
  // so an abandoned requirement would fail to load.
  const RESOLVES = "acme::shop::Order";
  const DANGLING = "acme::shop::Nonexistent";

  const cases: Array<{ status: string; ref: string; expectDangling: boolean }> = [];
  for (const status of REQUIREMENT_STATUSES) {
    const live = status === "live" || status === "partial";
    cases.push({ status, ref: RESOLVES, expectDangling: false });
    cases.push({ status, ref: DANGLING, expectDangling: live });
  }

  test("covers all 8 cells", () => {
    expect(cases.length).toBe(REQUIREMENT_STATUSES.length * 2);
  });

  for (const c of cases) {
    const label = c.ref === RESOLVES ? "resolves" : "dangling";
    test(`${c.status} x ${label} -> ${c.expectDangling ? "error" : "no diagnostic"}`, async () => {
      const r = await run(caps(COVER + `
          - requirement.functional:
              name: UnderTest
              level: 4
              status: ${c.status}
              statement: "Under test"
              violation: "The thing under test is broken"
              implementedBy: ["${c.ref}"]
`), OTHER);
      expect(r.loadError).toBeUndefined();
      const dangling = r.diags.filter((x) => x.code === ERR_REQUIREMENT_DANGLING_REF);
      expect(dangling.length).toBe(c.expectDangling ? 1 : 0);
      if (c.expectDangling) expect(dangling[0]!.severity).toBe("error");
    });
  }
});

describe("requirement.* — the link boundary", () => {
  test(`implementedBy above L${REQUIREMENT_LINK_FLOOR_LEVEL} is an error`, async () => {
    const r = await run(caps(COVER).replace(
      `        statement: "The commerce solution"`,
      `        statement: "The commerce solution"\n        implementedBy: ["acme::shop::Order"]`,
    ), OTHER);
    expect(codes(r.diags)).toContain(ERR_REQUIREMENT_LINK_ABOVE_FLOOR);
  });

  test(`L${REQUIREMENT_LINK_FLOOR_LEVEL} references an object, not a member`, async () => {
    const r = await run(caps(COVER + `
          - requirement.functional:
              name: WrongGrain
              level: 4
              status: live
              statement: "Wrong grain"
              violation: "An object-grain entry naming a field"
              implementedBy: ["acme::shop::Order.reference"]
`), OTHER);
    expect(codes(r.diags)).toContain(ERR_REQUIREMENT_L4_NOT_OBJECT);
  });

  test(`L${REQUIREMENT_MAX_LEVEL} references a member and resolves it`, async () => {
    const r = await run(caps(COVER + `
          - requirement.functional:
              name: Transcribable
              level: 5
              status: live
              statement: "An order reference is readable down a phone line"
              violation: "A reference that is a raw uuid"
              implementedBy: ["acme::shop::Order.reference"]
`), OTHER);
    expect(r.diags).toEqual([]);
  });

  test(`L${REQUIREMENT_MAX_LEVEL} naming an object is an error`, async () => {
    const r = await run(caps(COVER + `
          - requirement.functional:
              name: WrongGrain5
              level: 5
              status: live
              statement: "Wrong grain"
              violation: "A member-grain entry naming an object"
              implementedBy: ["acme::shop::Order"]
`), OTHER);
    expect(codes(r.diags)).toContain(ERR_REQUIREMENT_L5_NOT_MEMBER);
  });

  test("a dangling MEMBER on a live entry is caught", async () => {
    // The object half resolves; only the member is gone. Pinned because a
    // resolver that stopped at the object would report this clean.
    const r = await run(caps(COVER + `
          - requirement.functional:
              name: Renamed
              level: 5
              status: live
              statement: "Renamed out from under the requirement"
              violation: "The requirement cites a field that no longer exists"
              implementedBy: ["acme::shop::Order.wasRenamed"]
`), OTHER);
    expect(codes(r.diags)).toContain(ERR_REQUIREMENT_DANGLING_REF);
  });

  test("a level outside 1-5 is an error", async () => {
    const r = await run(caps(COVER + `
          - requirement.functional:
              name: OffLadder
              level: 6
              status: live
              statement: "Off the ladder"
              violation: "A level nobody defined"
`), OTHER);
    expect(codes(r.diags)).toContain(ERR_REQUIREMENT_BAD_LEVEL);
  });

  test("nesting must agree with the level", async () => {
    // Hierarchy IS nesting, so a child declaring a level at or above its parent's
    // is incoherent — the two encodings of the same fact disagreeing.
    const r = await run(caps(COVER + `
          - requirement.functional:
              name: Inverted
              level: 2
              status: live
              statement: "Nested under an L3 but claims L2"
              violation: "The tree and the level disagree"
`), OTHER);
    expect(codes(r.diags)).toContain(ERR_REQUIREMENT_LEVEL_NESTING);
  });
});

describe("requirement.* — reference resolution", () => {
  test("a bare name existing in two packages does NOT bind", async () => {
    // Fail-closed (#244 / ADR-0042) through the loader's OWN resolver: `Order`
    // exists in acme::shop and acme::billing, and the requirement's package is
    // acme::caps, so a bare ref binds neither rather than picking a coin flip.
    const r = await run(caps(COVER + `
          - requirement.functional:
              name: Bare
              level: 4
              status: live
              statement: "Bare ref"
              violation: "A bare name binding whichever package loaded first"
              implementedBy: ["Order"]
`), OTHER);
    const dangling = r.diags.filter((x) => x.code === ERR_REQUIREMENT_DANGLING_REF);
    expect(dangling.length).toBe(1);
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
  });
});

describe("requirement.architectural — universality", () => {
  test("live with zero implementers fails: the audited-base case", async () => {
    // The scenario the whole functional/architectural axis was justified on: in
    // the estate that motivated this, one shared audited base had 26 extenders,
    // another 9, and a third ZERO — a policy declared and applied to nothing,
    // which four independent analyses had to discover the hard way.
    const r = await run(caps(COVER) + `
    - requirement.architectural:
        name: ChangeAttribution
        status: live
        statement: "Every entity records who changed it and when"
        violation: "An entity with no change-attribution columns"
`, OTHER);
    const arch = r.diags.filter((x) => x.code === ERR_REQUIREMENT_ARCH_NO_IMPLEMENTERS);
    expect(arch.length).toBe(1);
    expect(arch[0]!.severity).toBe("error");
  });

  test("an architectural requirement carries a high-fan-out claim set", async () => {
    const r = await run(caps(COVER) + `
    - requirement.architectural:
        name: UuidPrimaryKeys
        status: live
        statement: "Every entity has a uuid primary key"
        violation: "An entity keyed by a composite string"
        implementedBy: ["acme::shop::Order", "acme::shop::Customer", "acme::billing::Order"]
`, OTHER);
    expect(r.diags).toEqual([]);
  });

  test("abandoned with no implementers is fine", async () => {
    const r = await run(caps(COVER) + `
    - requirement.architectural:
        name: SoftDeleteEverywhere
        status: abandoned
        statement: "Every table carried a soft-delete flag"
        violation: "A hard delete on a table that promised soft deletes"
`, OTHER);
    expect(r.diags).toEqual([]);
  });

  test("an architectural requirement MAY be levelled, and then obeys the link floor", async () => {
    // Levelling is OPT-IN. Unlevelled, an architectural requirement is a flat
    // object-independent policy that may name the model directly — the original
    // form, and still the default. Adding a level opts the node into a tree
    // (e.g. a quality taxonomy over non-functional claims), and from that point
    // the same floor applies as to a functional node: an organisational tier
    // cannot quietly start naming entities.
    const r = await run(caps(COVER) + `
    - requirement.architectural:
        name: Security
        level: 1
        status: live
        statement: "The system protects the data it holds"
        violation: "A record readable by someone with no claim to it"
        implementedBy: ["acme::shop::Order"]
`, OTHER);
    expect(r.diags.map((d) => d.code)).toContain("ERR_REQUIREMENT_LINK_ABOVE_FLOOR");
  });

  test("a levelled architectural tree nests, which a flat one could never do", async () => {
    // The whole point of the change: before it, `architectural` declared no
    // requirement.* child rule while `functional` did, so an architectural node
    // could nest under a FUNCTIONAL parent but never under another architectural
    // one. That asymmetry was an omission, not a design.
    const r = await run(caps(COVER) + `
    - requirement.architectural:
        name: Security
        level: 1
        status: live
        statement: "The system protects the data it holds"
        violation: "A record readable by someone with no claim to it"
        children:
          - requirement.architectural:
              name: Confidentiality
              level: 2
              status: live
              statement: "Stored data is unreadable without an authorised key"
              violation: "A database copy that reads in plain text"
              children:
                - requirement.architectural:
                    name: OrdersAreEncryptedAtRest
                    level: 4
                    status: live
                    statement: "Order rows are encrypted at rest"
                    violation: "A restored backup that opens in a text editor"
                    implementedBy: ["acme::shop::Order"]
`, OTHER);
    expect(r.loadError).toBeUndefined();
    expect(r.diags).toEqual([]);
  });
});

describe("requirement.* — planned, disposition and tracking", () => {
  test("a planned requirement may name nodes that do not exist yet", async () => {
    // The point of `planned`: you can lock in an intention before the model has
    // anywhere to hang it. On live/partial the same dangling ref is an error.
    const r = await run(caps(COVER) + `
    - requirement.functional:
        name: FutureThing
        level: 4
        status: planned
        statement: "Orders will carry a settlement reference"
        violation: "A settled order with nothing to reconcile against"
        implementedBy: ["acme::shop::DoesNotExistYet"]
`, OTHER);
    expect(r.diags.map((d) => d.code)).not.toContain("ERR_REQUIREMENT_DANGLING_REF");
  });

  test("a planned requirement does NOT count toward object coverage", async () => {
    // The load-bearing rule. If planning counted, the cheapest way to clear an
    // unclaimed-entity warning would be to declare an intention — and the gate
    // would be measuring ambition rather than work.
    // COVER claims Order and Customer but NOT acme::billing::Order, so the only
    // thing standing between billing::Order and an unclaimed warning is the
    // planned entry below. It must not be enough.
    const COVER_MINUS_BILLING =
      COVER.split("          - requirement.functional:\n              name: BillingOrders")[0] ?? COVER;
    const r = await run(caps(COVER_MINUS_BILLING) + `
    - requirement.functional:
        name: OnlyPlanned
        level: 4
        status: planned
        statement: "Billing orders will be recorded"
        violation: "An invoice with no order behind it"
        implementedBy: ["acme::billing::Order"]
`, OTHER);
    expect(r.loadError).toBeUndefined();
    expect(r.diags.map((d) => d.code)).toContain("WARN_REQUIREMENT_OBJECT_UNCLAIMED");
  });

  test("a planned architectural requirement is exempt from the universality check", async () => {
    const r = await run(caps(COVER) + `
    - requirement.architectural:
        name: NotBuiltYet
        status: planned
        statement: "Every table will carry a tenant column"
        violation: "A row reachable from the wrong tenant"
`, OTHER);
    expect(r.diags.map((d) => d.code)).not.toContain("ERR_REQUIREMENT_ARCH_NO_IMPLEMENTERS");
  });

  test("a disposition on a status with no outstanding work warns", async () => {
    const r = await run(caps(COVER) + `
    - requirement.architectural:
        name: AlreadyDone
        status: live
        disposition: accepted
        statement: "Money is stored as integer minor units"
        violation: "A rounding error in a split total"
        implementedBy: ["acme::shop::Order"]
`, OTHER);
    expect(r.diags.map((d) => d.code)).toContain("WARN_REQUIREMENT_DISPOSITION_NOT_APPLICABLE");
  });

  test("deferring without a ticket warns; deferring with one does not", async () => {
    const body = (tracked: string) => caps(COVER) + `
    - requirement.architectural:
        name: LaterProblem
        status: partial
        disposition: deferred
        ${tracked}
        statement: "Every money field declares its currency"
        violation: "Two amounts in different currencies summed as one"
        implementedBy: ["acme::shop::Order"]
`;
    const untracked = await run(body(""), OTHER);
    expect(untracked.diags.map((d) => d.code)).toContain("WARN_REQUIREMENT_DEFERRED_UNTRACKED");

    const tracked = await run(body(`trackedBy: ["acme/platform#412"]`), OTHER);
    expect(tracked.diags.map((d) => d.code)).not.toContain("WARN_REQUIREMENT_DEFERRED_UNTRACKED");
  });

  test("a functional requirement whose whole subtree claims nothing warns", async () => {
    const r = await run(caps(COVER) + `
    - requirement.functional:
        name: BuiltByNobody
        level: 1
        status: live
        statement: "Customers can export their order history"
        violation: "A customer who asks for their data and cannot be given it"
`, OTHER);
    expect(r.diags.map((d) => d.code)).toContain("WARN_REQUIREMENT_NOTHING_IMPLEMENTS");
  });

  test("an organisational tier that DELEGATES to children does not warn", async () => {
    // The reason this check has to be subtree-scoped. An L1 implements nothing
    // itself — it delegates — and that is the correct shape of every tree, so a
    // node-local check would fire on all of them.
    const r = await run(caps(COVER), OTHER);
    expect(r.diags.map((d) => d.code)).not.toContain("WARN_REQUIREMENT_NOTHING_IMPLEMENTS");
  });

  test("an ARCHITECTURAL claim on an abstract base covers everything extending it", async () => {
    // The documented BaseEntity pattern was previously WORSE than not using it:
    // claiming the base covered none of its subtypes, and the abstract was itself
    // demanded. Universality is exactly the polarity that should inherit.
    const BASE = `
metadata:
  package: acme::common
  children:
    - object.entity:
        name: BaseEntity
        abstract: true
        children:
          - field.uuid: { name: id }
          - identity.primary: { name: pk, fields: [id] }
    - object.entity:
        name: Widget
        extends: acme::common::BaseEntity
        children:
          - source.rdb: { table: widgets }
`;
    const r = await run(caps(COVER) + `
    - requirement.architectural:
        name: EveryRowIsAddressable
        status: live
        statement: "Every persisted row declares the identity it is addressed by"
        violation: "A row that can be inserted but never pointed at"
        implementedBy: ["acme::common::BaseEntity"]
`, BASE);
    const unclaimed = r.diags
      .filter((d) => d.code === "WARN_REQUIREMENT_OBJECT_UNCLAIMED")
      .map((d) => d.message);
    // The abstract base is exempt (shape, not data) and Widget inherits the claim.
    expect(unclaimed.join(" ")).not.toContain("BaseEntity");
    expect(unclaimed.join(" ")).not.toContain("Widget");
  });

  test("a FUNCTIONAL claim on a base does NOT cover its subtypes", async () => {
    // Opposite polarity, deliberately. A functional claim says this entity exists
    // for a reason; inheriting a reason would mean adding an entity no longer
    // forces anyone to say what it is for.
    const BASE = `
metadata:
  package: acme::common
  children:
    - object.entity:
        name: BaseEntity
        abstract: true
        children:
          - field.uuid: { name: id }
          - identity.primary: { name: pk, fields: [id] }
    - object.entity:
        name: Widget
        extends: acme::common::BaseEntity
        children:
          - source.rdb: { table: widgets }
`;
    const r = await run(caps(COVER) + `
    - requirement.functional:
        name: BaseThing
        level: 4
        status: live
        statement: "Base entities are recorded"
        violation: "A row nobody kept"
        implementedBy: ["acme::common::BaseEntity"]
`, BASE);
    const unclaimed = r.diags
      .filter((d) => d.code === "WARN_REQUIREMENT_OBJECT_UNCLAIMED")
      .map((d) => d.message)
      .join(" ");
    expect(unclaimed).toContain("Widget");
  });

  test("accepted needs no ticket — the decision is that there will be no work", async () => {
    const r = await run(caps(COVER) + `
    - requirement.architectural:
        name: KnownAndTolerated
        status: partial
        disposition: accepted
        statement: "Every money field declares its currency"
        violation: "Two amounts in different currencies summed as one"
        implementedBy: ["acme::shop::Order"]
`, OTHER);
    expect(r.diags).toEqual([]);
  });
});

describe("requirement.* — object coverage", () => {
  // Both severity arms are written TODAY. Promotion to error is a one-line flip
  // of OBJECT_COVERAGE_SEVERITY, which activates the assertion below.
  const WARN_MODE = OBJECT_COVERAGE_SEVERITY === "warn";
  const ONE_ONLY = `
          - requirement.functional:
              name: OrderRecording
              level: 4
              status: live
              statement: "Orders are recorded"
              violation: "An order placed and never stored"
              implementedBy: ["acme::shop::Order"]
`;

  test("an unclaimed entity is reported once, at the configured severity", async () => {
    const r = await run(caps(ONE_ONLY), OTHER);
    const unclaimed = r.diags.filter((x) => x.code === WARN_REQUIREMENT_OBJECT_UNCLAIMED);
    expect(unclaimed.length).toBe(2); // Customer + the billing Order
    for (const u of unclaimed) expect(u.severity).toBe(OBJECT_COVERAGE_SEVERITY);
  });

  test.if(WARN_MODE)("warn mode: an unclaimed entity does not fail the gate", async () => {
    const r = await run(caps(ONE_ONLY), OTHER);
    expect(errors(r.diags)).toEqual([]);
  });

  test.if(!WARN_MODE)("error mode: an unclaimed entity fails the gate", async () => {
    const r = await run(caps(ONE_ONLY), OTHER);
    expect(errors(r.diags).map((x) => x.code)).toContain(WARN_REQUIREMENT_OBJECT_UNCLAIMED);
  });

  test("coverage is binary per entity — never a ratio", async () => {
    // A "% claimed" number measures what the schema can express, is biased
    // against the hardest rules, and invites optimising the number.
    const r = await run(caps(ONE_ONLY), OTHER);
    for (const u of r.diags.filter((x) => x.code === WARN_REQUIREMENT_OBJECT_UNCLAIMED)) {
      expect(u.message).not.toMatch(/%|ratio|coverage of|\d+\s*\/\s*\d+/);
    }
  });

  test("a model declaring no requirements is silent — opt-in by declaration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "req-none-"));
    try {
      mkdirSync(join(dir, "metaobjects"));
      writeFileSync(join(dir, "metaobjects/meta.shop.yaml"), MODEL);
      const root = await loadMemory(dir, { strict: true });
      expect(checkRequirements(root)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Found by DOGFOODING the levelled-architectural feature on a real 245-entry
// ledger: the level rules a levelled architectural node documents itself as
// obeying are not the rules that run, and the summary line disagrees with the
// gate that prints beneath it.
// ---------------------------------------------------------------------------

describe("requirement.architectural — a levelled node obeys the level rules", () => {
  // The `@level` attr on requirement.architectural says, in its own registered
  // description: "PRESENT means this node sits in a levelled tree, and then the
  // same rules as functional apply: nesting must agree with the level, and only
  // L4/L5 may carry @implementedBy." Only the second half was enforced.
  test("a levelled architectural node cannot re-ascend the tree", async () => {
    const r = await run(caps(COVER) + `
    - requirement.architectural:
        name: Security
        level: 2
        status: live
        statement: "The system protects the data it holds"
        violation: "A record readable by someone with no claim to it"
        children:
          - requirement.architectural:
              name: Confidentiality
              level: 1
              status: live
              statement: "Stored data is unreadable without an authorised key"
              violation: "A database copy that reads in plain text"
`, OTHER);
    expect(codes(r.diags)).toContain(ERR_REQUIREMENT_LEVEL_NESTING);
  });

  test("a levelled architectural node cannot declare a level outside 1-5", async () => {
    const r = await run(caps(COVER) + `
    - requirement.architectural:
        name: Security
        level: 7
        status: live
        statement: "The system protects the data it holds"
        violation: "A record readable by someone with no claim to it"
`, OTHER);
    expect(codes(r.diags)).toContain(ERR_REQUIREMENT_BAD_LEVEL);
  });

  test("an UNLEVELLED architectural node is still exempt — levelling is the opt-in", async () => {
    // The whole point of the optionality: a flat policy predates levels and must
    // not start failing because the tree rules were tightened.
    const r = await run(caps(COVER) + `
    - requirement.architectural:
        name: UuidPrimaryKeys
        status: live
        statement: "Every entity has a uuid primary key"
        violation: "An entity keyed by a composite string"
        implementedBy: ["acme::shop::Order"]
`, OTHER);
    expect(codes(r.diags)).not.toContain(ERR_REQUIREMENT_BAD_LEVEL);
    expect(codes(r.diags)).not.toContain(ERR_REQUIREMENT_LEVEL_NESTING);
  });
});

describe("summariseRequirements — the printed summary agrees with the gate", () => {
  // A summary that contradicts the diagnostics under it is worse than no summary:
  // it reads as a measurement and cannot be reconciled with the run that produced
  // it. Both divergences below make the summary UNDER-report coverage while the
  // gate stays silent, so a clean run prints an alarming ratio for no reason.
  const ABSTRACT_MODEL = `
metadata:
  package: acme::base
  children:
    - object.entity:
        name: BaseEntity
        abstract: true
        children:
          - field.uuid: { name: id }
          - identity.primary: { name: pk, fields: [id] }
    - object.entity:
        name: Invoice
        extends: BaseEntity
        children:
          - source.rdb: { table: invoices }
`;

  // Claims the two entities MODEL always declares, WITHOUT the billing claim
  // COVER carries — this test loads ABSTRACT_MODEL as its extra file instead of
  // OTHER, so a billing claim would dangle and put an unrelated error in the run.
  const COVER_SHOP = `
          - requirement.functional:
              name: OrderRecording
              level: 4
              status: live
              statement: "Orders are recorded"
              violation: "An order placed and never stored"
              implementedBy: ["acme::shop::Order"]
          - requirement.functional:
              name: CustomerRecording
              level: 4
              status: live
              statement: "Customers are recorded"
              violation: "A customer that cannot be found again"
              implementedBy: ["acme::shop::Customer"]
`;

  test("an abstract entity is out of the denominator, as it is out of the gate", async () => {
    const r = await runSummary(caps(COVER_SHOP) + `
    - requirement.architectural:
        name: EveryRowIsAddressable
        status: live
        statement: "Every persisted row declares its identity"
        violation: "A row that can be inserted but never pointed at"
        implementedBy: ["acme::base::BaseEntity"]
`, ABSTRACT_MODEL);
    expect(errors(r.diags)).toEqual([]);
    // The gate exempts abstracts (shape, not data) and propagates an
    // ARCHITECTURAL claim down the extends chain. So nothing is unclaimed...
    expect(codes(r.diags)).not.toContain(WARN_REQUIREMENT_OBJECT_UNCLAIMED);
    // ...and the summary must say the same thing.
    expect(r.summary!.entitiesClaimed).toBe(r.summary!.entitiesTotal);
  });
});
