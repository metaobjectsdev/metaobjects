// NOTE: data-grid and grid-column were VIEW subtypes in the pre-E-T2 vocabulary.
// They have moved to the `layout` type as `dataGrid` (LAYOUT_SUBTYPE_DATA_GRID).
// These tests now verify the new layout-based data-grid model.
// Legacy fixture tests that used view[data-grid] on objects are removed here;
// E-T3 + E-T4 handle the full codegen-ts-tanstack and metadata migration.

import { describe, test, expect } from "bun:test";
import {
  TYPE_LAYOUT, TYPE_OBJECT, TYPE_FIELD,
  LAYOUT_SUBTYPE_DATA_GRID,
  LAYOUT_DATA_GRID_ATTR_PAGE_SIZE, LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD, LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_ORDER,
  LAYOUT_DATA_GRID_ATTR_FILTERABLE,
  OBJECT_SUBTYPE_ENTITY, FIELD_SUBTYPE_STRING,
} from "../src/index.js";
import { FileMetaDataLoader } from "../src/core/file-meta-data-loader.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("dataGrid layout subtype constants", () => {
  test("LAYOUT_SUBTYPE_DATA_GRID has expected string value", () => {
    expect(LAYOUT_SUBTYPE_DATA_GRID).toBe("dataGrid");
  });
  test("layout data-grid attrs have stable string values", () => {
    expect(LAYOUT_DATA_GRID_ATTR_PAGE_SIZE).toBe("pageSize");
    expect(LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD).toBe("defaultSortField");
    expect(LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_ORDER).toBe("defaultSortOrder");
    expect(LAYOUT_DATA_GRID_ATTR_FILTERABLE).toBe("filterable");
  });
});

describe("FileMetaDataLoader accepts dataGrid layouts on objects", () => {
  test("dataGrid layout loads cleanly on an entity", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "loader-data-grid-layout-"));
    const path = join(tmp, "fixture.json");
    writeFileSync(path, JSON.stringify({
      "metadata.root": { children: [
        { [`object.${OBJECT_SUBTYPE_ENTITY}`]: {
            name: "Sub",
            children: [
              { [`field.${FIELD_SUBTYPE_STRING}`]: { name: "email" } },
              { [`layout.${LAYOUT_SUBTYPE_DATA_GRID}`]: {
                  name: "default",
                  "@pageSize": 25,
              }},
            ],
        }},
      ]},
    }));
    try {
      const result = await new FileMetaDataLoader().loadFiles([path]);
      expect(result.errors).toEqual([]);
      const sub = result.root.ownChildren().find((c) => c.name === "Sub");
      expect(sub).toBeDefined();
      const gridLayout = sub!.ownChildren().find((c) => c.type === TYPE_LAYOUT);
      expect(gridLayout?.subType).toBe("dataGrid");
      expect(gridLayout?.name).toBe("default");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("FileMetaDataLoader validates @defaultSortField references an existing field (layout[dataGrid])", () => {
  test("error when defaultSortField names a field not on the entity", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "loader-sort-validation-"));
    const path = join(tmp, "fixture.json");
    writeFileSync(path, JSON.stringify({
      "metadata.root": { children: [
        { [`object.${OBJECT_SUBTYPE_ENTITY}`]: {
            name: "Sub",
            children: [
              { [`field.${FIELD_SUBTYPE_STRING}`]: { name: "email" } },
              { [`layout.${LAYOUT_SUBTYPE_DATA_GRID}`]: {
                  name: "default",
                  "@defaultSortField": "doesNotExist",
                  "@defaultSortOrder": "asc",
              }},
            ],
        }},
      ]},
    }));
    try {
      const result = await new FileMetaDataLoader().loadFiles([path]);
      expect(result.errors.length).toBeGreaterThan(0);
      const msg = result.errors.map((e) => e.message).join("\n");
      expect(msg).toContain("defaultSortField");
      expect(msg).toContain("doesNotExist");
      expect(msg).toContain("Sub");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("no error when defaultSortField names an existing field", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "loader-sort-ok-"));
    const path = join(tmp, "fixture.json");
    writeFileSync(path, JSON.stringify({
      "metadata.root": { children: [
        { [`object.${OBJECT_SUBTYPE_ENTITY}`]: {
            name: "Sub",
            children: [
              { [`field.${FIELD_SUBTYPE_STRING}`]: { name: "createdAt" } },
              { [`layout.${LAYOUT_SUBTYPE_DATA_GRID}`]: {
                  name: "default",
                  "@defaultSortField": "createdAt",
                  "@defaultSortOrder": "desc",
              }},
            ],
        }},
      ]},
    }));
    try {
      const result = await new FileMetaDataLoader().loadFiles([path]);
      expect(result.errors).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
