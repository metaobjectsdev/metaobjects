// SP-G Unit 5 + Wave 4a — untested-vocabulary coverage MONOTONIC RATCHET.
//
// Cross-references the committed registry manifest (the registered vocabulary)
// against the conformance fixture corpora and surfaces every registered
// (type, subType) — and each declared attr — that NO fixture exercises.
//
// DECISION — monotonic ratchet (Wave 4a; was "report, not hard-fail" in SP-G).
// The committed snapshot (fixtures/registry-conformance/coverage-report.json) is
// a BASELINE. The pre-existing untested set is a legitimate backlog we do NOT
// hard-fail on. But coverage must never REGRESS: the build hard-fails if a
// registered (type, subType) — or an attr on an exercised subtype — that the
// baseline had EXERCISED becomes unexercised (a NEW untested item). Adding an
// exercising fixture (an item LEAVES the untested set) is an improvement and is
// always allowed; the test notes when the baseline should be tightened.
//
// The comparison is SET-based, not count-based: an integer-only check would let
// a regression hide behind a simultaneous improvement (one item newly exercised,
// a different one regressing, net count unchanged). We compare the untested SETS
// so each individual regression is named in the failure.
//
// This test ALWAYS prints the coverage summary (visibility), then runs the
// ratchet against the committed baseline. Set MO_UPDATE_COVERAGE_SNAPSHOT=1 to
// regenerate the baseline after an intended vocabulary/fixture change (e.g. once
// an item is newly exercised, tightening the baseline so future regressions of
// THAT item are caught too).

import { test, expect } from "bun:test";
import { join } from "node:path";
import {
  checkRatchet,
  computeCoverage,
  emitSnapshot,
  formatRatchetFailure,
  toSnapshot,
  type CoverageSnapshot,
  type RegistryManifest,
} from "../src/registry-coverage.js";

// Repo root is five `../` up from test/ (test → metadata → packages → typescript → server → repo-root).
const REPO_ROOT = join(import.meta.dir, "../../../../..");
const FIXTURES = join(REPO_ROOT, "fixtures");
const MANIFEST = join(FIXTURES, "registry-conformance/expected-registry.json");
const SNAPSHOT = join(FIXTURES, "registry-conformance/coverage-report.json");

// The metamodel corpus is the PRIMARY vocabulary exerciser; the others exercise
// behavior. We union usage across all of them so a subtype/attr exercised in any
// corpus is not falsely flagged "untested".
const CORPUS_ROOTS = [
  join(FIXTURES, "conformance"),
  join(FIXTURES, "render-conformance"),
  join(FIXTURES, "persistence-conformance"),
  join(FIXTURES, "api-contract-conformance"),
  join(FIXTURES, "output-prompt-conformance"),
  join(FIXTURES, "extract-conformance"),
];

