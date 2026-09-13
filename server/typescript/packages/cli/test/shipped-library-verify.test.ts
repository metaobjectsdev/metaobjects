// FR-043 §8 item 2 — every SHIPPED library passes `meta verify` standalone.
//
// This is the gate the library's own ledger is held to, and it is separate from the
// load test in `metadata/test/library-load.test.ts` for one reason: loading clean and
// VERIFYING clean are different claims. A library whose requirements load fine can
// still ship `ERR_REQUIREMENT_L4_NOT_OBJECT` — and it did, in both libraries, until
// this test existed. Every adopter who opts in runs `meta verify` over metadata they
// did not write and cannot fix, so a finding here is a finding in every adopter's
// build.
//
// STANDALONE, with no project files at all (`files: []`), because that is the claim
// §4 makes: "every @implementedBy resolving WITHIN the library standalone — a
// library's ledger must be self-contained". A library that only verifies alongside
// an adopter's model has a hidden dependency on it.
//
// EVERY TOKEN, derived from the manifests rather than listed here. A new library, or
// a new layer of an existing one, is gated the day it is embedded; a hard-coded list
// would gate the two that exist and silently skip the third.
import { describe, test, expect } from "bun:test";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { knownLibraryTokens, librarySources } from "@metaobjectsdev/metadata/library";
import {
  checkRequirements, summariseRequirements, scanRequirements,
} from "../src/lib/requirement-check.js";
import { lintRequirements } from "../src/lib/requirement-lint.js";

const TOKENS = knownLibraryTokens();

describe("every shipped library verifies standalone (FR-043 §8 item 2)", () => {
  test("there is something to gate", () => {
    // A guard on the derivation itself: if `knownLibraryTokens()` ever returned an
    // empty list — a stale embed, a renamed manifest key — every loop below would
    // pass by iterating nothing.
    expect(TOKENS.length).toBeGreaterThan(0);
    expect(TOKENS).toContain("iam");
  });

  for (const token of TOKENS) {
    test(`\`${token}\` loads with no errors and no warnings`, async () => {
      const result = await new MetaDataLoader({ strict: true }).load(librarySources([token]));
      expect(result.errors, `${token} errors`).toEqual([]);
      // Warnings matter as much as errors here: `WARN_LEGACY [filterable-without-index]`
      // on one library field would print in every adopter's run forever, and nobody but
      // this repo can silence it.
      expect(result.warnings, `${token} warnings`).toEqual([]);
    });

    test(`\`${token}\` passes the requirement gate, with nothing left to rule on`, async () => {
      const result = await new MetaDataLoader({ strict: true }).load(librarySources([token]));
      const root = result.root;
      // Coverage is MEASURED here even though FR-043 §5.4 switches it off for an
      // adopter with no requirements of their own: standalone, the library IS the
      // project under test, and "every entity this library ships is claimed by its
      // own ledger" is exactly what the library owes. Without the override this gate
      // would silently stop checking the thing it was written for.
      const scan = scanRequirements(root, { measureCoverage: true });
      const diags = checkRequirements(root, scan);
      expect(
        diags.map((d) => `[${d.severity}] ${d.code} @${d.path ?? "-"}: ${d.message}`),
        `${token} requirement gate`,
      ).toEqual([]);

      const summary = summariseRequirements(root, scan);
      expect(summary, `${token} ships requirements`).toBeDefined();
      // §5.4 — "A library must not ship unruled gaps; the standalone gate asserts it."
      // A `partial` an adopter cannot act on and nobody has ruled on is worse than no
      // entry: it reads as an open question the adopter is expected to answer.
      expect(summary!.undecided, `${token} unruled gaps`).toBe(0);
      // Every entity the library ships is claimed by the library's own ledger.
      expect(
        `${summary!.entitiesClaimed}/${summary!.entitiesTotal}`,
        `${token} entities claimed`,
      ).toBe(`${summary!.entitiesTotal}/${summary!.entitiesTotal}`);
    });

    test(`\`${token}\` is clean under the authoring lint`, async () => {
      const result = await new MetaDataLoader({ strict: true }).load(librarySources([token]));
      // Advisory for an adopter, mandatory here: the lint's findings are all about
      // prose an adopter cannot edit.
      expect(
        lintRequirements(result.root).map((d) => `${d.code} @${d.path ?? "-"}: ${d.message}`),
        `${token} authoring lint`,
      ).toEqual([]);
    });
  }
});
