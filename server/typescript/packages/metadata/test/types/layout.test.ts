import { describe, test, expect } from "bun:test";
import {
  TYPE_LAYOUT,
  TYPE_OBJECT,
  TYPE_VIEW,
  LAYOUT_SUBTYPES,
  LAYOUT_SUBTYPE_DATA_GRID,
  LAYOUT_DATA_GRID_ATTR_PAGE_SIZE,
  LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD,
  LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_ORDER,
  LAYOUT_DATA_GRID_ATTR_FILTERABLE,
  LAYOUT_DATA_GRID_ATTR_FILTER,
  LAYOUT_DATA_GRID_ATTR_COLUMNS,
  FIELD_ATTR_DB_INDEXED,
  SUBTYPE_BASE,
  VIEW_SUBTYPES,
} from "../../src/constants.js";
import { TypeRegistry } from "../../src/registry.js";
import { registerCoreTypes } from "../../src/core-types.js";
import { MetaLayout } from "../../src/meta/meta-layout.js";
import { TypeId } from "../../src/registry.js";

describe("layout type constants", () => {
  test("TYPE_LAYOUT is 'layout'", () => {
    expect(TYPE_LAYOUT).toBe("layout");
  });
  test("LAYOUT_SUBTYPE_DATA_GRID is 'dataGrid' (camelCase)", () => {
    expect(LAYOUT_SUBTYPE_DATA_GRID).toBe("dataGrid");
  });
  test("LAYOUT_SUBTYPES contains base + dataGrid", () => {
    expect(LAYOUT_SUBTYPES).toContain(SUBTYPE_BASE);
    expect(LAYOUT_SUBTYPES).toContain(LAYOUT_SUBTYPE_DATA_GRID);
  });
  test("dataGrid attrs are camelCase strings", () => {
    expect(LAYOUT_DATA_GRID_ATTR_PAGE_SIZE).toBe("pageSize");
    expect(LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD).toBe("defaultSortField");
    expect(LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_ORDER).toBe("defaultSortOrder");
    expect(LAYOUT_DATA_GRID_ATTR_FILTERABLE).toBe("filterable");
    expect(LAYOUT_DATA_GRID_ATTR_FILTER).toBe("filter");
    expect(LAYOUT_DATA_GRID_ATTR_COLUMNS).toBe("columns");
  });
});

describe("field attr @db.indexed", () => {
  test("FIELD_ATTR_DB_INDEXED is 'db.indexed'", () => {
    expect(FIELD_ATTR_DB_INDEXED).toBe("db.indexed");
  });
});

describe("layout registration in core types", () => {
  test("registry knows layout/base and layout/dataGrid", () => {
    const registry = new TypeRegistry();
    registerCoreTypes(registry);
    expect(registry.has(TYPE_LAYOUT, SUBTYPE_BASE)).toBe(true);
    expect(registry.has(TYPE_LAYOUT, LAYOUT_SUBTYPE_DATA_GRID)).toBe(true);
  });

  test("layout subtypes only accept attr children", () => {
    const registry = new TypeRegistry();
    registerCoreTypes(registry);
    const def = registry.find(TYPE_LAYOUT, LAYOUT_SUBTYPE_DATA_GRID);
    expect(def).toBeDefined();
    expect(def!.childRules.length).toBe(1);
    expect(def!.childRules[0]!.childType).toBe("attr");
  });
});

describe("view subtypes no longer include data-grid or grid-column", () => {
  test("VIEW_SUBTYPES does not contain 'data-grid'", () => {
    expect(VIEW_SUBTYPES).not.toContain("data-grid");
  });
  test("VIEW_SUBTYPES does not contain 'grid-column'", () => {
    expect(VIEW_SUBTYPES).not.toContain("grid-column");
  });
});

describe("object child rules drop view, accept layout", () => {
  test("object/entity does not list view in childRules", () => {
    const registry = new TypeRegistry();
    registerCoreTypes(registry);
    const def = registry.find(TYPE_OBJECT, "entity");
    expect(def).toBeDefined();
    const childTypes = def!.childRules.map(r => r.childType);
    expect(childTypes).not.toContain(TYPE_VIEW);
    expect(childTypes).toContain(TYPE_LAYOUT);
  });
});

describe("MetaLayout.filter accessor returns desugared object", () => {
  test("filter returns the stored object when @filter is an object", () => {
    const l = new MetaLayout(new TypeId(TYPE_LAYOUT, LAYOUT_SUBTYPE_DATA_GRID), "default");
    const filterObj = { subscribed: { eq: true } };
    l.setAttr(LAYOUT_DATA_GRID_ATTR_FILTER, filterObj);
    expect(l.filter).toEqual(filterObj);
  });

  test("filter returns undefined when @filter attr is absent", () => {
    const l = new MetaLayout(new TypeId(TYPE_LAYOUT, LAYOUT_SUBTYPE_DATA_GRID), "default");
    expect(l.filter).toBeUndefined();
  });

  test("filter returns undefined when @filter attr is a string (legacy — string is no longer valid)", () => {
    const l = new MetaLayout(new TypeId(TYPE_LAYOUT, LAYOUT_SUBTYPE_DATA_GRID), "default");
    l.setAttr(LAYOUT_DATA_GRID_ATTR_FILTER, '{"subscribed":true}');
    expect(l.filter).toBeUndefined();
  });
});
