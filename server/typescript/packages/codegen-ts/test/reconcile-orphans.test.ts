// FR-038 §8 — deletion integrity for generated stubs.
//
// When a requirement is deleted its stubs become orphans. The draft said
// "an existing stub is removed", which is safe only for an UNTOUCHED stub: on a
// filled one it eats assertions somebody wrote. So regen removes what it wrote and
// REFUSES what a human changed, naming it — the detect-and-refuse doctrine (#258),
// which is recoverable where deletion is not.
//
// Pure decision logic, no filesystem: the caller supplies readers. That keeps the
// rule itself testable without staging directories.

import { describe, test, expect } from "bun:test";
import { reconcileOrphans } from "../src/reconcile-orphans.js";

const SNAPSHOT = "// @generated\ntest('x', () => { expect.unreachable('stub'); });\n";
const EDITED = "// @generated\ntest('x', () => { expect(real()).toBe(true); });\n";

function reconcile(args: {
  previouslyGenerated: string[];
  emitted: string[];
  current?: Record<string, string>;
  snapshot?: Record<string, string>;
  owns?: (p: string) => boolean;
}) {
  return reconcileOrphans({
    previouslyGenerated: args.previouslyGenerated,
    emitted: args.emitted,
    owns: args.owns ?? ((p) => p.startsWith("requirements/")),
    readCurrent: (p) => args.current?.[p],
    readSnapshot: (p) => args.snapshot?.[p],
  });
}

describe("reconcileOrphans", () => {
  test("an untouched orphan is removed", () => {
    const d = reconcile({
      previouslyGenerated: ["requirements/gone.test.ts"],
      emitted: [],
      current: { "requirements/gone.test.ts": SNAPSHOT },
      snapshot: { "requirements/gone.test.ts": SNAPSHOT },
    });
    expect(d.remove).toEqual(["requirements/gone.test.ts"]);
    expect(d.refused).toEqual([]);
  });

  test("a HAND-EDITED orphan is REFUSED, never removed", () => {
    // The rule that matters. Deleting this destroys the assertions somebody wrote,
    // and unlike a refusal that is not recoverable.
    const d = reconcile({
      previouslyGenerated: ["requirements/gone.test.ts"],
      emitted: [],
      current: { "requirements/gone.test.ts": EDITED },
      snapshot: { "requirements/gone.test.ts": SNAPSHOT },
    });
    expect(d.refused).toEqual(["requirements/gone.test.ts"]);
    expect(d.remove).toEqual([]);
  });

  test("a still-emitted file is not an orphan at all", () => {
    const d = reconcile({
      previouslyGenerated: ["requirements/live.test.ts"],
      emitted: ["requirements/live.test.ts"],
      current: { "requirements/live.test.ts": EDITED },
      snapshot: { "requirements/live.test.ts": SNAPSHOT },
    });
    expect(d.remove).toEqual([]);
    expect(d.refused).toEqual([]);
  });

  test("files this generator does not own are never touched", () => {
    // Orphan reconciliation is opt-in and namespace-scoped. A generator must not
    // delete another generator's output just because it stopped emitting its own.
    const d = reconcile({
      previouslyGenerated: ["src/Council.ts", "requirements/gone.test.ts"],
      emitted: [],
      current: { "src/Council.ts": SNAPSHOT, "requirements/gone.test.ts": SNAPSHOT },
      snapshot: { "src/Council.ts": SNAPSHOT, "requirements/gone.test.ts": SNAPSHOT },
    });
    expect(d.remove).toEqual(["requirements/gone.test.ts"]);
  });

  test("an orphan already gone from disk just drops its snapshot", () => {
    const d = reconcile({
      previouslyGenerated: ["requirements/gone.test.ts"],
      emitted: [],
      current: {},
      snapshot: { "requirements/gone.test.ts": SNAPSHOT },
    });
    expect(d.vanished).toEqual(["requirements/gone.test.ts"]);
    expect(d.remove).toEqual([]);
    expect(d.refused).toEqual([]);
  });

  test("a missing snapshot is REFUSED rather than assumed untouched", () => {
    // Fail closed: with no baseline we cannot prove the file is untouched, and
    // guessing wrong deletes someone's work.
    const d = reconcile({
      previouslyGenerated: ["requirements/gone.test.ts"],
      emitted: [],
      current: { "requirements/gone.test.ts": SNAPSHOT },
      snapshot: {},
    });
    expect(d.refused).toEqual(["requirements/gone.test.ts"]);
    expect(d.remove).toEqual([]);
  });

  test("nothing emitted and nothing previously generated is a no-op", () => {
    const d = reconcile({ previouslyGenerated: [], emitted: [] });
    expect(d.remove).toEqual([]);
    expect(d.refused).toEqual([]);
    expect(d.vanished).toEqual([]);
  });
});
