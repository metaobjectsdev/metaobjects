// Entity-scoped cross-field validators (comparison / requiredWhen / presentIff /
// atLeastOne) are enforced by a `.superRefine` on the INSERT-shaped schemas ONLY.
// Execution pins (render -> import -> safeParse), plus the "update schema unchanged" pin.

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  TypeId, TYPE_IDENTITY, TYPE_VALIDATOR,
  IDENTITY_SUBTYPE_PRIMARY, OBJECT_SUBTYPE_ENTITY,
  FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_INT, FIELD_SUBTYPE_STRING, FIELD_SUBTYPE_BOOLEAN,
  VALIDATOR_SUBTYPE_COMPARISON, VALIDATOR_SUBTYPE_REQUIRED_WHEN,
  VALIDATOR_SUBTYPE_PRESENT_IFF, VALIDATOR_SUBTYPE_AT_LEAST_ONE,
  VALIDATOR_ATTR_LEFT, VALIDATOR_ATTR_OP, VALIDATOR_ATTR_RIGHT,
  VALIDATOR_ATTR_FIELD, VALIDATOR_ATTR_WHEN, VALIDATOR_ATTR_EQUALS, VALIDATOR_ATTR_FIELDS,
  VALIDATOR_ATTR_CONDITION, FIELD_SUBTYPE_DATE, FIELD_SUBTYPE_TIMESTAMP, FIELD_SUBTYPE_DURATION,
} from "@metaobjectsdev/metadata";
import type { AttrValue, MetaField, MetaObject } from "@metaobjectsdev/metadata";
import { meta, metaObject, metaField } from "./_meta-build.js";
import { renderZodValidators, hasInsertRefinements } from "../src/templates/zod-validators.js";

// biome-ignore lint/suspicious/noExplicitAny: dynamically imported generated module — no static shape
type GeneratedModule = Record<string, any>;

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

async function executeGenerated(source: string): Promise<GeneratedModule> {
  const dir = mkdtempSync(join(import.meta.dir, "tmp-zod-xf-"));
  tmpDirs.push(dir);
  const file = join(dir, "schema.ts");
  writeFileSync(file, source);
  return import(pathToFileURL(file).href);
}

function entityWith(name: string, fields: MetaField[], validators: ReturnType<typeof validator>[]): MetaObject {
  const obj = metaObject(OBJECT_SUBTYPE_ENTITY, name);
  obj.addChild(metaField(FIELD_SUBTYPE_LONG, "id"));
  for (const f of fields) obj.addChild(f);
  const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
  primary.setAttr("fields", ["id"]);
  primary.setAttr("generation", "increment");
  obj.addChild(primary);
  for (const v of validators) obj.addChild(v);
  return obj;
}

function validator(subType: string, name: string, attrs: Record<string, AttrValue>) {
  const v = meta(new TypeId(TYPE_VALIDATOR, subType), name);
  for (const [k, val] of Object.entries(attrs)) v.setAttr(k, val);
  return v;
}

const f = (sub: string, name: string) => metaField(sub, name);

function sample(): MetaObject {
  return entityWith("Thing", [
    f(FIELD_SUBTYPE_INT, "a"), f(FIELD_SUBTYPE_INT, "b"), f(FIELD_SUBTYPE_STRING, "kind"),
    f(FIELD_SUBTYPE_STRING, "target"), f(FIELD_SUBTYPE_BOOLEAN, "flag"), f(FIELD_SUBTYPE_INT, "level"),
    f(FIELD_SUBTYPE_STRING, "email"), f(FIELD_SUBTYPE_STRING, "phone"),
  ], [
    validator(VALIDATOR_SUBTYPE_COMPARISON, "cmp", { [VALIDATOR_ATTR_LEFT]: "a", [VALIDATOR_ATTR_OP]: "lt", [VALIDATOR_ATTR_RIGHT]: "b" }),
    validator(VALIDATOR_SUBTYPE_REQUIRED_WHEN, "rw", { [VALIDATOR_ATTR_FIELD]: "target", [VALIDATOR_ATTR_WHEN]: "kind", [VALIDATOR_ATTR_EQUALS]: "X" }),
    validator(VALIDATOR_SUBTYPE_PRESENT_IFF, "pi", { [VALIDATOR_ATTR_FIELD]: "target", [VALIDATOR_ATTR_WHEN]: "flag", [VALIDATOR_ATTR_EQUALS]: "true" }),
    validator(VALIDATOR_SUBTYPE_AT_LEAST_ONE, "alo", { [VALIDATOR_ATTR_FIELDS]: ["email", "phone"] }),
  ]);
}