function normalizeNewlines(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

test("registry vocabulary coverage — report + tracked snapshot", async () => {
  const manifest = (await Bun.file(MANIFEST).json()) as RegistryManifest;
  const report = computeCoverage(manifest, CORPUS_ROOTS);

  // --- Always print the coverage summary (the deliverable: make the gap visible) ---
  const pct = (
    (report.exercisedSubTypeCount / report.registeredSubTypeCount) *
    100
  ).toFixed(1);
  // eslint-disable-next-line no-console
  console.log(
    `\n[registry-coverage] subtypes: ${report.exercisedSubTypeCount}/${report.registeredSubTypeCount} exercised (${pct}%), ` +
      `${report.untestedSubTypes.length} UNTESTED`,
  );
  if (report.untestedSubTypes.length > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[registry-coverage] untested subtypes:\n  ${report.untestedSubTypes.join("\n  ")}`,
    );
  }
  if (report.untestedAttrsByExercisedSubType.length > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[registry-coverage] exercised subtypes with untested attrs: ` +
        `${report.untestedAttrsByExercisedSubType.length}`,
    );
  }

  // --- Snapshot update mode: regenerate the committed baseline ---
  const live = toSnapshot(report);

  if (process.env.MO_UPDATE_COVERAGE_SNAPSHOT === "1") {
    await Bun.write(SNAPSHOT, normalizeNewlines(emitSnapshot(live)));
    // eslint-disable-next-line no-console
    console.log(`[registry-coverage] baseline WRITTEN to ${SNAPSHOT}`);
    return;
  }

  // --- Monotonic ratchet: live coverage must be NO WORSE than the baseline ---
  const baseline = JSON.parse(
    normalizeNewlines(await Bun.file(SNAPSHOT).text()),
  ) as CoverageSnapshot;

  const ratchet = checkRatchet(baseline, live);
  if (!ratchet.ok) {
    throw new Error(formatRatchetFailure(ratchet));
  }
  expect(ratchet.ok).toBe(true);

  // Note (not fail) when coverage IMPROVED — the baseline can be tightened so a
  // future regression of the newly-exercised item is also caught.
  const newlyExercised = baseline.untestedSubTypes.filter(
    (k) => !live.untestedSubTypes.includes(k),
  );
  if (newlyExercised.length > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[registry-coverage] IMPROVED — ${newlyExercised.length} subtype(s) newly ` +
        `exercised (${newlyExercised.join(", ")}). Tighten the baseline: ` +
        `MO_UPDATE_COVERAGE_SNAPSHOT=1 bun test ` +
        `packages/metadata/test/registry-coverage.test.ts`,
    );
  }

  // Sanity: the report internally consistent + the manifest non-empty.
  expect(report.registeredSubTypeCount).toBeGreaterThan(0);
  expect(report.exercisedSubTypeCount + report.untestedSubTypes.length).toBe(
    report.registeredSubTypeCount,
  );
});

// --- Negative check: the ratchet must BITE on a synthetic regression ---
//
// Feeds a synthetic baseline + live pair where coverage regresses (a previously
// exercised subtype + a previously exercised attr both become untested) and
// asserts the ratchet reports BOTH, while an improvement (an item leaving the
// untested set) is NOT flagged. Proves the gate is live, not vacuous.
test("ratchet bites on a coverage regression (and ignores improvements)", () => {
  const baseline: CoverageSnapshot = {
    registeredSubTypeCount: 3,
    exercisedSubTypeCount: 2,
    untestedSubTypes: ["field.base"], // field.string + field.int are exercised
    untestedAttrsByExercisedSubType: [
      { key: "field.string", untestedAttrs: ["precision"] }, // maxLength IS exercised
    ],
  };

  // Live: field.int regressed (newly untested) AND field.string lost @maxLength
  // (newly untested attr). field.base LEFT the untested set (improvement).
  const liveRegressed: CoverageSnapshot = {
    registeredSubTypeCount: 3,
    exercisedSubTypeCount: 1,
    untestedSubTypes: ["field.int"], // field.base now exercised (good); field.int regressed (bad)
    untestedAttrsByExercisedSubType: [
      { key: "field.string", untestedAttrs: ["maxLength", "precision"] }, // maxLength regressed
    ],
  };

  const result = checkRatchet(baseline, liveRegressed);
  expect(result.ok).toBe(false);
  // Both regressions named; the improvement (field.base) is NOT a regression.
  expect(result.regressions).toEqual([
    { kind: "attr", key: "field.string", attr: "maxLength" },
    { kind: "subtype", key: "field.int" },
  ]);
  const msg = formatRatchetFailure(result);
  expect(msg).toContain("field.int");
  expect(msg).toContain("field.string @maxLength");
  expect(msg).not.toContain("field.base"); // improvement, not reported

  // A purely-improving live run (subset of baseline untested, no new untested
  // attr) must pass the ratchet.
  const liveImproved: CoverageSnapshot = {
    registeredSubTypeCount: 3,
    exercisedSubTypeCount: 3,
    untestedSubTypes: [], // everything now exercised
    untestedAttrsByExercisedSubType: [
      { key: "field.string", untestedAttrs: ["precision"] }, // unchanged
    ],
  };
  expect(checkRatchet(baseline, liveImproved).ok).toBe(true);
});
