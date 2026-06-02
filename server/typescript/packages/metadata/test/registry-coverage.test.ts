// SP-G Unit 5 — untested-vocabulary coverage report (test + snapshot gate).
//
// Cross-references the committed registry manifest (the registered vocabulary)
// against the conformance fixture corpora and surfaces every registered
// (type, subType) — and each declared attr — that NO fixture exercises.
//
// DECISION — report, not hard-fail. The untested set today is a legitimate
// PRE-EXISTING backlog (many subtypes/attrs are not yet exercised by a fixture).
// Hard-failing CI on that backlog would block everything; the value of this unit
// is VISIBILITY now + a ratchet later. So this test ALWAYS:
//   - prints the coverage summary (counts + the untested list), and
//   - writes/asserts a committed, sorted, diffable snapshot
//     (fixtures/registry-conformance/coverage-report.json) so the gap is tracked
//     in git — a NEW untested subtype appearing shows up as a visible diff.
// It does NOT hard-fail on the existing backlog. (Tighten to hard-fail once the
// backlog is burned down — see the README.) Set MO_UPDATE_COVERAGE_SNAPSHOT=1 to
// regenerate the snapshot after an intended vocabulary/fixture change.

import { test, expect } from "bun:test";
import { join } from "node:path";
import {
  computeCoverage,
  emitSnapshot,
  toSnapshot,
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

  // --- Write / assert the committed, diffable snapshot ---
  const snapshot = toSnapshot(report);
  const emitted = normalizeNewlines(emitSnapshot(snapshot));

  if (process.env.MO_UPDATE_COVERAGE_SNAPSHOT === "1") {
    await Bun.write(SNAPSHOT, emitted);
    // eslint-disable-next-line no-console
    console.log(`[registry-coverage] snapshot WRITTEN to ${SNAPSHOT}`);
    return;
  }

  const committed = normalizeNewlines(await Bun.file(SNAPSHOT).text());
  if (emitted !== committed) {
    throw new Error(
      "Registry coverage drifted from the committed snapshot " +
        "(fixtures/registry-conformance/coverage-report.json). A vocabulary " +
        "member became (un)exercised, or the vocabulary changed. Review the diff: " +
        "a NEWLY untested subtype is a regression to investigate; a newly " +
        "exercised one is progress — regenerate with MO_UPDATE_COVERAGE_SNAPSHOT=1.",
    );
  }
  expect(emitted).toBe(committed);

  // Sanity: the report internally consistent + the manifest non-empty.
  expect(report.registeredSubTypeCount).toBeGreaterThan(0);
  expect(report.exercisedSubTypeCount + report.untestedSubTypes.length).toBe(
    report.registeredSubTypeCount,
  );
});
