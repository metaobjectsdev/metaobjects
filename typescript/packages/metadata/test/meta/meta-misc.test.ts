// Tests for the remaining concrete node classes (Task 3):
//   MetaIdentity / MetaPrimaryIdentity / MetaSecondaryIdentity
//   MetaRelationship
//   MetaValidator / MetaRequiredValidator / MetaLengthValidator /
//     MetaRegexValidator / MetaNumericValidator / MetaArrayValidator
//   MetaView
//   MetaAttr
//   MetaLayout
//   MetaSource
//   MetaOrigin
//
// All trees are constructed by hand (no Loader) to keep tests fast and
// dependency-free. Pattern mirrors meta-object.test.ts.

import { describe, it, expect } from "bun:test";
import { TypeId } from "../../src/registry.js";
import { MetaData } from "../../src/meta/meta-data.js";
import {
  MetaIdentity,
  MetaPrimaryIdentity,
  MetaSecondaryIdentity,
} from "../../src/meta/meta-identity.js";
import { MetaRelationship } from "../../src/meta/meta-relationship.js";
import {
  MetaValidator,
  MetaRequiredValidator,
  MetaLengthValidator,
  MetaRegexValidator,
  MetaNumericValidator,
  MetaArrayValidator,
} from "../../src/meta/meta-validator.js";
import { MetaView } from "../../src/meta/meta-view.js";
import { MetaAttr } from "../../src/meta/meta-attr.js";
import { MetaLayout } from "../../src/meta/meta-layout.js";
import { MetaSource } from "../../src/meta/meta-source.js";
import { MetaOrigin } from "../../src/meta/meta-origin.js";
import {
  TYPE_IDENTITY,
  TYPE_RELATIONSHIP,
  TYPE_VALIDATOR,
  TYPE_VIEW,
  TYPE_ATTR,
  TYPE_LAYOUT,
  TYPE_SOURCE,
  TYPE_ORIGIN,
  IDENTITY_SUBTYPE_PRIMARY,
  IDENTITY_SUBTYPE_SECONDARY,
  IDENTITY_ATTR_FIELDS,
  IDENTITY_ATTR_GENERATION,
  IDENTITY_ATTR_UNIQUE,
  RELATIONSHIP_SUBTYPE_ASSOCIATION,
  RELATIONSHIP_SUBTYPE_AGGREGATION,
  RELATIONSHIP_ATTR_CARDINALITY,
  RELATIONSHIP_ATTR_OBJECT_REF,
  RELATIONSHIP_ATTR_FK_FIELD,
  RELATIONSHIP_ATTR_JOIN_ENTITY,
  RELATIONSHIP_ATTR_JOIN_FIELDS,
  VALIDATOR_SUBTYPE_REQUIRED,
  VALIDATOR_SUBTYPE_LENGTH,
  VALIDATOR_SUBTYPE_REGEX,
  VALIDATOR_SUBTYPE_NUMERIC,
  VALIDATOR_SUBTYPE_ARRAY,
  VALIDATOR_ATTR_PATTERN,
  VALIDATOR_ATTR_MIN,
  VALIDATOR_ATTR_MAX,
  VIEW_SUBTYPE_TEXT,
  VIEW_SUBTYPE_CURRENCY,
  ATTR_SUBTYPE_STRING,
  LAYOUT_SUBTYPE_DATA_GRID,
  LAYOUT_DATA_GRID_ATTR_PAGE_SIZE,
  LAYOUT_DATA_GRID_ATTR_COLUMNS,
  SOURCE_SUBTYPE_DB_TABLE,
  SOURCE_SUBTYPE_DB_VIEW,
  SOURCE_DB_TABLE_ATTR_NAME,
  ORIGIN_SUBTYPE_PASSTHROUGH,
  ORIGIN_SUBTYPE_AGGREGATE,
  ORIGIN_PASSTHROUGH_ATTR_FROM,
  ORIGIN_AGGREGATE_ATTR_AGG,
  ORIGIN_AGGREGATE_ATTR_OF,
  ORIGIN_AGGREGATE_ATTR_VIA,
  SUBTYPE_BASE,
  RESERVED_KEY_VALUE,
} from "../../src/constants.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIdentity(
  name: string,
  subType: string,
  fields: string[],
): MetaIdentity {
  const node = new MetaIdentity(new TypeId(TYPE_IDENTITY, subType), name);
  node.setAttr(IDENTITY_ATTR_FIELDS, fields);
  return node;
}

