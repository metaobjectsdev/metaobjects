// FR-044 Plan 4, Task 5 — the canonical golden: what cubeModel() writes for the persistence
// corpus's canonical model (postgres, literal column names) is fixtures/cube-model/canonical/
// expected/ byte for byte, which is contract Table H and the model the live Cube lane loads.
// Regenerated in a temp directory here; the committed files change only through the script.

import { describe, expect, test } from "bun:test";
import {
  CANONICAL_EXPECTED_DIR,
  CANONICAL_SCRIPT,
  canonicalCubeModelTree,
  readTree,
} from "../../scripts/gen-cube-model-canonical.js";

describe("the cube-model canonical golden", () => {
  test("is Table H's three cubes, the cubes the other canonical entities and the three @spine reports add, and nothing else", () => {
    expect([...readTree(CANONICAL_EXPECTED_DIR).keys()]).toEqual([
      "model/cubes/AllTypes.yml",
      "model/cubes/Asset.yml",
      "model/cubes/Auth.yml",
      "model/cubes/BridgeAuth.yml",
      "model/cubes/CopayAuth.yml",
      "model/cubes/Measurement.yml",
      "model/cubes/Node.yml",
      "model/cubes/Node_fkParent.yml",
      "model/cubes/PriorAuthAuth.yml",
      "model/cubes/Program.yml",
      "model/cubes/ProgramLongWeeksFacts.yml",
      "model/cubes/ProgramRosterFacts.yml",
      "model/cubes/ProgramSessionsFacts.yml",
      "model/cubes/ProgramSessions_fkWeek.yml",
      "model/cubes/ReferralAuth.yml",
      "model/cubes/Session.yml",
      "model/cubes/Week.yml",
      "model/views/ProgramLongWeeks.yml",
      "model/views/ProgramRoster.yml",
      "model/views/ProgramSessions.yml",
    ]);
  });

  test("matches what the generator writes today", async () => {
    const got = await canonicalCubeModelTree();
    const want = readTree(CANONICAL_EXPECTED_DIR);
    const drift = [
      ...[...got.keys()].filter((p) => !want.has(p)).map((p) => `written but not committed: ${p}`),
      ...[...want.keys()].filter((p) => !got.has(p)).map((p) => `committed but not written: ${p}`),
      ...[...want.keys()].filter((p) => got.has(p) && got.get(p) !== want.get(p)).map((p) => `bytes differ: ${p}`),
    ];
    if (drift.length > 0) {
      throw new Error(
        `fixtures/cube-model/canonical/expected/ is out of date with the cube-model generator:\n  ${drift.join("\n  ")}\n` +
          `Check the change against plan Table H, then regenerate with ${CANONICAL_SCRIPT}.`,
      );
    }
    for (const [path, bytes] of want) expect(got.get(path)).toBe(bytes);
  });
});
