// The one-shot note that tells an existing project the `<Entity>Names` artifact exists.
//
// THE PROBLEM, from three separate adopter estates. On TypeScript `generators: [...]` IS
// the complete suite — there is no default set to inherit — so an EXISTING project emits
// no names artifact until the line is added, and `meta gen` said nothing about it. On one
// estate with 57 modelled entities and roughly 200 physical names spelled as literals in
// hand-written SQL, the entire run contained zero occurrences of the word "names".
// `meta init` scaffolds the generator, so the gap only ever affects projects that already
// exist — precisely the population a scaffold cannot reach.
//
// WHY IT IS KEYED ON THE ENGINE STAMP AND NOT ON THE CONDITION ALONE. The same reasoning
// as the base-URL note next door: `data-grid-gate.ts` records that a `timestampMode`
// warning was DELETED from `runner.ts` for firing forever. Whether an adopter has
// considered the artifact and DECIDED against it is not something `meta gen` can observe,
// so "no namesFile() in the suite" is a condition that can be true for ever with no way
// to satisfy it. Crossing the version boundary is an event, and it happens once.

import { describe, test, expect } from "bun:test";
import { shouldNoteNamesArtifactAbsent } from "../src/runner.js";

const SINCE = "1.0.0";
const wired = true;
const notWired = false;
const hasDb = true;
const noDb = false;

describe("the missing-names-artifact note", () => {
  test("fires for a DB-backed project upgrading from before the artifact was doctrine", () => {
    expect(shouldNoteNamesArtifactAbsent(notWired, hasDb, "0.25.2", SINCE)).toBe(true);
  });

  test("stays quiet once the project has regenerated on the new engine", () => {
    // The same run that emits the note records the new engine version, so the very next
    // run takes this branch. That is what makes it self-extinguishing rather than a nag.
    expect(shouldNoteNamesArtifactAbsent(notWired, hasDb, SINCE, SINCE)).toBe(false);
  });

  test("stays quiet on any later engine", () => {
    expect(shouldNoteNamesArtifactAbsent(notWired, hasDb, "1.2.0", SINCE)).toBe(false);
  });

  test("stays quiet when the generator IS wired — there is nothing to tell", () => {
    expect(shouldNoteNamesArtifactAbsent(wired, hasDb, "0.25.2", SINCE)).toBe(false);
  });

  test("stays quiet for a model with no DB-backed object", () => {
    // An all-value / sourceless model has no physical name to spell, so the artifact is
    // not missing from it — it does not apply. Saying so would be noise, and noise is
    // what got the deleted warning deleted.
    expect(shouldNoteNamesArtifactAbsent(notWired, noDb, "0.25.2", SINCE)).toBe(false);
  });

  test("stays quiet with no gen history at all", () => {
    // No recorded engine means nothing was ever generated the old way. A project
    // generating for the first time under 1.0 is not migrating, and `meta init` has
    // already scaffolded the generator for it.
    expect(shouldNoteNamesArtifactAbsent(notWired, hasDb, undefined, SINCE)).toBe(false);
  });

  test("stays quiet on a version it cannot ORDER", () => {
    // "Unorderable" means not a plain N.N.N — a prerelease tag, a partial version, a
    // sentinel string. It does NOT mean "looks unusual": `0.0.0` parses fine and is
    // handled by the test below. Matches shouldNoteBaseUrlMove exactly; a false nag
    // costs more than a missed one, so anything uncomparable is silence.
    for (const v of ["1.0.0-rc.4", "not-a-version", "1.0", ""]) {
      expect(`${v}: ${shouldNoteNamesArtifactAbsent(notWired, hasDb, v, SINCE)}`).toBe(
        `${v}: false`,
      );
    }
  });

  test("DOES fire on a recorded 0.0.0 — it is orderable, and it is below the boundary", () => {
    // Pinned because it is the one case where "unresolved-install sentinel" reasoning
    // pulls the other way. The shipped sibling shouldNoteBaseUrlMove behaves identically
    // (verified), and the note is harmless here: it fires once, and the same run records
    // a real engine version over the sentinel, so it cannot repeat. That is the opposite
    // call to the 0.24.5 agent-context staleness nudge, where 0.0.0 must never be allowed
    // to assert "in sync" — there the sentinel suppresses a WARNING, here it triggers one.
    expect(shouldNoteNamesArtifactAbsent(notWired, hasDb, "0.0.0", SINCE)).toBe(true);
  });
});
