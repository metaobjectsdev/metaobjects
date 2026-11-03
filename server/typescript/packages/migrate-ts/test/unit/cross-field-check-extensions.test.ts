/**
 * CHECKs a database names by hand, an exactly-one presence rule, and a rule that applies in
 * one case only:
 *  - `@constraintName` on a validator or a field.enum is the CHECK's database name;
 *  - `validator.atLeastOne @max` bounds the present fields (`@max: 1` = exactly one);
 *  - `@condition` on a cross-field validator: the CHECK is the negated condition OR the rule,
 *    the negation pushed into the comparison so it reads as written by hand.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";

const FIXTURE = join(import.meta.dir, "../../../../../../fixtures/conformance/validator-constraint-name-condition-max/input/meta.checks.json");

async function checks(dialect: "postgres" | "sqlite" = "postgres") {
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(readFileSync(FIXTURE, "utf8"))]);
  expect(errors).toHaveLength(0);
  const t = buildExpectedSchema(root, { dialect }).tables.find((x) => x.name === "OfficeHours")!;
  return Object.fromEntries(t.checks.map((c) => [c.name, c.expression]));
}

describe("cross-field CHECK extensions", () => {
  test("@constraintName names the enum, field-validator (length, regex, numeric) and cross-field CHECKs", async () => {
    expect(Object.keys(await checks()).sort()).toEqual([
      "CK_OfficeHours_Code",
      "CK_OfficeHours_CodeShape",
      "CK_OfficeHours_ExactlyOneSource",
      "CK_OfficeHours_Kind",
      "CK_OfficeHours_SameDayValidation",
      "CK_OfficeHours_StartDay",
    ]);
  });

  test("atLeastOne @max 1 is exactly one present (Postgres num_nonnulls)", async () => {
    expect((await checks())["CK_OfficeHours_ExactlyOneSource"]).toBe('num_nonnulls("patient_id", "caregiver_id") = 1');
  });

  test("atLeastOne @max 1 on SQLite counts the present fields", async () => {
    expect((await checks("sqlite"))["CK_OfficeHours_ExactlyOneSource"])
      .toBe('(("patient_id" IS NOT NULL) + ("caregiver_id" IS NOT NULL)) = 1');
  });

  test("@condition: the negated condition, then the rule", async () => {
    expect((await checks())["CK_OfficeHours_SameDayValidation"]).toBe('("start_day" <> "end_day") OR ("end_time" > "start_time")');
  });

  test("atLeastOne @max above 1 is a range", async () => {
    const doc = { "metadata.root": { package: "acme", children: [{ "object.entity": { name: "T", children: [
      { "source.rdb": { "@table": "t" } }, { "field.long": { name: "id" } },
      { "field.long": { name: "a" } }, { "field.long": { name: "b" } }, { "field.long": { name: "c" } },
      { "identity.primary": { name: "pk", "@fields": "id" } },
      { "validator.atLeastOne": { name: "few", "@fields": ["a", "b", "c"], "@max": 2 } },
    ] } }] } };
    const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(doc))]);
    expect(errors).toHaveLength(0);
    const t = buildExpectedSchema(root, { dialect: "postgres" }).tables[0]!;
    expect(t.checks.map((c) => c.expression)).toEqual(['num_nonnulls("a", "b", "c") BETWEEN 1 AND 2']);
  });

  test("no @max, no @condition, no @constraintName: unchanged", async () => {
    const doc = { "metadata.root": { package: "acme", children: [{ "object.entity": { name: "T", children: [
      { "source.rdb": { "@table": "t" } }, { "field.long": { name: "id" } },
      { "field.long": { name: "a" } }, { "field.long": { name: "b" } },
      { "identity.primary": { name: "pk", "@fields": "id" } },
      { "validator.atLeastOne": { name: "one", "@fields": ["a", "b"] } },
    ] } }] } };
    const { root } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(doc))]);
    const t = buildExpectedSchema(root, { dialect: "postgres" }).tables[0]!;
    expect(t.checks).toEqual([{ name: "t_a_atleastone_chk", expression: '"a" IS NOT NULL OR "b" IS NOT NULL' }]);
  });
});
