import { describe, test, expect } from "bun:test";
import type { MetaObject } from "@metaobjectsdev/metadata";
import { TypeId, TYPE_IDENTITY,
         FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_STRING, FIELD_SUBTYPE_TIMESTAMP,
         IDENTITY_SUBTYPE_PRIMARY, OBJECT_SUBTYPE_ENTITY } from "@metaobjectsdev/metadata";
import { meta, metaObject, metaField } from "../_meta-build.js";
import { renderZodValidators } from "../../src/templates/zod-validators.js";

function makeEntity(): MetaObject {
  const entity = metaObject(OBJECT_SUBTYPE_ENTITY, "Foo");

  // auto-gen PK — excluded from both schemas
  const id = metaField(FIELD_SUBTYPE_LONG, "id");
  entity.addChild(id);

  // ordinary field — present in both schemas
  const name = metaField(FIELD_SUBTYPE_STRING, "name");
  name.setAttr("required", true);
  entity.addChild(name);

  // @autoSet: "onCreate" — present in insert (transform), OMITTED from update
  const createdAt = metaField(FIELD_SUBTYPE_TIMESTAMP, "createdAt");
  createdAt.setAttr("autoSet", "onCreate");
  entity.addChild(createdAt);

  // @autoSet: "onUpdate" — present in both schemas with transform
  const updatedAt = metaField(FIELD_SUBTYPE_TIMESTAMP, "updatedAt");
  updatedAt.setAttr("autoSet", "onUpdate");
  entity.addChild(updatedAt);

  const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
  primary.setAttr("fields", ["id"]);
  primary.setAttr("generation", "increment");
  entity.addChild(primary);

  return entity;
}

describe("Zod insert schema honors @autoSet", () => {
  test("@autoSet fields use .optional().transform(() => new Date().toISOString())", () => {
    const out = renderZodValidators(makeEntity()).toString();
    expect(out).toContain("export const FooInsertSchema");
    // createdAt: @autoSet onCreate → transform in insert schema
    expect(out).toMatch(/createdAt:.*optional\(\)\.transform\(\(\) => new Date\(\)\.toISOString\(\)\)/);
    // updatedAt: @autoSet onUpdate → transform in insert schema
    expect(out).toMatch(/updatedAt:.*optional\(\)\.transform\(\(\) => new Date\(\)\.toISOString\(\)\)/);
  });

  test("ordinary fields are still emitted normally in insert schema", () => {
    const out = renderZodValidators(makeEntity()).toString();
    expect(out).toMatch(/name:.*z\.string\(\)/);
  });

  test("auto-gen PK is excluded from insert schema", () => {
    const out = renderZodValidators(makeEntity()).toString();
    // id should not appear as a field entry (the string "id:" won't appear)
    expect(out).not.toContain("id:");
  });
});

/** The field-list body of the emitted UpdateSchema object literal (between its
 *  `z.object({` and the closing `})`). Bounds the section so assertions can't
 *  spill into the #203 InsertPreservingSchema that trails the file (which DOES
 *  carry createdAt verbatim — that's the point). */
function updateSchemaBody(out: string): string {
  return out.split("FooUpdateSchema = z.object({")[1]?.split("})")[0] ?? "";
}

describe("Zod update schema omits onCreate, transforms onUpdate", () => {
  test("@autoSet: onCreate field is OMITTED from update schema", () => {
    const out = renderZodValidators(makeEntity()).toString();
    expect(out).toContain("export const FooUpdateSchema");
    // createdAt must not appear in the UpdateSchema body at all.
    expect(updateSchemaBody(out)).not.toContain("createdAt");
  });

  test("@autoSet: onUpdate field is present in update schema with transform", () => {
    const out = renderZodValidators(makeEntity()).toString();
    expect(updateSchemaBody(out)).toMatch(/updatedAt:.*optional\(\)\.transform\(\(\) => new Date\(\)\.toISOString\(\)\)/);
  });

  test("ordinary required fields become optional in update schema", () => {
    const out = renderZodValidators(makeEntity()).toString();
    expect(updateSchemaBody(out)).toMatch(/name:.*optional\(\)/);
  });
});
