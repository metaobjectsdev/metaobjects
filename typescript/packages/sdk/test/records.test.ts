import { describe, test, expect } from "bun:test";
import { RecordCore } from "../src/records/core.js";

const validCore = {
  schema_version: 1 as const,
  type: "decision" as const,
  id: "decision-tanstack",
  title: "Use TanStack Query",
  confidence: 0.9,
  source: "human" as const,
  captured_at: "2026-05-09T00:00:00Z",
  last_validated_against_commit: "abc123",
  deviations: [],
};

describe("RecordCore", () => {
  test("accepts a valid core", () => {
    expect(RecordCore.safeParse(validCore).success).toBe(true);
  });
  test("rejects schema_version other than 1", () => {
    expect(RecordCore.safeParse({ ...validCore, schema_version: 2 }).success).toBe(false);
  });
  test("rejects unknown record type", () => {
    expect(RecordCore.safeParse({ ...validCore, type: "wat" }).success).toBe(false);
  });
  test("rejects id with uppercase", () => {
    expect(RecordCore.safeParse({ ...validCore, id: "Decision-X" }).success).toBe(false);
  });
  test("rejects confidence outside [0, 1]", () => {
    expect(RecordCore.safeParse({ ...validCore, confidence: 1.5 }).success).toBe(false);
  });
  test("rejects unknown source", () => {
    expect(RecordCore.safeParse({ ...validCore, source: "magic" }).success).toBe(false);
  });
  test("defaults deviations to empty array", () => {
    const noDevs = { ...validCore };
    delete (noDevs as { deviations?: unknown }).deviations;
    const parsed = RecordCore.parse(noDevs);
    expect(parsed.deviations).toEqual([]);
  });
});

import { ConventionRecord } from "../src/records/convention.js";
import { DecisionRecord } from "../src/records/decision.js";
import { PrincipleRecord } from "../src/records/principle.js";
import { GlossaryRecord } from "../src/records/glossary.js";
import { FailureRecord } from "../src/records/failure.js";
import { AnyRecord } from "../src/records/any.js";

const baseCore = {
  schema_version: 1 as const,
  id: "x-1",
  title: "X",
  confidence: 1,
  source: "human" as const,
  captured_at: "2026-05-09T00:00:00Z",
  last_validated_against_commit: "abc",
  deviations: [],
};

describe("five descriptive record types", () => {
  test("ConventionRecord", () => {
    expect(
      ConventionRecord.safeParse({
        ...baseCore,
        type: "convention",
        pattern_description: "API handlers export default async function",
        examples: ["src/api/users.handler.ts"],
        applies_to: ["src/api/**/*.handler.ts"],
      }).success,
    ).toBe(true);
  });
  test("DecisionRecord global scope", () => {
    expect(
      DecisionRecord.safeParse({
        ...baseCore,
        type: "decision",
        rationale: "Why we chose X",
        alternatives_considered: ["Y", "Z"],
        scope: "global",
      }).success,
    ).toBe(true);
  });
  test("DecisionRecord scoped", () => {
    expect(
      DecisionRecord.safeParse({
        ...baseCore,
        type: "decision",
        rationale: "Why we chose X",
        alternatives_considered: [],
        scope: ["src/server/**"],
      }).success,
    ).toBe(true);
  });
  test("PrincipleRecord defaults enforcement to advisory", () => {
    const parsed = PrincipleRecord.parse({
      ...baseCore,
      type: "principle",
      statement: "X",
      rationale: "Y",
      scope: ["**"],
      examples: [],
      counter_examples: [],
    });
    expect(parsed.enforcement).toBe("advisory");
  });
  test("GlossaryRecord", () => {
    expect(
      GlossaryRecord.safeParse({
        ...baseCore,
        type: "glossary",
        term: "Auditable",
        synonyms: ["audited"],
        definition: "An entity with timestamp tracking",
        code_anchors: { entity: "Auditable" },
        see_also: [],
      }).success,
    ).toBe(true);
  });
  test("FailureRecord", () => {
    expect(
      FailureRecord.safeParse({
        ...baseCore,
        type: "failure",
        what_was_tried: "tried Y",
        why_it_failed: "didn't work",
      }).success,
    ).toBe(true);
  });
});

describe("AnyRecord discriminated union", () => {
  test("discriminates on type", () => {
    const parsed = AnyRecord.parse({
      ...baseCore,
      type: "decision",
      rationale: "x",
      alternatives_considered: [],
      scope: "global",
    });
    expect(parsed.type).toBe("decision");
  });
  test("rejects when type doesn't match payload", () => {
    expect(
      AnyRecord.safeParse({
        ...baseCore,
        type: "decision",
        // missing rationale + alternatives_considered + scope
      }).success,
    ).toBe(false);
  });
});
