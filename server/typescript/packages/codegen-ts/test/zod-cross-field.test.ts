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
  test("insert schema is refined; update schema is byte-for-byte what it was without validators", () => {
    const withV = renderZodValidators(sample()).toString();
    const without = renderZodValidators(entityWith("Thing", [
      f(FIELD_SUBTYPE_INT, "a"), f(FIELD_SUBTYPE_INT, "b"), f(FIELD_SUBTYPE_STRING, "kind"),
      f(FIELD_SUBTYPE_STRING, "target"), f(FIELD_SUBTYPE_BOOLEAN, "flag"), f(FIELD_SUBTYPE_INT, "level"),
      f(FIELD_SUBTYPE_STRING, "email"), f(FIELD_SUBTYPE_STRING, "phone"),
    ], [])).toString();
    expect(withV).toContain(".superRefine(");
    expect(without).not.toContain("superRefine");
    const upd = (s: string) => s.slice(s.indexOf("export const ThingUpdateSchema"));
    expect(upd(withV)).toBe(upd(without));
    expect(upd(withV)).not.toContain("superRefine");
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
    expect(renderZodValidators(e).toString()).not.toContain("superRefine");
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
