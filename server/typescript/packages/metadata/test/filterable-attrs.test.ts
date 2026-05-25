import { describe, test, expect } from "bun:test";
import {
  FIELD_ATTR_FILTERABLE,
  FIELD_ATTR_SORTABLE,
  FIELD_ATTR_DB_INDEXED,
  LAYOUT_DATA_GRID_ATTR_FILTER,
  TYPE_OBJECT,
  TYPE_FIELD,
  TYPE_IDENTITY,
  OBJECT_SUBTYPE_ENTITY,
  FIELD_SUBTYPE_STRING,
  FIELD_SUBTYPE_LONG,
  IDENTITY_SUBTYPE_PRIMARY,
} from "../src/index.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { FileSource } from "../src/loader/sources/file-source.js";

describe("filterable + sortable field attr constants", () => {
  test("FIELD_ATTR_FILTERABLE has stable string value", () => {
    expect(FIELD_ATTR_FILTERABLE).toBe("filterable");
  });
  test("FIELD_ATTR_SORTABLE has stable string value", () => {
    expect(FIELD_ATTR_SORTABLE).toBe("sortable");
  });
});

describe("grid filter attr constant", () => {
  test("LAYOUT_DATA_GRID_ATTR_FILTER has stable string value", () => {
    expect(LAYOUT_DATA_GRID_ATTR_FILTER).toBe("filter");
  });
});

describe("loader drift warning for @filterable without index", () => {
  test("emits a warning when a @filterable field has no identity reference and no @db.indexed", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "loader-filterable-warn-"));
    const path = join(tmp, "fixture.json");
    writeFileSync(path, JSON.stringify({
      metadata: { children: [
        { object: {
            name: "Sub", subType: OBJECT_SUBTYPE_ENTITY,
            children: [
              { field: { name: "id",        subType: FIELD_SUBTYPE_LONG,
                  children: [{ identity: { subType: IDENTITY_SUBTYPE_PRIMARY, "@fields": "id" } }] }},
              { field: { name: "firstName", subType: FIELD_SUBTYPE_STRING,
                  "@filterable": true } },
            ],
        }},
      ]},
    }));
    try {
      const result = await new MetaDataLoader().load([new FileSource(path)]);
      expect(result.errors).toEqual([]);
      const warningMessages = (result.warnings ?? []).map((w) => w.message);
      const hit = warningMessages.find((m) => m.includes("Sub.firstName") && m.includes("filterable") && m.includes("index"));
      expect(hit).toBeDefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("no warning when @filterable field is part of an identity", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "loader-filterable-ok-"));
    const path = join(tmp, "fixture.json");
    writeFileSync(path, JSON.stringify({
      metadata: { children: [
        { object: {
            name: "Sub", subType: OBJECT_SUBTYPE_ENTITY,
            children: [
              { field: { name: "id", subType: FIELD_SUBTYPE_LONG,
                  "@filterable": true }},
              { identity: { subType: IDENTITY_SUBTYPE_PRIMARY, "@fields": "id" } },
            ],
        }},
      ]},
    }));
    try {
      const result = await new MetaDataLoader().load([new FileSource(path)]);
      const warningMessages = (result.warnings ?? []).map((w) => w.message);
      const hit = warningMessages.find((m) => m.includes("filterable"));
      expect(hit).toBeUndefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("@db.indexed opts a field out of the @filterable-without-index warning", () => {
  test("@filterable + @db.indexed + no identity → no warning", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "loader-db-indexed-"));
    const path = join(tmp, "fixture.json");
    writeFileSync(path, JSON.stringify({
      metadata: { children: [
        { object: {
            name: "Subscriber", subType: OBJECT_SUBTYPE_ENTITY,
            children: [
              { field: { name: "id", subType: FIELD_SUBTYPE_LONG,
                  children: [{ identity: { subType: IDENTITY_SUBTYPE_PRIMARY, "@fields": "id" } }] }},
              { field: {
                  name: "tags",
                  subType: FIELD_SUBTYPE_STRING,
                  "@filterable": true,
                  "@db.indexed": true,
              }},
            ],
        }},
      ]},
    }));
    try {
      const result = await new MetaDataLoader().load([new FileSource(path)]);
      expect(result.errors).toEqual([]);
      const warningMessages = (result.warnings ?? []).map((w) => w.message);
      const hit = warningMessages.find((m) => m.includes("Subscriber.tags") && m.includes("filterable") && m.includes("index"));
      expect(hit).toBeUndefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("@filterable + no @db.indexed + no identity → warning", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "loader-no-db-indexed-"));
    const path = join(tmp, "fixture.json");
    writeFileSync(path, JSON.stringify({
      metadata: { children: [
        { object: {
            name: "Subscriber", subType: OBJECT_SUBTYPE_ENTITY,
            children: [
              { field: { name: "id", subType: FIELD_SUBTYPE_LONG,
                  children: [{ identity: { subType: IDENTITY_SUBTYPE_PRIMARY, "@fields": "id" } }] }},
              { field: {
                  name: "tags",
                  subType: FIELD_SUBTYPE_STRING,
                  "@filterable": true,
              }},
            ],
        }},
      ]},
    }));
    try {
      const result = await new MetaDataLoader().load([new FileSource(path)]);
      expect(result.errors).toEqual([]);
      const warningMessages = (result.warnings ?? []).map((w) => w.message);
      const hit = warningMessages.find((m) => m.includes("Subscriber.tags") && m.includes("filterable") && m.includes("index"));
      expect(hit).toBeDefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
