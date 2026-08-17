// Regenerating a committed DO-NOT-EDIT artifact should say what it replaced.
//
// `553782a97` is the case this exists for: two explanatory lines were added by hand
// inside `schema.postgres.sql`, whose own header reads `@generated … DO NOT EDIT`. The
// byte-comparison gate caught it, but only later, and the FIX — regenerate — deleted the
// explanation silently. The content was real and belonged in the design doc.
//
// Note what is deliberately NOT done here. The overwrite policy shipped for adopter code
// REFUSES to overwrite a diverged file, and applying that here would be actively wrong:
// this artifact's contract is generated-wins, so refusing would block the very command
// that repairs a red gate. The artifact is committed, so git already IS the record of
// what changed — what was missing is that the replacement happened without a word.
//
// Same guarantee as everywhere else (never destroy work silently), different mechanism,
// chosen from this artifact's contract rather than copied from another port's.

import { describe, expect, test } from "bun:test";

import { describeRegenReplacement } from "../src/canonical-schema.ts";

const FRESH = "CREATE TABLE a (id INT);\nCREATE TABLE b (id INT);\n";

describe("describeRegenReplacement", () => {
  test("says nothing when there is no file yet", () => {
    expect(describeRegenReplacement(undefined, FRESH)).toBeUndefined();
  });

  test("says nothing when the committed artifact is already current", () => {
    expect(describeRegenReplacement(FRESH, FRESH)).toBeUndefined();
  });

  test("reports a hand edit, and names what it is replacing", () => {
    const edited = FRESH.replace(
      "CREATE TABLE b",
      "-- an int-backed enum's CHECK lists mapped integers, unquoted\nCREATE TABLE b",
    );
    const msg = describeRegenReplacement(edited, FRESH);

    expect(msg).toBeDefined();
    // The count is what tells you this was an edit rather than a metadata change.
    expect(msg).toContain("1 line");
    // And it must say where the content should go instead, or the next person
    // re-adds it to the same file for the same reason.
    expect(msg).toContain("design doc");
  });

  test("reports a stale artifact (metadata moved on) the same way", () => {
    // Indistinguishable from a hand edit at this level, and that is fine: both mean
    // "what was on disk is not what the model produces now".
    const stale = "CREATE TABLE a (id INT);\n";
    expect(describeRegenReplacement(stale, FRESH)).toBeDefined();
  });

  test("counts only the lines that actually differ", () => {
    const edited = FRESH + "-- one\n-- two\n-- three\n";
    expect(describeRegenReplacement(edited, FRESH)).toContain("3 lines");
  });
});