function makePrimaryIdentity(
  name: string,
  fields: string[],
  generation?: string,
): MetaPrimaryIdentity {
  const node = new MetaPrimaryIdentity(
    new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY),
    name,
  );
  node.setAttr(IDENTITY_ATTR_FIELDS, fields);
  if (generation !== undefined) node.setAttr(IDENTITY_ATTR_GENERATION, generation);
  return node;
}

function makeSecondaryIdentity(
  name: string,
  fields: string[],
  unique?: boolean,
): MetaSecondaryIdentity {
  const node = new MetaSecondaryIdentity(
    new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_SECONDARY),
    name,
  );
  node.setAttr(IDENTITY_ATTR_FIELDS, fields);
  if (unique !== undefined) node.setAttr(IDENTITY_ATTR_UNIQUE, unique);
  return node;
}

function makeRelationship(
  name: string,
  subType = RELATIONSHIP_SUBTYPE_ASSOCIATION,
): MetaRelationship {
  return new MetaRelationship(new TypeId(TYPE_RELATIONSHIP, subType), name);
}

function makeValidator(subType: string): MetaValidator {
  return new MetaValidator(new TypeId(TYPE_VALIDATOR, subType), subType);
}

function makeRequiredValidator(): MetaRequiredValidator {
  return new MetaRequiredValidator(
    new TypeId(TYPE_VALIDATOR, VALIDATOR_SUBTYPE_REQUIRED),
    VALIDATOR_SUBTYPE_REQUIRED,
  );
}

function makeLengthValidator(min?: number, max?: number): MetaLengthValidator {
  const node = new MetaLengthValidator(
    new TypeId(TYPE_VALIDATOR, VALIDATOR_SUBTYPE_LENGTH),
    VALIDATOR_SUBTYPE_LENGTH,
  );
  if (min !== undefined) node.setAttr(VALIDATOR_ATTR_MIN, min);
  if (max !== undefined) node.setAttr(VALIDATOR_ATTR_MAX, max);
  return node;
}

function makeRegexValidator(pattern: string): MetaRegexValidator {
  const node = new MetaRegexValidator(
    new TypeId(TYPE_VALIDATOR, VALIDATOR_SUBTYPE_REGEX),
    VALIDATOR_SUBTYPE_REGEX,
  );
  node.setAttr(VALIDATOR_ATTR_PATTERN, pattern);
  return node;
}

function makeNumericValidator(min?: number, max?: number): MetaNumericValidator {
  const node = new MetaNumericValidator(
    new TypeId(TYPE_VALIDATOR, VALIDATOR_SUBTYPE_NUMERIC),
    VALIDATOR_SUBTYPE_NUMERIC,
  );
  if (min !== undefined) node.setAttr(VALIDATOR_ATTR_MIN, min);
  if (max !== undefined) node.setAttr(VALIDATOR_ATTR_MAX, max);
  return node;
}

function makeArrayValidator(min?: number, max?: number): MetaArrayValidator {
  const node = new MetaArrayValidator(
    new TypeId(TYPE_VALIDATOR, VALIDATOR_SUBTYPE_ARRAY),
    VALIDATOR_SUBTYPE_ARRAY,
  );
  if (min !== undefined) node.setAttr(VALIDATOR_ATTR_MIN, min);
  if (max !== undefined) node.setAttr(VALIDATOR_ATTR_MAX, max);
  return node;
}

function makeView(subType: string): MetaView {
  return new MetaView(new TypeId(TYPE_VIEW, subType), subType);
}

function makeAttr(name: string, value: unknown): MetaAttr {
  const node = new MetaAttr(new TypeId(TYPE_ATTR, ATTR_SUBTYPE_STRING), name);
  node.setAttr(RESERVED_KEY_VALUE, value as string);
  return node;
}

