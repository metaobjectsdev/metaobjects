import { describe, test, expect } from "bun:test";
import {
  TypeId,
  TYPE_SOURCE,
  TYPE_FIELD,
  SOURCE_SUBTYPE_RDB,
  SOURCE_ATTR_KIND,
  SOURCE_ATTR_TABLE,
  SOURCE_KIND_TABLE,
  SOURCE_KIND_VIEW,
  OBJECT_SUBTYPE_ENTITY,
  OBJECT_SUBTYPE_VALUE,
} from "@metaobjectsdev/metadata";
import { MetaData } from "@metaobjectsdev/metadata";
import { meta, metaObject } from "./_meta-build.js";
import { hasWritableRdbSource, hasAnyRdbSource } from "../src/source-detect.js";

describe("hasWritableRdbSource", () => {
  test("returns false for an object.value with no source children", () => {
    const vo = metaObject(OBJECT_SUBTYPE_VALUE, "SampleOutput");
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

// ---------------------------------------------------------------------------
// Cross-realm (split node_modules tree) — the ts-poet defect class of 0.21.6,
// applied to @metaobjectsdev/metadata. Two physical copies of the package give
// the loader's source nodes a DIFFERENT MetaSource class object than the one
// these helpers close over, so `instanceof MetaSource` is false for a node that
// is a source.rdb in every observable respect.
//
// The CLI closes this by aliasing @metaobjectsdev/metadata to its own copy
// (load-metaobjects-config.ts CLI_PKG_PATHS) — but that alias map runs only for
// `meta gen`; a consumer embedding runGen()/codegen-ts programmatically never
// executes it. The failure is SILENT and severe: the entity reads as "not backed
// by any store", so no Drizzle table, no queries and no routes are emitted for
// it, and nothing errors.
//
// A foreign-realm node is modelled as a MetaData subclass carrying the same
// type/subType and writability surface — which reproduces exactly the observable
// condition (instanceof false, everything else identical) without planting a
// second physical copy of the package on disk.
class ForeignRealmSource extends MetaData {
  isReadOnly(): boolean {
    return this.attr(SOURCE_ATTR_KIND) === SOURCE_KIND_VIEW;
  }
  isWritable(): boolean {
    return !this.isReadOnly();
  }
}

function foreignRdbSource(name: string, kind: string): ForeignRealmSource {
  const src = new ForeignRealmSource(new TypeId(TYPE_SOURCE, SOURCE_SUBTYPE_RDB), name);
  src.setAttr(SOURCE_ATTR_KIND, kind);
  return src;
}

describe("source detection survives a split @metaobjectsdev/metadata tree", () => {
  test("hasAnyRdbSource sees a source.rdb built by a second physical copy", () => {
    const entity = metaObject(OBJECT_SUBTYPE_ENTITY, "Council");
    entity.addChild(foreignRdbSource("source", SOURCE_KIND_TABLE));
    expect(hasAnyRdbSource(entity)).toBe(true);
  });

  test("hasWritableRdbSource sees a writable source.rdb from a second copy", () => {
    const entity = metaObject(OBJECT_SUBTYPE_ENTITY, "Council");
    entity.addChild(foreignRdbSource("source", SOURCE_KIND_TABLE));
    expect(hasWritableRdbSource(entity)).toBe(true);
  });

  test("a read-only kind from a second copy is still not writable", () => {
    // The relaxed guard must not turn every foreign source into a writable one —
    // read-only kinds stay read-only, so the view/table split is still honoured.
    const entity = metaObject(OBJECT_SUBTYPE_ENTITY, "CouncilView");
    entity.addChild(foreignRdbSource("source", SOURCE_KIND_VIEW));
    expect(hasAnyRdbSource(entity)).toBe(true);
    expect(hasWritableRdbSource(entity)).toBe(false);
  });

  test("a non-source child is not mistaken for one", () => {
    // Guards the structural check: type/subType still gate, so an unrelated
    // node that happens to expose isWritable() is not counted as a source.
    const entity = metaObject(OBJECT_SUBTYPE_ENTITY, "Council");
    entity.addChild(meta(new TypeId(TYPE_FIELD, "string"), "name"));
    expect(hasAnyRdbSource(entity)).toBe(false);
    expect(hasWritableRdbSource(entity)).toBe(false);
  });
});
