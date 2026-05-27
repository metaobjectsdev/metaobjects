import { describe, test, expect } from "bun:test";
import {
  TypeId,
  TYPE_SOURCE,
  SOURCE_SUBTYPE_RDB,
  SOURCE_ATTR_KIND,
  SOURCE_ATTR_TABLE,
  SOURCE_KIND_TABLE,
  SOURCE_KIND_VIEW,
  OBJECT_SUBTYPE_ENTITY,
  OBJECT_SUBTYPE_VALUE,
} from "@metaobjectsdev/metadata";
import { meta, metaObject } from "./_meta-build.js";
import { hasWritableRdbSource } from "../src/source-detect.js";

describe("hasWritableRdbSource", () => {
  test("returns false for an object.value with no source children", () => {
    const vo = metaObject(OBJECT_SUBTYPE_VALUE, "WizardOutput");
    expect(hasWritableRdbSource(vo)).toBe(false);
  });

  test("returns true for an entity with source.rdb (default kind=table)", () => {
    const entity = metaObject(OBJECT_SUBTYPE_ENTITY, "Council");
    const source = meta(new TypeId(TYPE_SOURCE, SOURCE_SUBTYPE_RDB), "source");
    source.setAttr(SOURCE_ATTR_TABLE, "councils");
    entity.addChild(source);
    expect(hasWritableRdbSource(entity)).toBe(true);
  });

  test("returns true for an entity with explicit kind=table", () => {
    const entity = metaObject(OBJECT_SUBTYPE_ENTITY, "Council");
    const source = meta(new TypeId(TYPE_SOURCE, SOURCE_SUBTYPE_RDB), "source");
    source.setAttr(SOURCE_ATTR_TABLE, "councils");
    source.setAttr(SOURCE_ATTR_KIND, SOURCE_KIND_TABLE);
    entity.addChild(source);
    expect(hasWritableRdbSource(entity)).toBe(true);
  });

  test("returns false for an entity whose only source.rdb is kind=view (read-only)", () => {
    const entity = metaObject(OBJECT_SUBTYPE_ENTITY, "CouncilView");
    const source = meta(new TypeId(TYPE_SOURCE, SOURCE_SUBTYPE_RDB), "source");
    source.setAttr(SOURCE_ATTR_TABLE, "council_view");
    source.setAttr(SOURCE_ATTR_KIND, SOURCE_KIND_VIEW);
    entity.addChild(source);
    expect(hasWritableRdbSource(entity)).toBe(false);
  });

  test("returns true when one of multiple sources is writable (CQRS write-through)", () => {
    const entity = metaObject(OBJECT_SUBTYPE_ENTITY, "Council");
    const writable = meta(new TypeId(TYPE_SOURCE, SOURCE_SUBTYPE_RDB), "primary");
    writable.setAttr(SOURCE_ATTR_TABLE, "councils");
    writable.setAttr(SOURCE_ATTR_KIND, SOURCE_KIND_TABLE);
    entity.addChild(writable);
    const readOnly = meta(new TypeId(TYPE_SOURCE, SOURCE_SUBTYPE_RDB), "replica");
    readOnly.setAttr(SOURCE_ATTR_TABLE, "council_view");
    readOnly.setAttr(SOURCE_ATTR_KIND, SOURCE_KIND_VIEW);
    entity.addChild(readOnly);
    expect(hasWritableRdbSource(entity)).toBe(true);
  });
});
