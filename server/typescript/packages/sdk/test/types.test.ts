import { test, expect } from "bun:test";
import type { DecisionRecord } from "../src/records/decision.js";

const _decision: DecisionRecord = {
  schema_version: 1,
  type: "decision",
  id: "decision-x",
  title: "X",
  confidence: 1,
  source: "human",
  captured_at: "2026-05-09T00:00:00Z",
  last_validated_against_commit: "abc",
  deviations: [],
  rationale: "y",
  alternatives_considered: [],
  scope: "global",
};

test("inferred record types accept literal fixtures", () => {
  expect(_decision.type).toBe("decision");
});
