import { describe, test, expect } from "bun:test";
import { registerColumnNamingStrategy, resetNamingStrategiesForTesting, toSnakeCase } from "@metaobjectsdev/metadata";
import {
  columnNameFromField,
  tableNameFromEntity,
  viewNameFromProjection,
} from "../../src/naming.js";

describe("columnNameFromField — strategy-aware", () => {
  test("snake_case converts camelCase to underscored lowercase", () => {
    expect(columnNameFromField("firstName", "snake_case")).toBe("first_name");
    expect(columnNameFromField("APIKey", "snake_case")).toBe("api_key");
    expect(columnNameFromField("id", "snake_case")).toBe("id");
  });
  test("literal leaves the field name unchanged", () => {
    expect(columnNameFromField("firstName", "literal")).toBe("firstName");
    expect(columnNameFromField("APIKey", "literal")).toBe("APIKey");
  });
  test("kebab-case converts camelCase to hyphenated lowercase", () => {
    expect(columnNameFromField("firstName", "kebab-case")).toBe("first-name");
    expect(columnNameFromField("APIKey", "kebab-case")).toBe("api-key");
    expect(columnNameFromField("id", "kebab-case")).toBe("id");
  });
});

describe("tableNameFromEntity — strategy-aware + pluralized", () => {
  test("snake_case: Subscriber → subscribers", () => {
    expect(tableNameFromEntity("Subscriber", "snake_case")).toBe("subscribers");
  });
  test("snake_case: ProgramWeek → program_weeks", () => {
    expect(tableNameFromEntity("ProgramWeek", "snake_case")).toBe("program_weeks");
  });
  test("literal: Subscriber → Subscribers", () => {
    expect(tableNameFromEntity("Subscriber", "literal")).toBe("Subscribers");
  });
});

describe("viewNameFromProjection — v_ prefix + strategy", () => {
  test("snake_case: ProgramSummary → v_program_summary", () => {
    expect(viewNameFromProjection("ProgramSummary", "snake_case")).toBe("v_program_summary");
  });
  test("literal: ProgramSummary → v_ProgramSummary", () => {
    expect(viewNameFromProjection("ProgramSummary", "literal")).toBe("v_ProgramSummary");
  });
  test("kebab-case: ProgramSummary → v-program-summary", () => {
    expect(viewNameFromProjection("ProgramSummary", "kebab-case")).toBe("v-program-summary");
  });
  test("pascal: ProgramSummary → v_ProgramSummary", () => {
    expect(viewNameFromProjection("ProgramSummary", "pascal")).toBe("v_ProgramSummary");
  });
  // The prefix's separator is the one the strategy puts between words, read from the strategy
  // rather than from a switch on built-in names, so an application's strategy gets it too.
  test("an application strategy: the prefix takes its word separator", () => {
    try {
      registerColumnNamingStrategy("test-dotted", (n) => toSnakeCase(n).replace(/_/g, "."));
      registerColumnNamingStrategy("test-upper-snake", (n) => toSnakeCase(n).toUpperCase());
      expect(viewNameFromProjection("ProgramSummary", "test-dotted")).toBe("v.program.summary");
      expect(viewNameFromProjection("ProgramSummary", "test-upper-snake")).toBe("v_PROGRAM_SUMMARY");
    } finally {
      resetNamingStrategiesForTesting();
    }
  });
});
