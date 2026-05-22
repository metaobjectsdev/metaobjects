import { describe, it, expect } from "bun:test";
import { TypeId } from "../../src/registry.js";
import { MetaData } from "../../src/meta/meta-data.js";
import { MetaObject } from "../../src/meta/meta-object.js";
import { MetaField } from "../../src/meta/meta-field.js";
import {
  TYPE_OBJECT,
  TYPE_FIELD,
  TYPE_IDENTITY,
  TYPE_RELATIONSHIP,
  TYPE_VALIDATOR,
  TYPE_SOURCE,
  TYPE_LAYOUT,
  OBJECT_SUBTYPE_ENTITY,
  OBJECT_SUBTYPE_VALUE,
  SUBTYPE_BASE,
  SOURCE_SUBTYPE_DB_TABLE,
  SOURCE_DB_TABLE_ATTR_NAME,
  IDENTITY_SUBTYPE_PRIMARY,
  IDENTITY_SUBTYPE_SECONDARY,
  FIELD_SUBTYPE_LONG,
  FIELD_SUBTYPE_STRING,
  VALIDATOR_SUBTYPE_REQUIRED,
  RELATIONSHIP_SUBTYPE_ASSOCIATION,
  IDENTITY_ATTR_FIELDS,
  LAYOUT_SUBTYPE_DATA_GRID,
} from "../../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal concrete MetaData subclass for constructing non-typed test nodes. */
class TestNode extends MetaData {}

function makeField(name: string, subType = FIELD_SUBTYPE_STRING): MetaField {
  return new MetaField(new TypeId(TYPE_FIELD, subType), name);
}

function makeIdentity(name: string, subType: string, fields: string[]): MetaData {
  const node = new TestNode(new TypeId(TYPE_IDENTITY, subType), name);
  node.setAttr(IDENTITY_ATTR_FIELDS, fields);
  return node;
}

function makeSource(subType: string, tableName: string): MetaData {
  const node = new TestNode(new TypeId(TYPE_SOURCE, subType), subType);
  node.setAttr(SOURCE_DB_TABLE_ATTR_NAME, tableName);
  return node;
}

function makeValidator(subType: string): MetaData {
  return new TestNode(new TypeId(TYPE_VALIDATOR, subType), subType);
}

function makeRelationship(name: string): MetaData {
  return new TestNode(new TypeId(TYPE_RELATIONSHIP, RELATIONSHIP_SUBTYPE_ASSOCIATION), name);
}

function makeLayout(name: string): MetaData {
  return new TestNode(new TypeId(TYPE_LAYOUT, LAYOUT_SUBTYPE_DATA_GRID), name);
}

function makeObject(name: string, subType = OBJECT_SUBTYPE_ENTITY): MetaObject {
  return new MetaObject(new TypeId(TYPE_OBJECT, subType), name);
}

// ---------------------------------------------------------------------------
// MetaObject.isEntity / isValue
// ---------------------------------------------------------------------------

