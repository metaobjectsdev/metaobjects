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
// All trees are constructed by hand (no MetaDataLoader) to keep tests fast and
// dependency-free. Pattern mirrors meta-object.test.ts.

import { describe, it, expect } from "bun:test";
import { TypeId } from "../../src/registry.js";
import { MetaDataLoader } from "../../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../../src/loader/meta-data-source.js";
import { MetaData } from "../../src/shared/meta-data.js";
import { MetaRoot } from "../../src/shared/meta-root.js";
import { MetaObject } from "../../src/core/object/meta-object.js";
import { MetaField } from "../../src/core/field/meta-field.js";
import {
  MetaIdentity,
  MetaPrimaryIdentity,
  MetaSecondaryIdentity,
} from "../../src/core/identity/meta-identity.js";
import { MetaRelationship } from "../../src/core/relationship/meta-relationship.js";
import {
  MetaValidator,
  MetaRequiredValidator,
  MetaLengthValidator,
  MetaRegexValidator,
  MetaNumericValidator,
  MetaArrayValidator,
} from "../../src/core/validator/meta-validator.js";
import { MetaView } from "../../src/presentation/view/meta-view.js";
import { MetaAttr } from "../../src/core/attr/meta-attr.js";
import { MetaLayout } from "../../src/presentation/layout/meta-layout.js";
import { MetaSource } from "../../src/persistence/source/meta-source.js";
import {
  MetaOrigin,
  MetaPassthroughOrigin,
  MetaAggregateOrigin,
} from "../../src/persistence/origin/meta-origin.js";
import {
  TYPE_OBJECT,
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
  RELATIONSHIP_ATTR_THROUGH,
  RELATIONSHIP_ATTR_SOURCE_REF_FIELD,
  RELATIONSHIP_ATTR_SYMMETRIC,
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
  LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD,
  LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_ORDER,
  LAYOUT_DATA_GRID_ATTR_FILTERABLE,
  LAYOUT_DATA_GRID_ATTR_FILTER,
  LAYOUT_DATA_GRID_ATTR_COLUMNS,
  SOURCE_SUBTYPE_RDB,
  SOURCE_ATTR_KIND,
  SOURCE_KIND_TABLE,
  SOURCE_KIND_VIEW,
  ORIGIN_SUBTYPE_PASSTHROUGH,
  ORIGIN_SUBTYPE_AGGREGATE,
  ORIGIN_PASSTHROUGH_ATTR_FROM,
  ORIGIN_PASSTHROUGH_ATTR_VIA,
  ORIGIN_AGGREGATE_ATTR_AGG,
  ORIGIN_AGGREGATE_ATTR_OF,
  ORIGIN_AGGREGATE_ATTR_VIA,
  SUBTYPE_BASE,
  RESERVED_KEY_VALUE,
} from "../../src/index.js";

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

function makeSource(subType: string): MetaSource {
  return new MetaSource(new TypeId(TYPE_SOURCE, subType), subType);
}

/** A source.rdb node with an optional @kind (omitted ⇒ default kind = table). */
function makeRdbSource(kind?: string): MetaSource {
  const node = new MetaSource(new TypeId(TYPE_SOURCE, SOURCE_SUBTYPE_RDB), SOURCE_SUBTYPE_RDB);
  if (kind !== undefined) node.setAttr(SOURCE_ATTR_KIND, kind);
  return node;
}

function makeOrigin(subType: string): MetaOrigin {
  return new MetaOrigin(new TypeId(TYPE_ORIGIN, subType), subType);
}

function makePassthroughOrigin(from?: string, via?: string): MetaPassthroughOrigin {
  const node = new MetaPassthroughOrigin(
    new TypeId(TYPE_ORIGIN, ORIGIN_SUBTYPE_PASSTHROUGH),
    ORIGIN_SUBTYPE_PASSTHROUGH,
  );
  if (from !== undefined) node.setAttr(ORIGIN_PASSTHROUGH_ATTR_FROM, from);
  if (via !== undefined) node.setAttr(ORIGIN_PASSTHROUGH_ATTR_VIA, via);
  return node;
}

