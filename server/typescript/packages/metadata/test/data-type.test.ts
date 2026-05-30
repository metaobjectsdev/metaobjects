import { describe, it, expect } from "bun:test";
import { DATA_TYPES, DATA_TYPE_STRING, DATA_TYPE_OBJECT, type DataType } from "../src/data-type.js";
import { TypeId } from "../src/registry.js";
import { MetaField } from "../src/core/field/meta-field.js";
import { MetaAttr } from "../src/core/attr/meta-attr.js";

describe("DataType", () => {
  it("DATA_TYPES is the closed set of coarse value types", () => {
    expect([...DATA_TYPES].sort()).toEqual(
      ["boolean", "date", "double", "int", "long", "object", "string"],
    );
  });

  it("the named constants are members of the union", () => {
    const s: DataType = DATA_TYPE_STRING;
    const o: DataType = DATA_TYPE_OBJECT;
    expect(s).toBe("string");
    expect(o).toBe("object");
  });
});

import { TypeRegistry } from "../src/registry.js";
import { registerCoreTypes } from "../src/core-types.js";
import {
  TYPE_FIELD, TYPE_ATTR,
  FIELD_SUBTYPE_STRING, FIELD_SUBTYPE_INT, FIELD_SUBTYPE_LONG,
  FIELD_SUBTYPE_CURRENCY, FIELD_SUBTYPE_DATE, FIELD_SUBTYPE_BOOLEAN,
  FIELD_SUBTYPE_OBJECT, FIELD_SUBTYPE_DOUBLE, FIELD_SUBTYPE_UUID,
  ATTR_SUBTYPE_STRING, ATTR_SUBTYPE_INT, ATTR_SUBTYPE_PROPERTIES,
} from "../src/index.js";

describe("core dataType registration", () => {
  function coreRegistry(): TypeRegistry {
    const r = new TypeRegistry();
    registerCoreTypes(r);
    return r;
  }

  it("field subtypes carry the expected dataType", () => {
    const r = coreRegistry();
    expect(r.find(TYPE_FIELD, FIELD_SUBTYPE_STRING)!.dataType).toBe("string");
    expect(r.find(TYPE_FIELD, FIELD_SUBTYPE_INT)!.dataType).toBe("int");
    expect(r.find(TYPE_FIELD, FIELD_SUBTYPE_LONG)!.dataType).toBe("long");
    expect(r.find(TYPE_FIELD, FIELD_SUBTYPE_CURRENCY)!.dataType).toBe("long");
    expect(r.find(TYPE_FIELD, FIELD_SUBTYPE_DOUBLE)!.dataType).toBe("double");
    expect(r.find(TYPE_FIELD, FIELD_SUBTYPE_BOOLEAN)!.dataType).toBe("boolean");
    expect(r.find(TYPE_FIELD, FIELD_SUBTYPE_DATE)!.dataType).toBe("date");
    expect(r.find(TYPE_FIELD, FIELD_SUBTYPE_OBJECT)!.dataType).toBe("object");
    // R6 Plan 2a: field.uuid binds to TS string (no native UUID type).
    expect(r.find(TYPE_FIELD, FIELD_SUBTYPE_UUID)!.dataType).toBe("string");
  });

  it("attr subtypes carry the expected dataType", () => {
    const r = coreRegistry();
    expect(r.find(TYPE_ATTR, ATTR_SUBTYPE_STRING)!.dataType).toBe("string");
    expect(r.find(TYPE_ATTR, ATTR_SUBTYPE_INT)!.dataType).toBe("int");
    expect(r.find(TYPE_ATTR, ATTR_SUBTYPE_PROPERTIES)!.dataType).toBe("object");
  });

  it("every core field and attr subtype has a dataType", () => {
    const r = coreRegistry();
    for (const id of r.allTypes()) {
      if (id.type === TYPE_FIELD || id.type === TYPE_ATTR) {
        expect(r.find(id.type, id.subType)!.dataType).toBeDefined();
      }
    }
  });
});

describe("MetaField.dataType / MetaAttr.dataType", () => {
  it("a built field node reports its registry-supplied dataType", () => {
    const r = new TypeRegistry();
    registerCoreTypes(r);
    const def = r.find(TYPE_FIELD, FIELD_SUBTYPE_INT)!;
    const node = def.factory(def.typeId, "age") as MetaField;
    expect(node.dataType).toBe("int");
  });

  it("a built attr node reports its registry-supplied dataType", () => {
    const r = new TypeRegistry();
    registerCoreTypes(r);
    const def = r.find(TYPE_ATTR, ATTR_SUBTYPE_INT)!;
    const node = def.factory(def.typeId, "x") as MetaAttr;
    expect(node.dataType).toBe("int");
  });
});

describe("DataType extensibility — a novel subtype", () => {
  it("a provider-registered field subtype flows its dataType to the built node", () => {
    // A provider contributes a brand-new field subtype `field.geopoint` with a
    // `dataType` on its TypeDefinition; its factory stamps the node the same
    // way the core `def()` helper does. The full pipeline — TypeDefinition
    // .dataType → factory → setDataType → MetaField.dataType — is exercised
    // without any edit to data-type.ts or the core registration.
    const r = new TypeRegistry();
    registerCoreTypes(r);
    r.register({
      typeId: new TypeId(TYPE_FIELD, "geopoint"),
      description: "A geographic point field",
      factory: (id, name) => {
        const node = new MetaField(id, name);
        node.setDataType("object");
        return node;
      },
      childRules: [],
      attributes: [],
      dataType: "object",
    });
    const def = r.find(TYPE_FIELD, "geopoint")!;
    expect(def.dataType).toBe("object");
    const node = def.factory(def.typeId, "location") as MetaField;
    expect(node.dataType).toBe("object");
  });
});
