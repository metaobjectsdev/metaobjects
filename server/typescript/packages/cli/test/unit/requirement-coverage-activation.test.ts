// FR-043 §5.4 — object coverage activates on ADOPTER-authored requirements only.
//
// The problem this rule exists for: `checkRequirements` early-returns only when the
// tree has ZERO requirements, so a library shipping its own ledger would switch the
// unclaimed-entity gate ON for every entity in the adopting project. A project that
// has never written a requirement would opt into `iam`, gain eleven entries it did
// not author, and be told its own ninety entities are unclaimed. The gate would be
// measuring the library's decision to ship a ledger, not the adopter's.
//
// So: library requirements are always COUNTED, always gate-checked for their own
// integrity, and always claim what they claim — they simply do not volunteer the
// adopter for coverage. Write one requirement of your own and coverage turns on,
// over the library's entities too, which by then are claimed by the library's own
// ledger and add no warnings.
//
// Provenance is the library's own declared PACKAGE, resolved from the embedded
// manifests rather than from a source-file path: `packages` is a manifest fact the
// standalone gate already resolves against the library loaded alone, whereas a
// source id differs between the on-disk dev layout (an absolute path) and the
// embedded one (`library:<ref>.yaml`) — a rule keyed on that would hold in this
// repo and silently stop holding in an installed build.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMemory } from "@metaobjectsdev/sdk";
import {
  checkRequirements, summariseRequirements, scanRequirements,
  WARN_REQUIREMENT_OBJECT_UNCLAIMED,
} from "../../src/lib/requirement-check.js";

/** Two entities, one of which no requirement below ever claims. */
const MODEL = `
metadata:
  package: acme::shop
  children:
    - object.entity:
        name: Order
        children:
          - source.rdb: { table: orders }
          - field.uuid: { name: id }
          - identity.primary: { name: pk, fields: [id] }
    - object.entity:
        name: Invoice
        children:
          - source.rdb: { table: invoices }
          - field.uuid: { name: id }
          - identity.primary: { name: pk, fields: [id] }
`;

/** One requirement the ADOPTER wrote, claiming one of the two entities. */
const OWN_CAPS = `
metadata:
  package: acme::caps
  children:
    - requirement.functional:
        name: ordering
        level: 4
        status: live
        statement: A customer's order is recorded before it is paid for.
        counterexample: A payment against an order that was never stored.
        implementedBy: [acme::shop::Order]
`;

/** An adopter DISAGREEING with a library requirement (§5.5) — an overlay of the
 *  library's own node, in the library's own package. */
const OVERLAY_CAPS = `
metadata:
  package: metaobjects::iam
  children:
    - requirement.architectural:
        name: noCredentialsOnUser
        overlay: true
        status: partial
        disposition: accepted
        notes: We store a password hash on User because our auth stack predates this library.
`;

interface Run {
  unclaimed: string[];
  measured: boolean;
  entitiesTotal?: number;
  total: number;
}

async function run(files: Record<string, string>, libraries?: string[]): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), "req-cover-"));
  try {
    mkdirSync(join(dir, "metaobjects"));
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(dir, "metaobjects", name), text);
    }
    const root = await loadMemory(dir, {
      strict: true,
      ...(libraries === undefined ? {} : { libraries }),
    });
    const scan = scanRequirements(root);
    const summary = summariseRequirements(root, scan);
    return {
      unclaimed: checkRequirements(root, scan)
        .filter((d) => d.code === WARN_REQUIREMENT_OBJECT_UNCLAIMED)
        .map((d) => d.message),
      measured: scan.measureCoverage,
      ...(summary?.entitiesTotal === undefined ? {} : { entitiesTotal: summary.entitiesTotal }),
      total: summary?.total ?? 0,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("object coverage activates on adopter-authored requirements only", () => {
  test("a project that opted into a library and wrote none of its own is not measured", async () => {
    const r = await run({ "meta.shop.yaml": MODEL }, ["iam"]);
    // The library's ledger is COUNTED — it is in the tree and it is checked.
    expect(r.total).toBeGreaterThan(0);
    // ...but it does not volunteer the adopter's entities for coverage.
    expect(r.measured).toBe(false);
    expect(r.unclaimed).toEqual([]);
    // And the summary says so rather than printing a ratio nobody asked to be held to.
    expect(r.entitiesTotal).toBeUndefined();
  });

  test("one requirement of your own switches it on — over the library's entities too", async () => {
    const r = await run({ "meta.shop.yaml": MODEL, "meta.caps.yaml": OWN_CAPS }, ["iam"]);
    expect(r.measured).toBe(true);
    // `Invoice` is the adopter's own unclaimed entity — the warning they can act on.
    expect(r.unclaimed.join("\n")).toContain("acme::shop::Invoice");
    expect(r.unclaimed.length).toBe(1);
    // The denominator GREW to include the library's nine, and every one of them is
    // claimed by the library's own ledger, so the gate stays quiet about them. That
    // is the property that makes activation safe: turning coverage on must not hand
    // the adopter a pile of warnings about metadata they did not write.
    expect(r.entitiesTotal).toBe(11);
  });

  test("no library, no change: a project's own ledger measures coverage exactly as before", async () => {
    const r = await run({ "meta.shop.yaml": MODEL, "meta.caps.yaml": OWN_CAPS });
    expect(r.measured).toBe(true);
    expect(r.entitiesTotal).toBe(2);
    expect(r.unclaimed.length).toBe(1);
  });

  test("overlaying a library requirement is not authoring one (§5.5)", async () => {
    // Disagreeing with a shipped claim is a verdict on the LIBRARY's design, not a
    // statement about what the adopter's own model is for — and it merges into the
    // library's node, in the library's package. Treating it as activation would mean
    // an adopter who corrected one library entry silently acquired a coverage gate
    // over their whole estate.
    const r = await run(
      { "meta.shop.yaml": MODEL, "meta.overlay.yaml": OVERLAY_CAPS },
      ["iam"],
    );
    expect(r.measured).toBe(false);
    expect(r.unclaimed).toEqual([]);
  });

  test("`measureCoverage` can be forced on, for a caller that IS the library", async () => {
    // The standalone library gate (`shipped-library-verify.test.ts`) loads a library
    // with no project around it, so the derivation would switch coverage off exactly
    // where it is the thing being tested.
    const dir = mkdtempSync(join(tmpdir(), "req-cover-lib-"));
    try {
      mkdirSync(join(dir, "metaobjects"));
      writeFileSync(join(dir, "metaobjects", "meta.shop.yaml"), MODEL);
      const root = await loadMemory(dir, { strict: true, libraries: ["iam"] });
      const scan = scanRequirements(root, { measureCoverage: true });
      expect(scan.measureCoverage).toBe(true);
      const diags = checkRequirements(root, scan).filter(
        (d) => d.code === WARN_REQUIREMENT_OBJECT_UNCLAIMED,
      );
      // Both of the adopter's entities are now reported — which is the forced
      // behaviour, and the reason the override exists rather than being the default.
      expect(diags.length).toBe(2);
      expect(summariseRequirements(root, scan)!.entitiesTotal).toBe(11);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
