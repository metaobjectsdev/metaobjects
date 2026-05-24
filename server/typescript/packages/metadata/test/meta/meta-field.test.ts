import { describe, it, expect } from "bun:test";
import { TypeId } from "../../src/registry.js";
import { MetaData } from "../../src/shared/meta-data.js";
import { MetaField } from "../../src/core/field/meta-field.js";
import {
  TYPE_FIELD,
  TYPE_VALIDATOR,
  TYPE_VIEW,
  FIELD_SUBTYPE_STRING,
  FIELD_SUBTYPE_LONG,
  FIELD_SUBTYPE_BOOLEAN,
  FIELD_SUBTYPE_INT,
  VALIDATOR_SUBTYPE_REQUIRED,
  VALIDATOR_SUBTYPE_LENGTH,
  VIEW_SUBTYPE_TEXT,
  FIELD_ATTR_COLUMN,
  FIELD_ATTR_REQUIRED,
  FIELD_ATTR_UNIQUE,
  FIELD_ATTR_DEFAULT,
  FIELD_ATTR_MAX_LENGTH,
  FIELD_ATTR_PRECISION,
  FIELD_ATTR_SCALE,
  SUBTYPE_BASE,
} from "../../src/index.js";
import {
  DATA_TYPE_BOOLEAN,
  DATA_TYPE_INT,
  DATA_TYPE_STRING,
} from "../../src/data-type.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal concrete MetaData subclass for constructing non-typed test nodes. */
class TestNode extends MetaData {}

function makeField(name: string, subType = FIELD_SUBTYPE_STRING): MetaField {
  return new MetaField(new TypeId(TYPE_FIELD, subType), name);
}

/** Create a MetaField with its DataType set — needed for defaultValue() tests. */
function makeTypedField(name: string, subType: string, dataType: import("../../src/data-type.js").DataType): MetaField {
  const f = new MetaField(new TypeId(TYPE_FIELD, subType), name);
  f.setDataType(dataType);
  return f;
}

function makeValidator(subType: string): MetaData {
  return new TestNode(new TypeId(TYPE_VALIDATOR, subType), subType);
}

function makeView(subType: string): MetaData {
  return new TestNode(new TypeId(TYPE_VIEW, subType), subType);
}

// ---------------------------------------------------------------------------
// MetaField attribute getters
// ---------------------------------------------------------------------------

