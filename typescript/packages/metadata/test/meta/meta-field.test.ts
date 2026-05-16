import { describe, it, expect } from "bun:test";
import { TypeId } from "../../src/registry.js";
import { MetaData } from "../../src/meta/meta-data.js";
import { MetaField } from "../../src/meta/meta-field.js";
import {
  TYPE_FIELD,
  TYPE_VALIDATOR,
  TYPE_VIEW,
  FIELD_SUBTYPE_STRING,
  FIELD_SUBTYPE_LONG,
  VALIDATOR_SUBTYPE_REQUIRED,
  VALIDATOR_SUBTYPE_LENGTH,
  VIEW_SUBTYPE_TEXT,
  FIELD_ATTR_DB_COLUMN,
  FIELD_ATTR_REQUIRED,
  FIELD_ATTR_UNIQUE,
  FIELD_ATTR_DEFAULT,
  FIELD_ATTR_MAX_LENGTH,
  FIELD_ATTR_PRECISION,
  FIELD_ATTR_SCALE,
  SUBTYPE_BASE,
} from "../../src/constants.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal concrete MetaData subclass for constructing non-typed test nodes. */
class TestNode extends MetaData {}

function makeField(name: string, subType = FIELD_SUBTYPE_STRING): MetaField {
  return new MetaField(new TypeId(TYPE_FIELD, subType), name);
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
  it("dbColumn returns the @dbColumn attr string", () => {
    const f = makeField("email");
    f.setAttr(FIELD_ATTR_DB_COLUMN, "email_addr");
    expect(f.dbColumn).toBe("email_addr");
  });

  it("dbColumn returns undefined when attr is absent", () => {
    const f = makeField("email");
    expect(f.dbColumn).toBeUndefined();
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