describe("MetaObject.isEntity / isValue", () => {
  it("isEntity returns true for entity subtype", () => {
    const obj = makeObject("User", OBJECT_SUBTYPE_ENTITY);
    expect(obj.isEntity()).toBe(true);
    expect(obj.isValue()).toBe(false);
  });

  it("isValue returns true for value subtype", () => {
    const obj = makeObject("Money", OBJECT_SUBTYPE_VALUE);
    expect(obj.isValue()).toBe(true);
    expect(obj.isEntity()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MetaObject.dbTable
// ---------------------------------------------------------------------------

describe("MetaObject.dbTable", () => {
  it("returns the source[dbTable]@name when present", () => {
    const obj = makeObject("User");
    const source = makeSource(SOURCE_SUBTYPE_DB_TABLE, "users");
    obj.addChild(source);
    obj.freeze();
    expect(obj.dbTable).toBe("users");
  });

  it("returns undefined when no source[dbTable] child", () => {
    const obj = makeObject("User");
    obj.freeze();
    expect(obj.dbTable).toBeUndefined();
  });

  it("returns undefined when source exists but @name is empty string", () => {
    const obj = makeObject("User");
    const source = new TestNode(new TypeId(TYPE_SOURCE, SOURCE_SUBTYPE_DB_TABLE), SOURCE_SUBTYPE_DB_TABLE);
    source.setAttr(SOURCE_DB_TABLE_ATTR_NAME, "");
    obj.addChild(source);
    obj.freeze();
    expect(obj.dbTable).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// MetaObject.fields / ownFields
// ---------------------------------------------------------------------------

describe("MetaObject.fields / ownFields", () => {
  it("fields() returns own fields on a flat object", () => {
    const obj = makeObject("User");
    obj.addChild(makeField("id", FIELD_SUBTYPE_LONG));
    obj.addChild(makeField("email"));
    obj.freeze();

    const names = obj.fields().map((f) => f.name);
    expect(names).toEqual(["id", "email"]);
  });

  it("ownFields() returns only own fields", () => {
    const obj = makeObject("User");
    obj.addChild(makeField("id", FIELD_SUBTYPE_LONG));
    obj.addChild(makeField("email"));
    obj.freeze();

    const names = obj.ownFields().map((f) => f.name);
    expect(names).toEqual(["id", "email"]);
  });

  it("fields() includes super-chain-inherited fields", () => {
    const base = makeObject("BaseEntity");
    base.addChild(makeField("id", FIELD_SUBTYPE_LONG));
    base.addChild(makeField("createdAt", FIELD_SUBTYPE_STRING));
    base.freeze();

    const child = makeObject("Subscriber");
    child.addChild(makeField("email"));
    child.setSuperResolved(base);
    child.freeze();

    const names = child.fields().map((f) => f.name);
    expect(names).toContain("id");
    expect(names).toContain("createdAt");
    expect(names).toContain("email");
  });

  it("ownFields() excludes inherited fields", () => {
    const base = makeObject("BaseEntity");
    base.addChild(makeField("id", FIELD_SUBTYPE_LONG));
    base.addChild(makeField("createdAt", FIELD_SUBTYPE_STRING));
    base.freeze();

    const child = makeObject("Subscriber");
    child.addChild(makeField("email"));
    child.setSuperResolved(base);
    child.freeze();

    const ownNames = child.ownFields().map((f) => f.name);
    expect(ownNames).not.toContain("id");
    expect(ownNames).not.toContain("createdAt");
    expect(ownNames).toContain("email");
  });

  it("fields() result is same array reference on repeat call after freeze (caching)", () => {
    const obj = makeObject("User");
    obj.addChild(makeField("id"));
    obj.freeze();
    expect(obj.fields()).toBe(obj.fields());
  });
});

// ---------------------------------------------------------------------------
// MetaObject.findField
// ---------------------------------------------------------------------------

describe("MetaObject.findField", () => {
  it("finds own field by name", () => {
    const obj = makeObject("User");
    obj.addChild(makeField("email"));
    obj.freeze();
    expect(obj.findField("email")?.name).toBe("email");
  });

  it("returns undefined for missing field", () => {
    const obj = makeObject("User");
    obj.freeze();
    expect(obj.findField("nope")).toBeUndefined();
  });

  it("walks the super chain", () => {
    const base = makeObject("BaseEntity");
    base.addChild(makeField("id", FIELD_SUBTYPE_LONG));
    base.freeze();

    const child = makeObject("Subscriber");
    child.addChild(makeField("email"));
    child.setSuperResolved(base);
    child.freeze();

    expect(child.findField("id")?.name).toBe("id");       // inherited
    expect(child.findField("email")?.name).toBe("email");  // own
    expect(child.findField("missing")).toBeUndefined();
  });

  it("findField result is same reference on repeat call after freeze (caching)", () => {
    const obj = makeObject("User");
    obj.addChild(makeField("email"));
    obj.freeze();
    expect(obj.findField("email")).toBe(obj.findField("email"));
  });
});

// ---------------------------------------------------------------------------
// MetaObject.identities / ownIdentities / primaryIdentity / secondaryIdentities
// ---------------------------------------------------------------------------

describe("MetaObject.identities", () => {
  it("identities() returns all effective identity children", () => {
    const obj = makeObject("User");
    obj.addChild(makeIdentity("pk", IDENTITY_SUBTYPE_PRIMARY, ["id"]));
    obj.addChild(makeIdentity("byEmail", IDENTITY_SUBTYPE_SECONDARY, ["email"]));
    obj.freeze();

    expect(obj.identities()).toHaveLength(2);
    expect(obj.identities().every((i) => i.type === TYPE_IDENTITY)).toBe(true);
  });

  it("ownIdentities() excludes inherited identities", () => {
    const base = makeObject("BaseEntity");
    base.addChild(makeIdentity("pk", IDENTITY_SUBTYPE_PRIMARY, ["id"]));
    base.freeze();

    const child = makeObject("Subscriber");
    child.addChild(makeIdentity("byEmail", IDENTITY_SUBTYPE_SECONDARY, ["email"]));
    child.setSuperResolved(base);
    child.freeze();

    // identities() is effective — includes inherited pk
    expect(child.identities()).toHaveLength(2);
    // ownIdentities() is own-only — only byEmail
    const ownNames = child.ownIdentities().map((i) => i.name);
    expect(ownNames).not.toContain("pk");
    expect(ownNames).toContain("byEmail");
  });

  it("primaryIdentity() returns the primary identity node", () => {
    const obj = makeObject("User");
    obj.addChild(makeIdentity("pk", IDENTITY_SUBTYPE_PRIMARY, ["id"]));
    obj.addChild(makeIdentity("byEmail", IDENTITY_SUBTYPE_SECONDARY, ["email"]));
    obj.freeze();

    const pk = obj.primaryIdentity();
    expect(pk).toBeDefined();
    expect(pk!.subType).toBe(IDENTITY_SUBTYPE_PRIMARY);
  });

  it("primaryIdentity() returns undefined when none present", () => {
    const obj = makeObject("User");
    obj.freeze();
    expect(obj.primaryIdentity()).toBeUndefined();
  });

  it("secondaryIdentities() returns only secondary identities", () => {
    const obj = makeObject("User");
    obj.addChild(makeIdentity("pk", IDENTITY_SUBTYPE_PRIMARY, ["id"]));
    obj.addChild(makeIdentity("byEmail", IDENTITY_SUBTYPE_SECONDARY, ["email"]));
    obj.addChild(makeIdentity("bySlug", IDENTITY_SUBTYPE_SECONDARY, ["slug"]));
    obj.freeze();

    const sec = obj.secondaryIdentities();
    expect(sec).toHaveLength(2);
    expect(sec.every((i) => i.subType === IDENTITY_SUBTYPE_SECONDARY)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MetaObject.relationships / ownRelationships
// ---------------------------------------------------------------------------

describe("MetaObject.relationships / ownRelationships", () => {
  it("relationships() returns effective relationship children", () => {
    const obj = makeObject("User");
    obj.addChild(makeRelationship("posts"));
    obj.freeze();

    expect(obj.relationships()).toHaveLength(1);
    expect(obj.relationships()[0]!.name).toBe("posts");
  });

  it("ownRelationships() excludes inherited relationships", () => {
    const base = makeObject("BaseEntity");
    base.addChild(makeRelationship("audit"));
    base.freeze();

    const child = makeObject("Subscriber");
    child.addChild(makeRelationship("orders"));
    child.setSuperResolved(base);
    child.freeze();

    expect(child.relationships()).toHaveLength(2);
    expect(child.ownRelationships()).toHaveLength(1);
    expect(child.ownRelationships()[0]!.name).toBe("orders");
  });
});

// ---------------------------------------------------------------------------
// MetaObject.validators / ownValidators
// ---------------------------------------------------------------------------

describe("MetaObject.validators / ownValidators", () => {
  it("validators() returns effective validator children", () => {
    const obj = makeObject("User");
    obj.addChild(makeValidator(VALIDATOR_SUBTYPE_REQUIRED));
    obj.freeze();

    expect(obj.validators()).toHaveLength(1);
    expect(obj.validators()[0]!.subType).toBe(VALIDATOR_SUBTYPE_REQUIRED);
  });

  it("ownValidators() excludes inherited validators", () => {
    const base = makeObject("BaseEntity");
    base.addChild(makeValidator(VALIDATOR_SUBTYPE_REQUIRED));
    base.freeze();

    const child = makeObject("Subscriber");
    child.setSuperResolved(base);
    child.freeze();

    // validators() is effective — includes inherited required
    expect(child.validators()).toHaveLength(1);
    // ownValidators() is own-only — child has none
    expect(child.ownValidators()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// MetaObject.layouts / ownLayouts
// ---------------------------------------------------------------------------

describe("MetaObject.layouts / ownLayouts", () => {
  it("layouts() returns effective layout children", () => {
    const obj = makeObject("User");
    obj.addChild(makeLayout("default"));
    obj.freeze();

    expect(obj.layouts()).toHaveLength(1);
    expect(obj.layouts()[0]!.name).toBe("default");
  });

  it("ownLayouts() excludes inherited layouts", () => {
    const base = makeObject("BaseEntity");
    base.addChild(makeLayout("baseGrid"));
    base.freeze();

    const child = makeObject("Subscriber");
    child.addChild(makeLayout("ownGrid"));
    child.setSuperResolved(base);
    child.freeze();

    expect(child.layouts()).toHaveLength(2);
    expect(child.ownLayouts()).toHaveLength(1);
    expect(child.ownLayouts()[0]!.name).toBe("ownGrid");
  });
});
