// What `meta gen` says it did to each file must be what it did.
//
// Found independently on two adopter estates: the per-file status read `new` for a
// file that already existed, that MetaObjects itself had written, whose recorded
// hash matched, and that the run OVERWROTE. The summary line ("5 written, 9
// unchanged") was correct throughout — only the per-file status lied.
//
// The engine had the right answer all along: `WriteStatus` carries `overwrite`,
// and `decideAndWrite` returns it. The CLI's reporting layer folded it into `new`.
// Reviewing a run, "an entity appeared" and "an existing artifact was rewritten"
// are different facts, and the 0.24.4 theme is precisely a tool saying something
// untrue about work it had just done.
//
// The gate is DERIVED from `WRITE_STATUSES` — the engine's own list — so a status
// added later is covered without anyone remembering this file. A second hand-kept
// list of statuses here would be the same defect one level up.

import { describe, test, expect } from "bun:test";
import { WRITE_STATUSES } from "@metaobjectsdev/codegen-ts";
import type { WriteStatus } from "@metaobjectsdev/codegen-ts";
import { mapStatus } from "../src/commands/gen.js";

/**
 * The ONLY collapses that are allowed, each with the reason it is not a lie.
 * Anything else mapping two engine outcomes onto one reported status must be
 * added here deliberately, with a reason — which is the point.
 */
const SANCTIONED_COLLAPSE: Readonly<Record<string, string>> = {
  // `skipped` only arises under strategy "skip-existing", where the file was left
  // exactly as it was — which is what "unchanged" tells the reader. Nothing about
  // the file differs between the two outcomes.
  "skipped→unchanged": "skip-existing leaves the file byte-identical; the reader learns the same fact",
};

describe("meta gen reports the outcome the engine actually returned", () => {
  test("every WriteStatus is mapped — no status falls through", () => {
    for (const s of WRITE_STATUSES) {
      expect(`${s}: ${typeof mapStatus(s as WriteStatus)}`).toBe(`${s}: string`);
    }
  });

  test("overwrite is NOT reported as new", () => {
    // The exact defect, pinned by name so a future simplification that re-merges
    // them fails with the reason attached.
    expect(mapStatus("overwrite")).toBe("overwrite");
    expect(mapStatus("overwrite")).not.toBe(mapStatus("new"));
  });

  test("no two engine outcomes collapse onto one report except by sanction", () => {
    const byReported = new Map<string, WriteStatus[]>();
    for (const s of WRITE_STATUSES) {
      const r = mapStatus(s as WriteStatus);
      const bucket = byReported.get(r) ?? [];
      bucket.push(s as WriteStatus);
      byReported.set(r, bucket);
    }
    const unsanctioned: string[] = [];
    for (const [reported, sources] of byReported) {
      if (sources.length < 2) continue;
      // One of the collapsed sources may legitimately BE the reported name.
      for (const s of sources) {
        if (s === reported) continue;
        if (SANCTIONED_COLLAPSE[`${s}→${reported}`] === undefined) {
          unsanctioned.push(`${s} → ${reported}`);
        }
      }
    }
    expect(unsanctioned).toEqual([]);
  });
});