function makeLayout(subType: string, name: string): MetaLayout {
  return new MetaLayout(new TypeId(TYPE_LAYOUT, subType), name);
}

function makeSource(subType: string, sourceName?: string): MetaSource {
  const node = new MetaSource(new TypeId(TYPE_SOURCE, subType), subType);
  if (sourceName !== undefined) node.setAttr(SOURCE_DB_TABLE_ATTR_NAME, sourceName);
  return node;
}

function makeOrigin(subType: string): MetaOrigin {
  return new MetaOrigin(new TypeId(TYPE_ORIGIN, subType), subType);
}

// ---------------------------------------------------------------------------
// MetaIdentity
// ---------------------------------------------------------------------------

describe("MetaIdentity — base class", () => {
  it("extends MetaData", () => {
    const id = makeIdentity("pk", IDENTITY_SUBTYPE_PRIMARY, ["id"]);
    expect(id).toBeInstanceOf(MetaData);
  });

  it("fields getter returns the @fields array", () => {
    const id = makeIdentity("pk", IDENTITY_SUBTYPE_PRIMARY, ["id", "tenantId"]);
    expect(id.fields).toEqual(["id", "tenantId"]);
  });

  it("fields defaults to empty array when attr absent", () => {
    const id = new MetaIdentity(
      new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY),
      "pk",
    );
    expect(id.fields).toEqual([]);
  });

  it("unique defaults to true when attr absent", () => {
    const id = makeIdentity("pk", IDENTITY_SUBTYPE_PRIMARY, ["id"]);
    expect(id.unique).toBe(true);
  });

  it("unique returns false when @unique: false is set", () => {
    const id = makeSecondaryIdentity("idx_tag", ["tag"], false);
    expect(id.unique).toBe(false);
  });

  it("isPrimary / isSecondary subtype checks", () => {
    const pk = makeIdentity("pk", IDENTITY_SUBTYPE_PRIMARY, ["id"]);
    expect(pk.isPrimary()).toBe(true);
    expect(pk.isSecondary()).toBe(false);

    const sec = makeIdentity("idx", IDENTITY_SUBTYPE_SECONDARY, ["email"]);
    expect(sec.isPrimary()).toBe(false);
    expect(sec.isSecondary()).toBe(true);
  });

  it("isComposite returns false for single-field identity", () => {
    const id = makeIdentity("pk", IDENTITY_SUBTYPE_PRIMARY, ["id"]);
    expect(id.isComposite()).toBe(false);
  });

  it("isComposite returns true for multi-field identity", () => {
    const id = makeIdentity("pk", IDENTITY_SUBTYPE_PRIMARY, ["id", "tenantId"]);
    expect(id.isComposite()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MetaPrimaryIdentity
// ---------------------------------------------------------------------------

describe("MetaPrimaryIdentity", () => {
  it("extends MetaIdentity and MetaData", () => {
    const pk = makePrimaryIdentity("pk", ["id"]);
    expect(pk).toBeInstanceOf(MetaIdentity);
    expect(pk).toBeInstanceOf(MetaData);
  });

  it("generation returns the @generation attr", () => {
    const pk = makePrimaryIdentity("pk", ["id"], "increment");
    expect(pk.generation).toBe("increment");
  });

  it("generation returns uuid", () => {
    const pk = makePrimaryIdentity("pk", ["id"], "uuid");
    expect(pk.generation).toBe("uuid");
  });

  it("generation returns undefined when attr absent", () => {
    const pk = makePrimaryIdentity("pk", ["id"]);
    expect(pk.generation).toBeUndefined();
  });

  it("isPrimary returns true", () => {
    const pk = makePrimaryIdentity("pk", ["id"], "increment");
    expect(pk.isPrimary()).toBe(true);
  });

  it("isSecondary returns false", () => {
    const pk = makePrimaryIdentity("pk", ["id"], "increment");
    expect(pk.isSecondary()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MetaSecondaryIdentity
// ---------------------------------------------------------------------------

describe("MetaSecondaryIdentity", () => {
  it("extends MetaIdentity and MetaData", () => {
    const sec = makeSecondaryIdentity("idx_email", ["email"]);
    expect(sec).toBeInstanceOf(MetaIdentity);
    expect(sec).toBeInstanceOf(MetaData);
  });

  it("isSecondary returns true", () => {
    const sec = makeSecondaryIdentity("idx_email", ["email"]);
    expect(sec.isSecondary()).toBe(true);
  });

  it("isPrimary returns false", () => {
    const sec = makeSecondaryIdentity("idx_email", ["email"]);
    expect(sec.isPrimary()).toBe(false);
  });

  it("unique defaults to true when @unique attr absent", () => {
    const sec = makeSecondaryIdentity("idx_email", ["email"]);
    expect(sec.unique).toBe(true);
  });

  it("unique is false when @unique: false is explicit", () => {
    const sec = makeSecondaryIdentity("idx_tag", ["tag"], false);
    expect(sec.unique).toBe(false);
  });

  it("has no .generation accessor (MetaSecondaryIdentity narrows away from primary)", () => {
    const sec = makeSecondaryIdentity("idx_email", ["email"]);
    // TypeScript compile-time: sec.generation would be a type error.
    // Runtime: accessing via cast returns undefined (no attr set).
    expect((sec as unknown as { generation?: unknown }).generation).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// MetaRelationship
// ---------------------------------------------------------------------------

describe("MetaRelationship", () => {
  it("extends MetaData", () => {
    const rel = makeRelationship("posts");
    expect(rel).toBeInstanceOf(MetaData);
  });

  it("cardinality returns @cardinality attr", () => {
    const rel = makeRelationship("posts");
    rel.setAttr(RELATIONSHIP_ATTR_CARDINALITY, "many");
    expect(rel.cardinality).toBe("many");
  });

  it("cardinality returns undefined when absent", () => {
    const rel = makeRelationship("posts");
    expect(rel.cardinality).toBeUndefined();
  });

  it("objectRef returns @objectRef attr", () => {
    const rel = makeRelationship("posts");
    rel.setAttr(RELATIONSHIP_ATTR_OBJECT_REF, "demo::Post");
    expect(rel.objectRef).toBe("demo::Post");
  });

  it("objectRef returns undefined when absent", () => {
    const rel = makeRelationship("posts");
    expect(rel.objectRef).toBeUndefined();
  });

  it("fkField returns @fkField attr", () => {
    const rel = makeRelationship("posts");
    rel.setAttr(RELATIONSHIP_ATTR_FK_FIELD, "userId");
    expect(rel.fkField).toBe("userId");
  });

  it("fkField returns undefined when absent", () => {
    const rel = makeRelationship("posts");
    expect(rel.fkField).toBeUndefined();
  });

  it("joinEntity returns @joinEntity attr", () => {
    const rel = makeRelationship("tags", RELATIONSHIP_SUBTYPE_AGGREGATION);
    rel.setAttr(RELATIONSHIP_ATTR_JOIN_ENTITY, "PostTag");
    expect(rel.joinEntity).toBe("PostTag");
  });

  it("joinEntity returns undefined when absent", () => {
    const rel = makeRelationship("posts");
    expect(rel.joinEntity).toBeUndefined();
  });

  it("joinFields returns @joinFields array attr", () => {
    const rel = makeRelationship("tags", RELATIONSHIP_SUBTYPE_AGGREGATION);
    rel.setAttr(RELATIONSHIP_ATTR_JOIN_FIELDS, ["postId", "tagId"]);
    expect(rel.joinFields).toEqual(["postId", "tagId"]);
  });

  it("joinFields defaults to empty array when absent", () => {
    const rel = makeRelationship("posts");
    expect(rel.joinFields).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// MetaValidator — base class
// ---------------------------------------------------------------------------

describe("MetaValidator — base class", () => {
  it("extends MetaData", () => {
    const v = makeValidator(VALIDATOR_SUBTYPE_REQUIRED);
    expect(v).toBeInstanceOf(MetaData);
  });

  it("isRequired / isLength / isRegex subtype checks", () => {
    const req = makeValidator(VALIDATOR_SUBTYPE_REQUIRED);
    expect(req.isRequired()).toBe(true);
    expect(req.isLength()).toBe(false);
    expect(req.isRegex()).toBe(false);

    const len = makeValidator(VALIDATOR_SUBTYPE_LENGTH);
    expect(len.isRequired()).toBe(false);
    expect(len.isLength()).toBe(true);
    expect(len.isRegex()).toBe(false);

    const regex = makeValidator(VALIDATOR_SUBTYPE_REGEX);
    expect(regex.isRequired()).toBe(false);
    expect(regex.isLength()).toBe(false);
    expect(regex.isRegex()).toBe(true);
  });

  it("min / max return numeric attr when present", () => {
    const v = makeLengthValidator(1, 100);
    expect(v.min).toBe(1);
    expect(v.max).toBe(100);
  });

  it("min / max return undefined when absent", () => {
    const v = makeRequiredValidator();
    expect(v.min).toBeUndefined();
    expect(v.max).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// MetaRequiredValidator
// ---------------------------------------------------------------------------

describe("MetaRequiredValidator", () => {
  it("extends MetaValidator and MetaData", () => {
    const v = makeRequiredValidator();
    expect(v).toBeInstanceOf(MetaValidator);
    expect(v).toBeInstanceOf(MetaData);
  });

  it("isRequired returns true", () => {
    expect(makeRequiredValidator().isRequired()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MetaLengthValidator
// ---------------------------------------------------------------------------

describe("MetaLengthValidator", () => {
  it("extends MetaValidator", () => {
    expect(makeLengthValidator()).toBeInstanceOf(MetaValidator);
  });

  it("isLength returns true", () => {
    expect(makeLengthValidator().isLength()).toBe(true);
  });

  it("min / max hold string-length bounds", () => {
    const v = makeLengthValidator(2, 50);
    expect(v.min).toBe(2);
    expect(v.max).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// MetaRegexValidator
// ---------------------------------------------------------------------------

describe("MetaRegexValidator", () => {
  it("extends MetaValidator", () => {
    expect(makeRegexValidator("^[a-z]+$")).toBeInstanceOf(MetaValidator);
  });

  it("isRegex returns true", () => {
    expect(makeRegexValidator("^[a-z]+$").isRegex()).toBe(true);
  });

  it("pattern returns the @pattern attr", () => {
    const v = makeRegexValidator("^[a-z-]+$");
    expect(v.pattern).toBe("^[a-z-]+$");
  });

  it("pattern returns undefined when absent", () => {
    const v = new MetaRegexValidator(
      new TypeId(TYPE_VALIDATOR, VALIDATOR_SUBTYPE_REGEX),
      VALIDATOR_SUBTYPE_REGEX,
    );
    expect(v.pattern).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// MetaNumericValidator
// ---------------------------------------------------------------------------

describe("MetaNumericValidator", () => {
  it("extends MetaValidator", () => {
    expect(makeNumericValidator()).toBeInstanceOf(MetaValidator);
  });

  it("min / max hold value bounds", () => {
    const v = makeNumericValidator(0, 150);
    expect(v.min).toBe(0);
    expect(v.max).toBe(150);
  });
});

// ---------------------------------------------------------------------------
// MetaArrayValidator
// ---------------------------------------------------------------------------

describe("MetaArrayValidator", () => {
  it("extends MetaValidator", () => {
    expect(makeArrayValidator()).toBeInstanceOf(MetaValidator);
  });

  it("min / max hold element-count bounds", () => {
    const v = makeArrayValidator(1, 10);
    expect(v.min).toBe(1);
    expect(v.max).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// MetaView
// ---------------------------------------------------------------------------

describe("MetaView", () => {
  it("extends MetaData", () => {
    const v = makeView(VIEW_SUBTYPE_TEXT);
    expect(v).toBeInstanceOf(MetaData);
  });

  it("has correct type / subType", () => {
    const v = makeView(VIEW_SUBTYPE_CURRENCY);
    expect(v.type).toBe(TYPE_VIEW);
    expect(v.subType).toBe(VIEW_SUBTYPE_CURRENCY);
  });

  it("attr() escape hatch works", () => {
    const v = makeView(VIEW_SUBTYPE_TEXT);
    v.setAttr("placeholder", "Enter value");
    expect(v.attr("placeholder")).toBe("Enter value");
  });
});

// ---------------------------------------------------------------------------
// MetaAttr
// ---------------------------------------------------------------------------

describe("MetaAttr", () => {
  it("extends MetaData", () => {
    const a = makeAttr("color", "red");
    expect(a).toBeInstanceOf(MetaData);
  });

  it("value returns the @value attr", () => {
    const a = makeAttr("theme", "dark");
    expect(a.value).toBe("dark");
  });

  it("value returns undefined when not set", () => {
    const a = new MetaAttr(new TypeId(TYPE_ATTR, ATTR_SUBTYPE_STRING), "empty");
    expect(a.value).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// MetaLayout
// ---------------------------------------------------------------------------

describe("MetaLayout", () => {
  it("extends MetaData", () => {
    const l = makeLayout(LAYOUT_SUBTYPE_DATA_GRID, "default");
    expect(l).toBeInstanceOf(MetaData);
  });

  it("has correct type / subType", () => {
    const l = makeLayout(LAYOUT_SUBTYPE_DATA_GRID, "default");
    expect(l.type).toBe(TYPE_LAYOUT);
    expect(l.subType).toBe(LAYOUT_SUBTYPE_DATA_GRID);
  });

  it("attr() escape hatch returns layout attrs", () => {
    const l = makeLayout(LAYOUT_SUBTYPE_DATA_GRID, "default");
    l.setAttr(LAYOUT_DATA_GRID_ATTR_PAGE_SIZE, 25);
    l.setAttr(LAYOUT_DATA_GRID_ATTR_COLUMNS, ["id", "name"]);
    expect(l.attr(LAYOUT_DATA_GRID_ATTR_PAGE_SIZE)).toBe(25);
    expect(l.attr(LAYOUT_DATA_GRID_ATTR_COLUMNS)).toEqual(["id", "name"]);
  });
});

// ---------------------------------------------------------------------------
// MetaSource
// ---------------------------------------------------------------------------

describe("MetaSource", () => {
  it("extends MetaData", () => {
    const s = makeSource(SOURCE_SUBTYPE_DB_TABLE, "users");
    expect(s).toBeInstanceOf(MetaData);
  });

  it("has correct type / subType for dbTable", () => {
    const s = makeSource(SOURCE_SUBTYPE_DB_TABLE, "users");
    expect(s.type).toBe(TYPE_SOURCE);
    expect(s.subType).toBe(SOURCE_SUBTYPE_DB_TABLE);
  });

  it("has correct type / subType for dbView", () => {
    const s = makeSource(SOURCE_SUBTYPE_DB_VIEW, "v_summary");
    expect(s.type).toBe(TYPE_SOURCE);
    expect(s.subType).toBe(SOURCE_SUBTYPE_DB_VIEW);
  });

  it("sourceName returns @name attr", () => {
    const s = makeSource(SOURCE_SUBTYPE_DB_TABLE, "products");
    expect(s.sourceName).toBe("products");
  });

  it("sourceName returns undefined when @name not set", () => {
    const s = makeSource(SOURCE_SUBTYPE_DB_TABLE);
    expect(s.sourceName).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// MetaOrigin
// ---------------------------------------------------------------------------

describe("MetaOrigin", () => {
  it("extends MetaData", () => {
    const o = makeOrigin(ORIGIN_SUBTYPE_PASSTHROUGH);
    expect(o).toBeInstanceOf(MetaData);
  });

  it("has correct type / subType for passthrough", () => {
    const o = makeOrigin(ORIGIN_SUBTYPE_PASSTHROUGH);
    expect(o.type).toBe(TYPE_ORIGIN);
    expect(o.subType).toBe(ORIGIN_SUBTYPE_PASSTHROUGH);
  });

  it("has correct type / subType for aggregate", () => {
    const o = makeOrigin(ORIGIN_SUBTYPE_AGGREGATE);
    expect(o.type).toBe(TYPE_ORIGIN);
    expect(o.subType).toBe(ORIGIN_SUBTYPE_AGGREGATE);
  });

  it("attr() escape hatch returns passthrough attrs", () => {
    const o = makeOrigin(ORIGIN_SUBTYPE_PASSTHROUGH);
    o.setAttr(ORIGIN_PASSTHROUGH_ATTR_FROM, "Base.label");
    expect(o.attr(ORIGIN_PASSTHROUGH_ATTR_FROM)).toBe("Base.label");
  });

  it("attr() escape hatch returns aggregate attrs", () => {
    const o = makeOrigin(ORIGIN_SUBTYPE_AGGREGATE);
    o.setAttr(ORIGIN_AGGREGATE_ATTR_AGG, "count");
    o.setAttr(ORIGIN_AGGREGATE_ATTR_OF, "Week.id");
    o.setAttr(ORIGIN_AGGREGATE_ATTR_VIA, "Program.weeks");
    expect(o.attr(ORIGIN_AGGREGATE_ATTR_AGG)).toBe("count");
    expect(o.attr(ORIGIN_AGGREGATE_ATTR_OF)).toBe("Week.id");
    expect(o.attr(ORIGIN_AGGREGATE_ATTR_VIA)).toBe("Program.weeks");
  });
});

// ---------------------------------------------------------------------------
// Subtype discrimination — instanceof narrowing
// ---------------------------------------------------------------------------

describe("instanceof narrowing across hierarchy", () => {
  it("MetaPrimaryIdentity is instanceof MetaIdentity and MetaData", () => {
    const pk = makePrimaryIdentity("pk", ["id"], "increment");
    expect(pk).toBeInstanceOf(MetaPrimaryIdentity);
    expect(pk).toBeInstanceOf(MetaIdentity);
    expect(pk).toBeInstanceOf(MetaData);
  });

  it("MetaSecondaryIdentity is instanceof MetaIdentity and MetaData", () => {
    const sec = makeSecondaryIdentity("idx_email", ["email"]);
    expect(sec).toBeInstanceOf(MetaSecondaryIdentity);
    expect(sec).toBeInstanceOf(MetaIdentity);
    expect(sec).toBeInstanceOf(MetaData);
  });

  it("MetaPrimaryIdentity is NOT instanceof MetaSecondaryIdentity", () => {
    const pk = makePrimaryIdentity("pk", ["id"]);
    expect(pk).not.toBeInstanceOf(MetaSecondaryIdentity);
  });

  it("MetaRequiredValidator is instanceof MetaValidator and MetaData", () => {
    const v = makeRequiredValidator();
    expect(v).toBeInstanceOf(MetaRequiredValidator);
    expect(v).toBeInstanceOf(MetaValidator);
    expect(v).toBeInstanceOf(MetaData);
  });

  it("MetaLengthValidator is instanceof MetaValidator", () => {
    expect(makeLengthValidator()).toBeInstanceOf(MetaValidator);
  });

  it("MetaRegexValidator is instanceof MetaValidator", () => {
    expect(makeRegexValidator(".*")).toBeInstanceOf(MetaValidator);
  });

  it("MetaNumericValidator is instanceof MetaValidator", () => {
    expect(makeNumericValidator()).toBeInstanceOf(MetaValidator);
  });

  it("MetaArrayValidator is instanceof MetaValidator", () => {
    expect(makeArrayValidator()).toBeInstanceOf(MetaValidator);
  });

  it("MetaRequiredValidator is NOT instanceof MetaLengthValidator", () => {
    expect(makeRequiredValidator()).not.toBeInstanceOf(MetaLengthValidator);
  });
});

// ---------------------------------------------------------------------------
// Caching — key accessor cached after freeze
// ---------------------------------------------------------------------------

describe("caching — MetaIdentity.fields", () => {
  it("fields getter returns same reference after freeze (caching active)", () => {
    // MetaIdentity.fields is a getter (not cached via cached()), but should
    // be stable reference — actually it's a new array each call since we return
    // Array.isArray(f) ? (f as string[]) : []. Arrays are stored by reference
    // in attrs, so the same array ref is returned. Verify stability.
    const id = makePrimaryIdentity("pk", ["id"]);
    id.freeze();
    const a = id.fields;
    const b = id.fields;
    // attrs map stores the array by reference; both calls see the same stored ref
    expect(a).toBe(b);
  });
});
