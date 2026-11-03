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
import { efcoreConventions } from "../../src/schema-conventions.js";
import { isInvalidCheckNameError } from "../../src/errors.js";

const FIXTURE = join(import.meta.dir, "../../../../../../fixtures/conformance/validator-constraint-name-condition-max/input/meta.checks.json");

async function checks(dialect: "postgres" | "sqlite" = "postgres") {
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(readFileSync(FIXTURE, "utf8"))]);
  expect(errors).toHaveLength(0);
  const t = buildExpectedSchema(root, { dialect }).tables.find((x) => x.name === "StoreHours")!;
  return Object.fromEntries(t.checks.map((c) => [c.name, c.expression]));
}

describe("cross-field CHECK extensions", () => {
  test("@constraintName names the enum, field-validator (length, regex, numeric) and cross-field CHECKs", async () => {
    expect(Object.keys(await checks()).sort()).toEqual([
      "CK_StoreHours_Code",
      "CK_StoreHours_CodeShape",
      "CK_StoreHours_ExactlyOneLocation",
      "CK_StoreHours_Kind",
      "CK_StoreHours_SameDayTimes",
      "CK_StoreHours_StartDay",
    ]);
  });

  test("atLeastOne @max 1 is exactly one present (Postgres num_nonnulls)", async () => {
    expect((await checks())["CK_StoreHours_ExactlyOneLocation"]).toBe('num_nonnulls("store_id", "kiosk_id") = 1');
  });

  test("atLeastOne @max 1 on SQLite counts the present fields", async () => {
    expect((await checks("sqlite"))["CK_StoreHours_ExactlyOneLocation"])
      .toBe('(("store_id" IS NOT NULL) + ("kiosk_id" IS NOT NULL)) = 1');
  });

  test("@condition: the negated condition, then the rule", async () => {
    expect((await checks())["CK_StoreHours_SameDayTimes"]).toBe('("start_day" <> "end_day") OR ("end_time" > "start_time")');
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
    // Two comparisons, the way Postgres stores a BETWEEN, so the CHECK reads back unchanged.
    expect(t.checks.map((c) => c.expression)).toEqual(['num_nonnulls("a", "b", "c") >= 1 AND num_nonnulls("a", "b", "c") <= 2']);
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

/** An entity "T" (table "t") with an id key and the given children, loaded with no errors. */
async function load(children: unknown[]) {
  const doc = { "metadata.root": { package: "acme", children: [{ "object.entity": { name: "T", children: [
    { "source.rdb": { "@table": "t" } }, { "field.long": { name: "id" } },
    { "identity.primary": { name: "pk", "@fields": "id" } },
    ...children,
  ] } }] } };
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(doc))]);
  expect(errors.map((e) => e.message)).toEqual([]);
  return root;
}

async function checksOf(children: unknown[], dialect: "postgres" | "sqlite" = "postgres") {
  const t = buildExpectedSchema(await load(children), { dialect }).tables[0]!;
  return t.checks.map((c) => c.expression);
}

const AB = [{ "field.long": { name: "a" } }, { "field.long": { name: "b" } }];

describe("@condition rendering", () => {
  test("and / or / not / isNull / isNotNull negate by De Morgan, down to the comparisons", async () => {
    const condition = { op: "and", args: [{ op: "isNull", arg: { field: "a" } }, { op: "not", arg: { op: "eq", left: { field: "b" }, right: { value: 1 } } }] };
    expect(await checksOf([...AB, { "validator.atLeastOne": { name: "one", "@fields": ["a", "b"], "@condition": condition } }]))
      .toEqual(['(("a" IS NOT NULL) OR ("b" = 1)) OR ("a" IS NOT NULL OR "b" IS NOT NULL)']);
  });

  test("an isNotNull condition negates to isNull; or negates to and", async () => {
    const condition = { op: "or", args: [{ op: "isNotNull", arg: { field: "a" } }, { op: "gt", left: { field: "b" }, right: { value: 2 } }] };
    expect(await checksOf([...AB, { "validator.atLeastOne": { name: "one", "@fields": ["a", "b"], "@condition": condition } }]))
      .toEqual(['(("a" IS NULL) AND ("b" <= 2)) OR ("a" IS NOT NULL OR "b" IS NOT NULL)']);
  });

  test("coalesce is an operand, not a compound", async () => {
    const condition = { op: "eq", left: { fn: "coalesce", args: [{ field: "a" }, { field: "b" }] }, right: { value: 1 } };
    expect(await checksOf([...AB, { "validator.atLeastOne": { name: "one", "@fields": ["a", "b"], "@condition": condition } }]))
      .toEqual(['(COALESCE("a", "b") <> 1) OR ("a" IS NOT NULL OR "b" IS NOT NULL)']);
  });

  test("a compound comparison operand is parenthesised (IS binds looser than =)", async () => {
    const flag = { "field.boolean": { name: "flag" } };
    const condition = { op: "eq", left: { op: "isNull", arg: { field: "a" } }, right: { field: "flag" } };
    expect(await checksOf([...AB, flag, { "validator.atLeastOne": { name: "one", "@fields": ["a", "b"], "@condition": condition } }]))
      .toEqual(['(("a" IS NULL) <> "flag") OR ("a" IS NOT NULL OR "b" IS NOT NULL)']);
  });

  test("a boolean literal is 1 / 0 on SQLite", async () => {
    const flag = { "field.boolean": { name: "flag" } };
    const condition = { op: "eq", left: { field: "flag" }, right: { value: true } };
    expect(await checksOf([...AB, flag, { "validator.atLeastOne": { name: "one", "@fields": ["a", "b"], "@condition": condition } }], "sqlite"))
      .toEqual(['("flag" <> 1) OR ("a" IS NOT NULL OR "b" IS NOT NULL)']);
  });

  test("an int-backed enum member is compared as its stored integer", async () => {
    const kind = { "field.enum": { name: "kind", "@values": ["Owned", "Shared"], "@intValueMap": { Owned: 1, Shared: 2 } } };
    const condition = { op: "eq", left: { field: "kind" }, right: { value: "Owned" } };
    const out = await checksOf([...AB, kind, { "validator.atLeastOne": { name: "one", "@fields": ["a", "b"], "@condition": condition } }]);
    expect(out).toContain('("kind" <> 1) OR ("a" IS NOT NULL OR "b" IS NOT NULL)');
  });

  test("requiredWhen and presentIff take a @condition too", async () => {
    const kind = { "field.string": { name: "kind" } };
    const condition = { op: "eq", left: { field: "kind" }, right: { value: "x" } };
    const out = await checksOf([...AB, kind,
      { "validator.requiredWhen": { name: "rw", "@field": "a", "@when": "b", "@equals": "1", "@condition": condition } },
      { "validator.presentIff": { name: "pi", "@field": "b", "@when": "a", "@equals": "2", "@condition": condition } },
    ]);
    expect(out).toEqual([
      `("kind" <> 'x') OR (("b" IS DISTINCT FROM 1) OR ("a" IS NOT NULL))`,
      `("kind" <> 'x') OR (("b" IS NOT NULL) = ("a" IS NOT DISTINCT FROM 2))`,
    ]);
  });
});

describe("declared CHECK names", () => {
  const len = (constraintName: string) => ({ "field.string": { name: "code", "@maxLength": 10, children: [
    { "validator.length": { name: "len", "@max": 10, "@constraintName": constraintName } },
  ] } });

  test("two CHECKs on one table with one declared name are refused", async () => {
    const root = await load([...AB,
      { "validator.atLeastOne": { name: "one", "@fields": ["a", "b"], "@constraintName": "CK_T_X" } },
      { "validator.comparison": { name: "cmp", "@left": "a", "@op": "lt", "@right": "b", "@constraintName": "CK_T_X" } },
    ]);
    let err: unknown;
    try { buildExpectedSchema(root, { dialect: "postgres" }); } catch (e) { err = e; }
    expect(isInvalidCheckNameError(err)).toBe(true);
    expect((err as Error).message).toContain('CHECK "CK_T_X" on table "t" has the same name as another CHECK named "CK_T_X"');
  });

  test("a declared name equal to the primary key's is refused", async () => {
    const root = await load([...AB, { "validator.atLeastOne": { name: "one", "@fields": ["a", "b"], "@constraintName": "t_pkey" } }]);
    expect(() => buildExpectedSchema(root, { dialect: "postgres" })).toThrow(/has the same name as the primary key/);
  });

  test("a declared name over 63 bytes is refused on Postgres, accepted on SQLite", async () => {
    const long = "CK_" + "x".repeat(61);
    const root = await load([...AB, { "validator.atLeastOne": { name: "one", "@fields": ["a", "b"], "@constraintName": long } }]);
    expect(() => buildExpectedSchema(root, { dialect: "postgres" })).toThrow(/is 64 bytes; Postgres keeps only the first 63/);
    expect(buildExpectedSchema(root, { dialect: "sqlite" }).tables[0]!.checks.map((c) => c.name)).toEqual([long]);
  });

  test("a declared name keeps a length CHECK skipRedundantChecks would leave out", async () => {
    const opts = { dialect: "postgres", conventions: efcoreConventions, skipRedundantChecks: true } as const;
    const t = buildExpectedSchema(await load([len("CK_T_Code")]), opts).tables[0]!;
    expect(t.checks).toEqual([{ name: "CK_T_Code", expression: 'length("code") <= 10' }]);
    const plain = buildExpectedSchema(await load([{ "field.string": { name: "code", "@maxLength": 10, children: [
      { "validator.length": { name: "len", "@max": 10 } },
    ] } }]), opts).tables[0]!;
    expect(plain.checks).toEqual([]);
  });
});

describe("a duration literal in a CHECK", () => {
  const model = [...AB, { "field.duration": { name: "wait" } }, { "field.string": { name: "label" } },
    { "validator.comparison": { name: "cmp", "@left": "a", "@op": "lt", "@right": "b",
      "@condition": { op: "gt", left: { field: "wait" }, right: { value: "-PT90S" } } } },
    { "validator.requiredWhen": { name: "rw", "@field": "label", "@when": "wait", "@equals": "PT1H" } },
  ];

  test("is the interval spelling on Postgres and the microsecond integer on SQLite", async () => {
    const root = await load(model);
    const on = (dialect: "postgres" | "sqlite") => buildExpectedSchema(root, { dialect }).tables[0]!.checks.map((c) => c.expression);
    expect(on("postgres")).toEqual([
      `("wait" <= '-00:01:30') OR ("a" < "b")`,
      `("wait" IS DISTINCT FROM '01:00:00') OR ("label" IS NOT NULL)`,
    ]);
    expect(on("sqlite")).toEqual([
      `("wait" <= -90000000) OR ("a" < "b")`,
      `("wait" IS NOT 3600000000) OR ("label" IS NOT NULL)`,
    ]);
  });

  test("a literal compared with a coalesce of durations takes the column's form too", async () => {
    const root = await load([...AB, { "field.duration": { name: "wait" } }, { "field.duration": { name: "hold" } },
      { "validator.comparison": { name: "cmp", "@left": "a", "@op": "lt", "@right": "b",
        "@condition": { op: "gt", left: { fn: "coalesce", args: [{ field: "wait" }, { field: "hold" }] }, right: { value: "-PT1M" } } } }]);
    expect(buildExpectedSchema(root, { dialect: "sqlite" }).tables[0]!.checks.map((c) => c.expression))
      .toEqual([`(COALESCE("wait", "hold") <= -60000000) OR ("a" < "b")`]);
    expect(buildExpectedSchema(root, { dialect: "postgres" }).tables[0]!.checks.map((c) => c.expression))
      .toEqual([`(COALESCE("wait", "hold") <= '-00:01:00') OR ("a" < "b")`]);
  });

  test("a literal that is not a duration is refused when the CHECK is built", async () => {
    const root = await load([...AB, { "field.duration": { name: "wait" } },
      { "validator.comparison": { name: "cmp", "@left": "a", "@op": "lt", "@right": "b",
        "@condition": { op: "gt", left: { field: "wait" }, right: { value: "P1M" } } } }]);
    expect(() => buildExpectedSchema(root, { dialect: "postgres" })).toThrow(/compares field.duration 'wait' with "P1M", which is not an ISO-8601 duration/);
  });
});