function makeAggregateOrigin(
  agg?: string,
  of_?: string,
  via?: string,
): MetaAggregateOrigin {
  const node = new MetaAggregateOrigin(
    new TypeId(TYPE_ORIGIN, ORIGIN_SUBTYPE_AGGREGATE),
    ORIGIN_SUBTYPE_AGGREGATE,
  );
  if (agg !== undefined) node.setAttr(ORIGIN_AGGREGATE_ATTR_AGG, agg);
  if (of_ !== undefined) node.setAttr(ORIGIN_AGGREGATE_ATTR_OF, of_);
  if (via !== undefined) node.setAttr(ORIGIN_AGGREGATE_ATTR_VIA, via);
  return node;
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

  it("through returns @through attr (FR-017)", () => {
    const rel = makeRelationship("tags", RELATIONSHIP_SUBTYPE_AGGREGATION);
    rel.setAttr(RELATIONSHIP_ATTR_THROUGH, "PostTag");
    expect(rel.through).toBe("PostTag");
  });

  it("through returns undefined when absent", () => {
    const rel = makeRelationship("posts");
    expect(rel.through).toBeUndefined();
  });

  it("sourceRefField returns @sourceRefField attr (FR-017)", () => {
    const rel = makeRelationship("follows", RELATIONSHIP_SUBTYPE_ASSOCIATION);
    rel.setAttr(RELATIONSHIP_ATTR_SOURCE_REF_FIELD, "followerId");
    expect(rel.sourceRefField).toBe("followerId");
  });

  it("sourceRefField returns undefined when absent", () => {
    const rel = makeRelationship("posts");
    expect(rel.sourceRefField).toBeUndefined();
  });

  it("symmetric returns true only when @symmetric is true (FR-017)", () => {
    const rel = makeRelationship("friends", RELATIONSHIP_SUBTYPE_ASSOCIATION);
    rel.setAttr(RELATIONSHIP_ATTR_SYMMETRIC, true);
    expect(rel.symmetric).toBe(true);
  });

  it("symmetric defaults to false when absent", () => {
    const rel = makeRelationship("posts");
    expect(rel.symmetric).toBe(false);
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

  it("ownAttr() returns view attrs", () => {
    const v = makeView(VIEW_SUBTYPE_TEXT);
    v.setAttr("placeholder", "Enter value");
    expect(v.ownAttr("placeholder")).toBe("Enter value");
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

  it("ownAttr() returns layout attrs", () => {
    const l = makeLayout(LAYOUT_SUBTYPE_DATA_GRID, "default");
    l.setAttr(LAYOUT_DATA_GRID_ATTR_PAGE_SIZE, 25);
    l.setAttr(LAYOUT_DATA_GRID_ATTR_COLUMNS, ["id", "name"]);
    expect(l.ownAttr(LAYOUT_DATA_GRID_ATTR_PAGE_SIZE)).toBe(25);
    expect(l.ownAttr(LAYOUT_DATA_GRID_ATTR_COLUMNS)).toEqual(["id", "name"]);
  });
});

// ---------------------------------------------------------------------------
// MetaLayout — typed dataGrid accessors (Phase B2)
// ---------------------------------------------------------------------------

describe("MetaLayout — typed dataGrid accessors", () => {
  it("pageSize returns the @pageSize attr as a number", () => {
    const l = makeLayout(LAYOUT_SUBTYPE_DATA_GRID, "default");
    l.setAttr(LAYOUT_DATA_GRID_ATTR_PAGE_SIZE, 50);
    expect(l.pageSize).toBe(50);
  });

  it("pageSize returns undefined when attr is absent", () => {
    const l = makeLayout(LAYOUT_SUBTYPE_DATA_GRID, "default");
    expect(l.pageSize).toBeUndefined();
  });

  it("defaultSortField returns the @defaultSortField attr", () => {
    const l = makeLayout(LAYOUT_SUBTYPE_DATA_GRID, "default");
    l.setAttr(LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD, "createdAt");
    expect(l.defaultSortField).toBe("createdAt");
  });

  it("defaultSortField returns undefined when attr is absent", () => {
    const l = makeLayout(LAYOUT_SUBTYPE_DATA_GRID, "default");
    expect(l.defaultSortField).toBeUndefined();
  });

  it("defaultSortOrder returns 'asc' when set", () => {
    const l = makeLayout(LAYOUT_SUBTYPE_DATA_GRID, "default");
    l.setAttr(LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_ORDER, "asc");
    expect(l.defaultSortOrder).toBe("asc");
  });

  it("defaultSortOrder returns 'desc' when set", () => {
    const l = makeLayout(LAYOUT_SUBTYPE_DATA_GRID, "default");
    l.setAttr(LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_ORDER, "desc");
    expect(l.defaultSortOrder).toBe("desc");
  });

  it("defaultSortOrder returns undefined when attr is absent", () => {
    const l = makeLayout(LAYOUT_SUBTYPE_DATA_GRID, "default");
    expect(l.defaultSortOrder).toBeUndefined();
  });

  it("filterable returns true when @filterable: true is set", () => {
    const l = makeLayout(LAYOUT_SUBTYPE_DATA_GRID, "default");
    l.setAttr(LAYOUT_DATA_GRID_ATTR_FILTERABLE, true);
    expect(l.filterable).toBe(true);
  });

  it("filterable returns false when attr is absent (default false)", () => {
    const l = makeLayout(LAYOUT_SUBTYPE_DATA_GRID, "default");
    expect(l.filterable).toBe(false);
  });

  it("filterable returns false when @filterable: false is explicit", () => {
    const l = makeLayout(LAYOUT_SUBTYPE_DATA_GRID, "default");
    l.setAttr(LAYOUT_DATA_GRID_ATTR_FILTERABLE, false);
    expect(l.filterable).toBe(false);
  });

  it("filter returns the @filter preset-filter object", () => {
    const l = makeLayout(LAYOUT_SUBTYPE_DATA_GRID, "default");
    l.setAttr(LAYOUT_DATA_GRID_ATTR_FILTER, { subscribed: { eq: true } });
    expect(l.filter).toEqual({ subscribed: { eq: true } });
  });

  it("filter returns undefined when attr is absent", () => {
    const l = makeLayout(LAYOUT_SUBTYPE_DATA_GRID, "default");
    expect(l.filter).toBeUndefined();
  });

  it("columns returns the @columns string array", () => {
    const l = makeLayout(LAYOUT_SUBTYPE_DATA_GRID, "default");
    l.setAttr(LAYOUT_DATA_GRID_ATTR_COLUMNS, ["email", "firstName", "createdAt"]);
    expect(l.columns).toEqual(["email", "firstName", "createdAt"]);
  });

  it("columns returns empty array when attr is absent", () => {
    const l = makeLayout(LAYOUT_SUBTYPE_DATA_GRID, "default");
    expect(l.columns).toEqual([]);
  });

  it("all dataGrid attrs set — each getter returns the authored value", () => {
    const l = makeLayout(LAYOUT_SUBTYPE_DATA_GRID, "admin");
    l.setAttr(LAYOUT_DATA_GRID_ATTR_PAGE_SIZE, 25);
    l.setAttr(LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD, "createdAt");
    l.setAttr(LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_ORDER, "desc");
    l.setAttr(LAYOUT_DATA_GRID_ATTR_FILTERABLE, true);
    l.setAttr(LAYOUT_DATA_GRID_ATTR_FILTER, { active: { eq: true } });
    l.setAttr(LAYOUT_DATA_GRID_ATTR_COLUMNS, ["id", "email", "createdAt"]);
    expect(l.pageSize).toBe(25);
    expect(l.defaultSortField).toBe("createdAt");
    expect(l.defaultSortOrder).toBe("desc");
    expect(l.filterable).toBe(true);
    expect(l.filter).toEqual({ active: { eq: true } });
    expect(l.columns).toEqual(["id", "email", "createdAt"]);
  });
});

// ---------------------------------------------------------------------------
// MetaSource
// ---------------------------------------------------------------------------

describe("MetaSource", () => {
  it("extends MetaData", () => {
    const s = makeSource(SOURCE_SUBTYPE_RDB);
    expect(s).toBeInstanceOf(MetaData);
  });

  it("has correct type / subType for rdb", () => {
    const s = makeSource(SOURCE_SUBTYPE_RDB);
    expect(s.type).toBe(TYPE_SOURCE);
    expect(s.subType).toBe(SOURCE_SUBTYPE_RDB);
  });

  it("isReadOnly() is derived from @kind (view ⇒ read-only; omitted/table ⇒ writable)", () => {
    const table = makeRdbSource();                 // @kind omitted → default kind = table
    const view  = makeRdbSource(SOURCE_KIND_VIEW);
    expect(table.isReadOnly()).toBe(false);
    expect(view.isReadOnly()).toBe(true);
  });

  it("isWritable() is the strict complement of isReadOnly() for an rdb source", () => {
    const table = makeRdbSource(SOURCE_KIND_TABLE);
    const view  = makeRdbSource(SOURCE_KIND_VIEW);
    expect(table.isWritable()).toBe(true);
    expect(view.isWritable()).toBe(false);
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

  it("ownAttr() returns passthrough attrs", () => {
    const o = makeOrigin(ORIGIN_SUBTYPE_PASSTHROUGH);
    o.setAttr(ORIGIN_PASSTHROUGH_ATTR_FROM, "Base.label");
    expect(o.ownAttr(ORIGIN_PASSTHROUGH_ATTR_FROM)).toBe("Base.label");
  });

  it("ownAttr() returns aggregate attrs", () => {
    const o = makeOrigin(ORIGIN_SUBTYPE_AGGREGATE);
    o.setAttr(ORIGIN_AGGREGATE_ATTR_AGG, "count");
    o.setAttr(ORIGIN_AGGREGATE_ATTR_OF, "Week.id");
    o.setAttr(ORIGIN_AGGREGATE_ATTR_VIA, "Program.weeks");
    expect(o.ownAttr(ORIGIN_AGGREGATE_ATTR_AGG)).toBe("count");
    expect(o.ownAttr(ORIGIN_AGGREGATE_ATTR_OF)).toBe("Week.id");
    expect(o.ownAttr(ORIGIN_AGGREGATE_ATTR_VIA)).toBe("Program.weeks");
  });
});

// ---------------------------------------------------------------------------
// MetaPassthroughOrigin — typed accessors (Phase B1)
// ---------------------------------------------------------------------------

describe("MetaPassthroughOrigin", () => {
  it("extends MetaOrigin and MetaData", () => {
    const o = makePassthroughOrigin("Program.title");
    expect(o).toBeInstanceOf(MetaOrigin);
    expect(o).toBeInstanceOf(MetaData);
  });

  it("from getter returns the @from attr value", () => {
    const o = makePassthroughOrigin("Program.title");
    expect(o.from).toBe("Program.title");
  });

  it("from getter returns undefined when @from is absent", () => {
    const o = makePassthroughOrigin();
    expect(o.from).toBeUndefined();
  });

  it("via getter returns the @via attr value when present", () => {
    const o = makePassthroughOrigin("Program.title", "Program.weeks");
    expect(o.via).toBe("Program.weeks");
  });

  it("via getter returns undefined when @via is absent", () => {
    const o = makePassthroughOrigin("Program.title");
    expect(o.via).toBeUndefined();
  });

  it("has correct type / subType", () => {
    const o = makePassthroughOrigin("Base.label");
    expect(o.type).toBe(TYPE_ORIGIN);
    expect(o.subType).toBe(ORIGIN_SUBTYPE_PASSTHROUGH);
  });
});

// ---------------------------------------------------------------------------
// MetaAggregateOrigin — typed accessors (Phase B1)
// ---------------------------------------------------------------------------

describe("MetaAggregateOrigin", () => {
  it("extends MetaOrigin and MetaData", () => {
    const o = makeAggregateOrigin("count", "Week.id", "Program.weeks");
    expect(o).toBeInstanceOf(MetaOrigin);
    expect(o).toBeInstanceOf(MetaData);
  });

  it("agg getter returns the @agg attr value", () => {
    const o = makeAggregateOrigin("sum", "Week.durationMinutes", "Program.weeks");
    expect(o.agg).toBe("sum");
  });

  it("of getter returns the @of attr value", () => {
    const o = makeAggregateOrigin("count", "Week.id", "Program.weeks");
    expect(o.of).toBe("Week.id");
  });

  it("via getter returns the @via attr value", () => {
    const o = makeAggregateOrigin("count", "Week.id", "Program.weeks");
    expect(o.via).toBe("Program.weeks");
  });

  it("all getters return undefined when attrs are absent", () => {
    const o = makeAggregateOrigin();
    expect(o.agg).toBeUndefined();
    expect(o.of).toBeUndefined();
    expect(o.via).toBeUndefined();
  });

  it("has correct type / subType", () => {
    const o = makeAggregateOrigin("count", "Week.id", "Program.weeks");
    expect(o.type).toBe(TYPE_ORIGIN);
    expect(o.subType).toBe(ORIGIN_SUBTYPE_AGGREGATE);
  });
});

// ---------------------------------------------------------------------------
// Registry dispatch — origin subtype classes (Phase B1)
// ---------------------------------------------------------------------------

describe("registry dispatch — origin subtype classes", () => {
  it("parsed origin.passthrough node is instanceof MetaPassthroughOrigin and MetaOrigin", async () => {
    const json = JSON.stringify({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.entity": {
              name: "Program",
              children: [
                { "field.long": { name: "id" } },
                { "field.string": { name: "title" } },
                { "identity.primary": { "@fields": "id" } },
              ],
            },
          },
          {
            "object.entity": {
              name: "ProgramSummary",
              extends: "Program",
              children: [
                { "source.rdb": { "@kind": "view", "@table": "v_program_summary" } },
                {
                  "field.string": {
                    name: "displayTitle",
                    children: [
                      { "origin.passthrough": { "@from": "Program.title" } },
                    ],
                  },
                },
                { "identity.primary": { "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });
    const loader = new MetaDataLoader();
    const { root, errors } = await loader.load([new InMemoryStringSource(json)]);
    expect(errors).toEqual([]);
    const summary = root.ownChildByTypeAndName(TYPE_OBJECT, "ProgramSummary") as MetaObject;
    const displayTitle = summary.findField("displayTitle")!;
    const origin = displayTitle.ownChildren().find((c) => c.type === TYPE_ORIGIN);
    expect(origin).toBeInstanceOf(MetaPassthroughOrigin);
    expect(origin).toBeInstanceOf(MetaOrigin);
    expect(origin).toBeInstanceOf(MetaData);
    expect((origin as MetaPassthroughOrigin).from).toBe("Program.title");
  });

  it("parsed origin.aggregate node is instanceof MetaAggregateOrigin and MetaOrigin", async () => {
    const json = JSON.stringify({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.entity": {
              name: "Program",
              children: [
                { "field.long": { name: "id" } },
                { "relationship.association": { name: "weeks", "@objectRef": "Week" } },
                { "identity.primary": { "@fields": "id" } },
              ],
            },
          },
          {
            "object.entity": {
              name: "Week",
              children: [
                { "field.long": { name: "id" } },
                { "identity.primary": { "@fields": "id" } },
              ],
            },
          },
          {
            "object.entity": {
              name: "ProgramSummary",
              extends: "Program",
              children: [
                { "source.rdb": { "@kind": "view", "@table": "v_program_summary" } },
                {
                  "field.int": {
                    name: "weekCount",
                    children: [
                      {
                        "origin.aggregate": {
                          "@agg": "count",
                          "@of": "Week.id",
                          "@via": "Program.weeks",
                        },
                      },
                    ],
                  },
                },
                { "identity.primary": { "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });
    const loader = new MetaDataLoader();
    const { root, errors } = await loader.load([new InMemoryStringSource(json)]);
    expect(errors).toEqual([]);
    const summary = root.ownChildByTypeAndName(TYPE_OBJECT, "ProgramSummary") as MetaObject;
    const weekCount = summary.findField("weekCount")!;
    const origin = weekCount.ownChildren().find((c) => c.type === TYPE_ORIGIN);
    expect(origin).toBeInstanceOf(MetaAggregateOrigin);
    expect(origin).toBeInstanceOf(MetaOrigin);
    expect(origin).toBeInstanceOf(MetaData);
    expect((origin as MetaAggregateOrigin).agg).toBe("count");
    expect((origin as MetaAggregateOrigin).of).toBe("Week.id");
    expect((origin as MetaAggregateOrigin).via).toBe("Program.weeks");
  });

  it("origin.passthrough is NOT instanceof MetaAggregateOrigin", () => {
    const o = makePassthroughOrigin("Program.title");
    expect(o).not.toBeInstanceOf(MetaAggregateOrigin);
  });

  it("origin.aggregate is NOT instanceof MetaPassthroughOrigin", () => {
    const o = makeAggregateOrigin("count", "Week.id", "Program.weeks");
    expect(o).not.toBeInstanceOf(MetaPassthroughOrigin);
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

  it("MetaPassthroughOrigin is instanceof MetaOrigin and MetaData", () => {
    const o = makePassthroughOrigin("Program.title");
    expect(o).toBeInstanceOf(MetaPassthroughOrigin);
    expect(o).toBeInstanceOf(MetaOrigin);
    expect(o).toBeInstanceOf(MetaData);
  });

  it("MetaAggregateOrigin is instanceof MetaOrigin and MetaData", () => {
    const o = makeAggregateOrigin("count", "Week.id", "Program.weeks");
    expect(o).toBeInstanceOf(MetaAggregateOrigin);
    expect(o).toBeInstanceOf(MetaOrigin);
    expect(o).toBeInstanceOf(MetaData);
  });

  it("MetaPassthroughOrigin is NOT instanceof MetaAggregateOrigin", () => {
    expect(makePassthroughOrigin("X.y")).not.toBeInstanceOf(MetaAggregateOrigin);
  });
});

// ---------------------------------------------------------------------------
// Caching — key accessor cached after freeze
// ---------------------------------------------------------------------------

describe("MetaIdentity.fields — reference stability", () => {
  it("fields getter returns the same reference after freeze", () => {
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

// ---------------------------------------------------------------------------
// MetaDataLoader integration — the parser/registry factory builds the MOST SPECIFIC
// concrete node class from JSON. Ported from the deleted test/views.test.ts:
// in the typed-tree design there is no metaOf() view layer, so the only thing
// left to verify is that parsing dispatches to the right concrete subclass.
// ---------------------------------------------------------------------------

describe("MetaDataLoader produces typed concrete nodes from JSON", () => {
  const SAMPLE = JSON.stringify({
    "metadata.root": {
      package: "demo",
      children: [
        {
          "object.entity": {
            name: "User",
            children: [
              { "source.rdb": { "@table": "users" } },
              { "field.long": { name: "id" } },
              {
                "field.string": {
                  name: "email",
                  children: [{ "validator.required": {} }],
                },
              },
              {
                "field.string": {
                  name: "displayName",
                  children: [
                    { "validator.length": { "@min": 1, "@max": 100 } },
                  ],
                },
              },
              {
                "identity.primary": {
                  name: "pk",
                  "@fields": ["id"],
                  "@generation": "increment",
                },
              },
              {
                "identity.secondary": {
                  name: "idx_users_email",
                  "@fields": ["email"],
                },
              },
              {
                "layout.dataGrid": {
                  name: "default",
                  "@pageSize": 25,
                  "@columns": ["id"],
                },
              },
            ],
          },
        },
      ],
    },
  });

  async function loadUser(): Promise<MetaObject> {
    const loader = new MetaDataLoader();
    const { root, errors } = await loader.load([new InMemoryStringSource(SAMPLE)]);
    expect(errors).toEqual([]);
    return root.ownChildByTypeAndName(TYPE_OBJECT, "User") as MetaObject;
  }

  it("root is a MetaRoot, top-level object child is a MetaObject", async () => {
    const loader = new MetaDataLoader();
    const { root } = await loader.load([new InMemoryStringSource(SAMPLE)]);
    expect(root).toBeInstanceOf(MetaRoot);
    const user = root.ownChildByTypeAndName(TYPE_OBJECT, "User");
    expect(user).toBeInstanceOf(MetaObject);
  });

  it("field children are MetaField instances", async () => {
    const user = await loadUser();
    for (const f of user.fields()) {
      expect(f).toBeInstanceOf(MetaField);
    }
  });

  it("source child is a MetaSource", async () => {
    const user = await loadUser();
    const source = user.ownChildren().find((c) => c.type === TYPE_SOURCE);
    expect(source).toBeInstanceOf(MetaSource);
  });

  it("layout child is a MetaLayout", async () => {
    const user = await loadUser();
    const layout = user.ownChildren().find((c) => c.type === TYPE_LAYOUT);
    expect(layout).toBeInstanceOf(MetaLayout);
  });

  it("primary identity → MetaPrimaryIdentity (also MetaIdentity)", async () => {
    const user = await loadUser();
    const pk = user.primaryIdentity()!;
    expect(pk).toBeInstanceOf(MetaPrimaryIdentity);
    expect(pk).toBeInstanceOf(MetaIdentity);
  });

  it("secondary identity → MetaSecondaryIdentity", async () => {
    const user = await loadUser();
    const sec = user.secondaryIdentities()[0]!;
    expect(sec).toBeInstanceOf(MetaSecondaryIdentity);
    expect(sec).toBeInstanceOf(MetaIdentity);
  });

  it("required validator → MetaRequiredValidator; length validator → MetaLengthValidator", async () => {
    const user = await loadUser();
    const emailValidator = user.findField("email")!.validators()[0]!;
    expect(emailValidator).toBeInstanceOf(MetaRequiredValidator);

    const lengthValidator = user.findField("displayName")!.validators()[0]!;
    expect(lengthValidator).toBeInstanceOf(MetaLengthValidator);
  });

  it("regex / numeric / array validators dispatch to their concrete classes", async () => {
    const json = JSON.stringify({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.entity": {
              name: "Widget",
              children: [
                { "field.long": { name: "id" } },
                {
                  "field.string": {
                    name: "slug",
                    children: [{ "validator.regex": { "@pattern": "^[a-z-]+$" } }],
                  },
                },
                {
                  "field.int": {
                    name: "age",
                    children: [{ "validator.numeric": { "@min": 0, "@max": 150 } }],
                  },
                },
                {
                  "field.string": {
                    name: "tags",
                    isArray: true,
                    children: [{ "validator.array": { "@min": 1, "@max": 10 } }],
                  },
                },
                { "identity.primary": { "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });
    const loader = new MetaDataLoader();
    const { root, errors } = await loader.load([new InMemoryStringSource(json)]);
    expect(errors).toEqual([]);
    const widget = root.ownChildByTypeAndName(TYPE_OBJECT, "Widget") as MetaObject;
    expect(widget.findField("slug")!.validators()[0]).toBeInstanceOf(MetaRegexValidator);
    expect(widget.findField("age")!.validators()[0]).toBeInstanceOf(MetaNumericValidator);
    expect(widget.findField("tags")!.validators()[0]).toBeInstanceOf(MetaArrayValidator);
  });

  it("origin child of a field → MetaOrigin", async () => {
    const json = JSON.stringify({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.entity": {
              name: "Base",
              children: [
                { "field.long": { name: "id" } },
                { "field.string": { name: "label" } },
                { "identity.primary": { "@fields": "id" } },
              ],
            },
          },
          {
            "object.entity": {
              name: "Summary",
              children: [
                { "source.rdb": { "@kind": "view", "@table": "v_summary" } },
                {
                  "field.string": {
                    name: "label",
                    children: [
                      { "origin.passthrough": { "@from": "Base.label" } },
                    ],
                  },
                },
                { "identity.primary": { "@fields": "label" } },
              ],
            },
          },
        ],
      },
    });
    const loader = new MetaDataLoader();
    const { root, errors } = await loader.load([new InMemoryStringSource(json)]);
    expect(errors).toEqual([]);
    const summary = root.ownChildByTypeAndName(TYPE_OBJECT, "Summary") as MetaObject;
    const labelField = summary.findField("label")!;
    const origin = labelField.ownChildren().find((c) => c.type === TYPE_ORIGIN);
    // Now yields the concrete subtype class (Phase B1):
    expect(origin).toBeInstanceOf(MetaPassthroughOrigin);
    expect(origin).toBeInstanceOf(MetaOrigin);
  });
});

// ---------------------------------------------------------------------------
// stringArray desugar — single-string @fields / @columns authored values are
// normalized to one-element arrays by the parser, so the MetaIdentity.fields
// getter works (previously it returned [] for the universal single-string
// authoring form). (FR-017 removed @joinFields; FK fields are derived from the
// junction's identity.reference children, which carry @fields.)
// ---------------------------------------------------------------------------

describe("stringArray attr desugar", () => {
  it("MetaIdentity.fields returns ['id'] for an identity authored @fields: 'id'", async () => {
    const json = JSON.stringify({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.entity": {
              name: "User",
              children: [
                { "field.long": { name: "id" } },
                { "identity.primary": { name: "pk", "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });
    const loaderA = new MetaDataLoader();
    const { root, errors } = await loaderA.load([new InMemoryStringSource(json)]);
    expect(errors).toEqual([]);
    const user = root.ownChildByTypeAndName(TYPE_OBJECT, "User") as MetaObject;
    const pk = user.primaryIdentity()!;
    expect(pk).toBeInstanceOf(MetaIdentity);
    // The bug: a single-string @fields previously yielded [] here.
    expect(pk.fields).toEqual(["id"]);
    expect(pk.isComposite()).toBe(false);
  });

  it("identity.reference @fields returns ['vehicleId'] for @fields: 'vehicleId'", async () => {
    const json = JSON.stringify({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.entity": {
              name: "Vehicle",
              children: [
                { "field.long": { name: "id" } },
                { "identity.primary": { name: "pk", "@fields": "id" } },
              ],
            },
          },
          {
            "object.entity": {
              name: "VehicleOwner",
              children: [
                { "field.long": { name: "id" } },
                { "field.long": { name: "vehicleId" } },
                { "identity.primary": { name: "pk", "@fields": "id" } },
                { "identity.reference": { name: "vehicleRef", "@fields": "vehicleId", "@references": "Vehicle" } },
              ],
            },
          },
        ],
      },
    });
    const loaderB = new MetaDataLoader();
    const { root, errors } = await loaderB.load([new InMemoryStringSource(json)]);
    expect(errors).toEqual([]);
    const owner = root.ownChildByTypeAndName(TYPE_OBJECT, "VehicleOwner") as MetaObject;
    const ref = owner.referenceIdentities()[0]!;
    // The bug: a single-string @fields previously yielded [] here.
    expect(ref.fields).toEqual(["vehicleId"]);
  });

  it("an already-array @fields value is left untouched", async () => {
    const json = JSON.stringify({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.entity": {
              name: "Order",
              children: [
                { "field.long": { name: "id" } },
                { "field.string": { name: "tenant" } },
                {
                  "identity.primary": {
                    name: "pk",
                    "@fields": ["id", "tenant"],
                  },
                },
              ],
            },
          },
        ],
      },
    });
    const loaderC = new MetaDataLoader();
    const { root, errors } = await loaderC.load([new InMemoryStringSource(json)]);
    expect(errors).toEqual([]);
    const order = root.ownChildByTypeAndName(TYPE_OBJECT, "Order") as MetaObject;
    const pk = order.primaryIdentity()!;
    expect(pk.fields).toEqual(["id", "tenant"]);
    expect(pk.isComposite()).toBe(true);
  });
});