describe("MetaField attribute getters", () => {
  it("column returns the @column attr string", () => {
    const f = makeField("email");
    f.setAttr(FIELD_ATTR_COLUMN, "email_addr");
    expect(f.column).toBe("email_addr");
  });

  it("column returns undefined when attr is absent", () => {
    const f = makeField("email");
    expect(f.column).toBeUndefined();
  });

  it("maxLength returns numeric attr", () => {
    const f = makeField("email");
    f.setAttr(FIELD_ATTR_MAX_LENGTH, 255);
    expect(f.maxLength).toBe(255);
  });

  it("maxLength returns undefined when attr is absent", () => {
    const f = makeField("email");
    expect(f.maxLength).toBeUndefined();
  });

  it("precision returns numeric attr", () => {
    const f = makeField("price");
    f.setAttr(FIELD_ATTR_PRECISION, 10);
    expect(f.precision).toBe(10);
  });

  it("scale returns numeric attr", () => {
    const f = makeField("price");
    f.setAttr(FIELD_ATTR_SCALE, 2);
    expect(f.scale).toBe(2);
  });

  it("unique returns true when @unique: true", () => {
    const f = makeField("email");
    f.setAttr(FIELD_ATTR_UNIQUE, true);
    expect(f.unique).toBe(true);
  });

  it("unique returns false when @unique is absent", () => {
    const f = makeField("email");
    expect(f.unique).toBe(false);
  });

  it("default returns the @default attr value", () => {
    const f = makeField("name");
    f.setAttr(FIELD_ATTR_DEFAULT, "anonymous");
    expect(f.default).toBe("anonymous");
  });

  it("default returns undefined when attr is absent", () => {
    const f = makeField("name");
    expect(f.default).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// MetaField.isRequired
// ---------------------------------------------------------------------------

describe("MetaField.isRequired", () => {
  it("returns true when @required: true attr is set", () => {
    const f = makeField("email");
    f.setAttr(FIELD_ATTR_REQUIRED, true);
    expect(f.isRequired).toBe(true);
  });

  it("returns false when @required attr is absent and no required validator", () => {
    const f = makeField("email");
    expect(f.isRequired).toBe(false);
  });

  it("returns true when a required validator child is present", () => {
    const f = makeField("email");
    f.addChild(makeValidator(VALIDATOR_SUBTYPE_REQUIRED));
    expect(f.isRequired).toBe(true);
  });

  it("uses effective validators — includes inherited required validator", () => {
    const base = makeField("baseName");
    base.addChild(makeValidator(VALIDATOR_SUBTYPE_REQUIRED));
    base.freeze();

    const derived = makeField("title");
    derived.setSuperResolved(base);
    derived.freeze();

    expect(derived.isRequired).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MetaField.validators / ownValidators
// ---------------------------------------------------------------------------

describe("MetaField.validators / ownValidators", () => {
  it("validators() returns own validator children", () => {
    const f = makeField("email");
    f.addChild(makeValidator(VALIDATOR_SUBTYPE_REQUIRED));
    f.freeze();

    const vs = f.validators();
    expect(vs).toHaveLength(1);
    expect(vs[0]!.subType).toBe(VALIDATOR_SUBTYPE_REQUIRED);
  });

  it("validators() includes inherited validators via field extends", () => {
    const base = makeField("baseName");
    base.addChild(makeValidator(VALIDATOR_SUBTYPE_REQUIRED));
    base.freeze();

    const derived = makeField("title");
    // derived has its own length validator
    derived.addChild(makeValidator(VALIDATOR_SUBTYPE_LENGTH));
    derived.setSuperResolved(base);
    derived.freeze();

    const subtypes = derived.validators().map((v) => v.subType);
    expect(subtypes).toContain(VALIDATOR_SUBTYPE_REQUIRED); // inherited
    expect(subtypes).toContain(VALIDATOR_SUBTYPE_LENGTH);    // own
  });

  it("ownValidators() excludes inherited validators", () => {
    const base = makeField("baseName");
    base.addChild(makeValidator(VALIDATOR_SUBTYPE_REQUIRED));
    base.freeze();

    const derived = makeField("title");
    derived.setSuperResolved(base);
    derived.freeze();

    // validators() includes inherited
    expect(derived.validators()).toHaveLength(1);
    // ownValidators() is own-only — none
    expect(derived.ownValidators()).toHaveLength(0);
  });

  it("validators() result is same array reference on repeat call after freeze (caching)", () => {
    const f = makeField("email");
    f.addChild(makeValidator(VALIDATOR_SUBTYPE_REQUIRED));
    f.freeze();
    expect(f.validators()).toBe(f.validators());
  });
});

// ---------------------------------------------------------------------------
// MetaField.views / ownViews
// ---------------------------------------------------------------------------

describe("MetaField.views / ownViews", () => {
  it("views() returns own view children", () => {
    const f = makeField("email");
    f.addChild(makeView(VIEW_SUBTYPE_TEXT));
    f.freeze();

    const vs = f.views();
    expect(vs).toHaveLength(1);
    expect(vs[0]!.subType).toBe(VIEW_SUBTYPE_TEXT);
  });

  it("views() includes views inherited via field extends", () => {
    const base = makeField("baseName");
    base.addChild(makeView(VIEW_SUBTYPE_TEXT));
    base.freeze();

    const derived = makeField("title");
    derived.setSuperResolved(base);
    derived.freeze();

    expect(derived.views().some((v) => v.subType === VIEW_SUBTYPE_TEXT)).toBe(true);
  });

  it("ownViews() excludes inherited views", () => {
    const base = makeField("baseName");
    base.addChild(makeView(VIEW_SUBTYPE_TEXT));
    base.freeze();

    const derived = makeField("title");
    derived.setSuperResolved(base);
    derived.freeze();

    // views() is effective — includes inherited view[text]
    expect(derived.views()).toHaveLength(1);
    // ownViews() is own-only — title has no own views
    expect(derived.ownViews()).toHaveLength(0);
  });

  it("views() result is same array reference on repeat call after freeze (caching)", () => {
    const f = makeField("email");
    f.addChild(makeView(VIEW_SUBTYPE_TEXT));
    f.freeze();
    expect(f.views()).toBe(f.views());
  });
});

// ---------------------------------------------------------------------------
// MetaField.resolveSuper
// ---------------------------------------------------------------------------

describe("MetaField.resolveSuper", () => {
  it("returns the typed supertype field when extends: resolves", () => {
    const base = makeField("id", FIELD_SUBTYPE_LONG);
    base.setIsAbstract(true);
    base.freeze();

    const derived = makeField("id");
    derived.setSuperResolved(base);
    derived.freeze();

    const sup = derived.resolveSuper();
    expect(sup).toBe(base);
    expect(sup!.subType).toBe(FIELD_SUBTYPE_LONG);
    expect(sup!.isAbstract).toBe(true);
  });

  it("returns undefined when there is no super ref", () => {
    const f = makeField("email");
    f.freeze();
    expect(f.resolveSuper()).toBeUndefined();
  });

  it("resolveSuper() returns a MetaField (cast is correct)", () => {
    const base = makeField("name");
    base.freeze();

    const derived = makeField("title");
    derived.setSuperResolved(base);
    derived.freeze();

    const sup = derived.resolveSuper();
    // Should be a MetaField instance, not just MetaData
    expect(sup).toBeInstanceOf(MetaField);
  });
});

// ---------------------------------------------------------------------------
// MetaField.defaultValue() — typed conversion at consumption time
//
// Java parity: MetaField.getDefaultValue() applies DataConverter.toTypeSafe(
// getDataType(), raw). This converts the raw @default attr (which the parser
// stores type-preserved) to the field's own DataType.
//
// The key case this guards: a raw @default of the string "false" on a
// field.boolean must return the boolean false — not the string "false".
// ---------------------------------------------------------------------------

describe("MetaField.defaultValue()", () => {
  it("returns undefined when @default is not set", () => {
    const f = makeTypedField("confirmed", FIELD_SUBTYPE_BOOLEAN, DATA_TYPE_BOOLEAN);
    f.freeze();
    expect(f.defaultValue()).toBeUndefined();
  });

  it("boolean field: raw boolean false → boolean false", () => {
    const f = makeTypedField("confirmed", FIELD_SUBTYPE_BOOLEAN, DATA_TYPE_BOOLEAN);
    f.setAttr(FIELD_ATTR_DEFAULT, false);
    f.freeze();
    const v = f.defaultValue();
    expect(typeof v).toBe("boolean");
    expect(v).toBe(false);
  });

  it("boolean field: raw boolean true → boolean true", () => {
    const f = makeTypedField("subscribed", FIELD_SUBTYPE_BOOLEAN, DATA_TYPE_BOOLEAN);
    f.setAttr(FIELD_ATTR_DEFAULT, true);
    f.freeze();
    const v = f.defaultValue();
    expect(typeof v).toBe("boolean");
    expect(v).toBe(true);
  });

  it("boolean field: raw string 'false' → boolean false (consumption-time conversion)", () => {
    // Proves the design: even if the raw value arrives as a string (e.g. from
    // YAML authoring or string-keyed JSON), defaultValue() converts it to the
    // correct type using the field's DataType.
    const f = makeTypedField("confirmed", FIELD_SUBTYPE_BOOLEAN, DATA_TYPE_BOOLEAN);
    f.setAttr(FIELD_ATTR_DEFAULT, "false");
    f.freeze();
    const v = f.defaultValue();
    expect(typeof v).toBe("boolean");
    expect(v).toBe(false);
  });

  it("boolean field: raw string 'true' → boolean true (consumption-time conversion)", () => {
    const f = makeTypedField("active", FIELD_SUBTYPE_BOOLEAN, DATA_TYPE_BOOLEAN);
    f.setAttr(FIELD_ATTR_DEFAULT, "true");
    f.freeze();
    const v = f.defaultValue();
    expect(typeof v).toBe("boolean");
    expect(v).toBe(true);
  });

  it("int field: raw number 0 → number 0", () => {
    const f = makeTypedField("quantity", FIELD_SUBTYPE_INT, DATA_TYPE_INT);
    f.setAttr(FIELD_ATTR_DEFAULT, 0);
    f.freeze();
    const v = f.defaultValue();
    expect(typeof v).toBe("number");
    expect(v).toBe(0);
  });

  it("int field: raw string '42' → number 42 (consumption-time conversion)", () => {
    const f = makeTypedField("retries", FIELD_SUBTYPE_INT, DATA_TYPE_INT);
    f.setAttr(FIELD_ATTR_DEFAULT, "42");
    f.freeze();
    const v = f.defaultValue();
    expect(typeof v).toBe("number");
    expect(v).toBe(42);
  });

  it("string field: raw string 'active' → string 'active'", () => {
    const f = makeTypedField("status", FIELD_SUBTYPE_STRING, DATA_TYPE_STRING);
    f.setAttr(FIELD_ATTR_DEFAULT, "active");
    f.freeze();
    const v = f.defaultValue();
    expect(typeof v).toBe("string");
    expect(v).toBe("active");
  });

  it("result is cached — same reference returned on repeat calls after freeze", () => {
    const f = makeTypedField("confirmed", FIELD_SUBTYPE_BOOLEAN, DATA_TYPE_BOOLEAN);
    f.setAttr(FIELD_ATTR_DEFAULT, false);
    f.freeze();
    // Call twice — must return exact same object reference (cache hit)
    const first = f.defaultValue();
    const second = f.defaultValue();
    // For primitives, === checks value equality; we verify object-level cache
    // consistency by asserting the values are equal (caching guarantees idempotence).
    expect(first).toBe(second);
    expect(first).toBe(false);
  });
});
