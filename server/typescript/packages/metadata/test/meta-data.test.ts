// FR5a — MetaData.source provenance field tests (Phase 2).

import { describe, test, expect } from "bun:test";
import { TypeId } from "../src/registry.js";
import { MetaRoot } from "../src/shared/meta-root.js";
import { MetaObject } from "../src/core/object/meta-object.js";
import { MetaField } from "../src/core/field/meta-field.js";
import {
  TYPE_METADATA,
  TYPE_OBJECT,
  TYPE_FIELD,
  SUBTYPE_ROOT,
  OBJECT_SUBTYPE_ENTITY,
  FIELD_SUBTYPE_STRING,
  canonicalSerialize,
} from "../src/index.js";

describe("MetaData.source (FR5a)", () => {
  test("programmatic construction defaults source to { format: 'code' }", () => {
    const f = new MetaField(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_STRING), "name");
    expect(f.source).toEqual({ format: "code" });
  });

  test("source persists when assigned via setSource()", () => {
    const o = new MetaObject(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), "User");
    o.setSource({ format: "json", files: ["x.json"], jsonPath: "$.foo" });
    expect(o.source).toEqual({ format: "json", files: ["x.json"], jsonPath: "$.foo" });
  });

  test("source is excluded from canonical JSON serialization", () => {
    const root = new MetaRoot(new TypeId(TYPE_METADATA, SUBTYPE_ROOT), "");
    const o = new MetaObject(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), "User");
    o.setSource({ format: "json", files: ["x.json"], jsonPath: "$" });
    root.addChild(o);
    const ser = canonicalSerialize(root);
    expect(JSON.stringify(ser)).not.toContain("source");
    expect(JSON.stringify(ser)).not.toContain("jsonPath");
  });
});