describe("cross-field validators on the insert schema", () => {
  test("the update schema does not enforce the rules: a partial body cannot see the merged row", async () => {
    const mod = await executeGenerated(renderZodValidators(sample()).toString());
    const violating = { a: 5, b: 1, kind: "X" };
    expect(mod.ThingInsertSchema.safeParse(violating).success).toBe(false);
    expect(mod.ThingUpdateSchema.safeParse(violating).success).toBe(true);
    expect(mod.ThingUpdateSchema.safeParse({ a: 5 }).success).toBe(true);
    expect(hasInsertRefinements(sample())).toBe(true);
  });

  test("comparison, requiredWhen, presentIff, atLeastOne", async () => {
    const mod = await executeGenerated(renderZodValidators(sample()).toString());
    const ok = (v: unknown) => mod.ThingInsertSchema.safeParse(v).success;
    const base = { a: 1, b: 2, kind: "Y", email: "e" };
    expect(ok(base)).toBe(true);
    expect(ok({ ...base, a: 2 })).toBe(false);              // lt violated on equality
    expect(ok({ ...base, a: undefined })).toBe(true);        // null side passes
    expect(ok({ ...base, kind: "X" })).toBe(false);          // requiredWhen: target missing
    expect(ok({ ...base, kind: "X", target: "t", flag: true })).toBe(true);
    expect(ok({ ...base, flag: true, target: "t" })).toBe(true);
    expect(ok({ ...base, target: "t" })).toBe(false);        // presentIff: null gate => target must be absent
    expect(ok({ ...base, flag: false, target: "t" })).toBe(false);
    expect(ok({ a: 1, b: 2, kind: "Y" })).toBe(false);       // atLeastOne
    expect(ok({ ...base, email: "" })).toBe(true);           // "" is not null
    const issues = mod.ThingInsertSchema.safeParse({ ...base, a: 5 });
    expect(issues.error.issues[0].path).toEqual(["a"]);
  });

  test("a validator referencing a missing field is skipped silently", async () => {
    const e = entityWith("Solo", [f(FIELD_SUBTYPE_INT, "a")], [
      validator(VALIDATOR_SUBTYPE_COMPARISON, "cmp", { [VALIDATOR_ATTR_LEFT]: "a", [VALIDATOR_ATTR_OP]: "lt", [VALIDATOR_ATTR_RIGHT]: "nope" }),
    ]);
    const mod = await executeGenerated(renderZodValidators(e).toString());
    expect(mod.SoloInsertSchema.safeParse({ a: 5 }).success).toBe(true);
    expect(hasInsertRefinements(e)).toBe(false);
  });

  test("a comparison or gate on an array field is skipped, as in the other ports", async () => {
    const nums = f(FIELD_SUBTYPE_INT, "nums");
    nums.setIsArray(true);
    const e = entityWith("Arr", [nums, f(FIELD_SUBTYPE_INT, "b"), f(FIELD_SUBTYPE_STRING, "note")], [
      validator(VALIDATOR_SUBTYPE_COMPARISON, "cmp", { [VALIDATOR_ATTR_LEFT]: "nums", [VALIDATOR_ATTR_OP]: "lt", [VALIDATOR_ATTR_RIGHT]: "b" }),
      validator(VALIDATOR_SUBTYPE_REQUIRED_WHEN, "rw", { [VALIDATOR_ATTR_FIELD]: "note", [VALIDATOR_ATTR_WHEN]: "nums", [VALIDATOR_ATTR_EQUALS]: "1" }),
    ]);
    const mod = await executeGenerated(renderZodValidators(e).toString());
    expect(mod.ArrInsertSchema.safeParse({ nums: [1, 2], b: 5 }).success).toBe(true);
    expect(mod.ArrInsertSchema.safeParse({ nums: [1], b: 0 }).success).toBe(true);
  });

  test("a rule left to the database declares no helper: nothing unused reaches the schema", async () => {
    // Each rule below asks for a helper and is then dropped: its condition compares a date with a
    // timestamp, which has no order. The one rule kept needs no helper.
    const crossKind = { op: "gt", left: { field: "d" }, right: { field: "t" } };
    const e = entityWith("Kept", [
      f(FIELD_SUBTYPE_INT, "a"), f(FIELD_SUBTYPE_INT, "b"), f(FIELD_SUBTYPE_DATE, "d"),
      f(FIELD_SUBTYPE_TIMESTAMP, "t"), f(FIELD_SUBTYPE_DURATION, "p"), f(FIELD_SUBTYPE_DURATION, "q"),
      f(FIELD_SUBTYPE_STRING, "kind"), f(FIELD_SUBTYPE_STRING, "note"),
    ], [
      validator(VALIDATOR_SUBTYPE_AT_LEAST_ONE, "and", {
        [VALIDATOR_ATTR_FIELDS]: ["note"],
        [VALIDATOR_ATTR_CONDITION]: { op: "and", args: [{ op: "gt", left: { field: "a" }, right: { field: "b" } }, crossKind] },
      }),
      validator(VALIDATOR_SUBTYPE_COMPARISON, "span", {
        [VALIDATOR_ATTR_LEFT]: "p", [VALIDATOR_ATTR_OP]: "lte", [VALIDATOR_ATTR_RIGHT]: "q", [VALIDATOR_ATTR_CONDITION]: crossKind,
      }),
      validator(VALIDATOR_SUBTYPE_REQUIRED_WHEN, "rw", { [VALIDATOR_ATTR_FIELD]: "note", [VALIDATOR_ATTR_WHEN]: "kind", [VALIDATOR_ATTR_EQUALS]: "X" }),
    ]);
    const out = renderZodValidators(e).toString();
    expect(out).toContain(".superRefine(");
    expect(out).not.toContain("const cmp = ");
    expect(out).not.toContain("const all = ");
    expect(out).not.toContain("const micros = (d");
  });

  test("two durations compare by length, and text that is no duration is unchecked like a null side", async () => {
    const e = entityWith("Span", [f(FIELD_SUBTYPE_DURATION, "p"), f(FIELD_SUBTYPE_DURATION, "q")], [
      validator(VALIDATOR_SUBTYPE_COMPARISON, "span", { [VALIDATOR_ATTR_LEFT]: "p", [VALIDATOR_ATTR_OP]: "lte", [VALIDATOR_ATTR_RIGHT]: "q" }),
    ]);
    const out = renderZodValidators(e).toString();
    // The refinement's parser accepts only what the field's own schema accepts: no bare `P`, `PT`
    // or `P1DT`, so text that is no duration reads as null (unchecked) rather than as a zero span.
    const parser = out.slice(out.indexOf("const micros = (d"));
    expect(parser).toContain("P(?!$)");
    expect(parser).toContain("T(?=\\d)");
    expect(parser).not.toContain("?? 0) - (micros(");
    const mod = await executeGenerated(out);
    expect(mod.SpanInsertSchema.safeParse({ p: "PT1H30M", q: "PT1H" }).success).toBe(false);
    expect(mod.SpanInsertSchema.safeParse({ p: "PT45M", q: "PT1H" }).success).toBe(true);
  });

  test("numeric @equals compares numerically against the gate field", async () => {
    const e = entityWith("Lv", [f(FIELD_SUBTYPE_INT, "level"), f(FIELD_SUBTYPE_STRING, "note")], [
      validator(VALIDATOR_SUBTYPE_REQUIRED_WHEN, "rw", { [VALIDATOR_ATTR_FIELD]: "note", [VALIDATOR_ATTR_WHEN]: "level", [VALIDATOR_ATTR_EQUALS]: "3" }),
    ]);
    const mod = await executeGenerated(renderZodValidators(e).toString());
    expect(mod.LvInsertSchema.safeParse({ level: 3 }).success).toBe(false);
    expect(mod.LvInsertSchema.safeParse({ level: 4 }).success).toBe(true);
    expect(mod.LvInsertSchema.safeParse({ level: 3, note: "n" }).success).toBe(true);
  });
});
