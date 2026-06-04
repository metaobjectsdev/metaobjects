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
        { [`object.${OBJECT_SUBTYPE_ENTITY}`]: {
            name: "Sub",
            children: [
              { [`field.${FIELD_SUBTYPE_LONG}`]: { name: "id",
                  children: [{ [`identity.${IDENTITY_SUBTYPE_PRIMARY}`]: { "@fields": "id" } }] }},
              { [`field.${FIELD_SUBTYPE_STRING}`]: { name: "firstName",
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
        { [`object.${OBJECT_SUBTYPE_ENTITY}`]: {
            name: "Sub",
            children: [
              { [`field.${FIELD_SUBTYPE_LONG}`]: { name: "id",
                  "@filterable": true }},
              { [`identity.${IDENTITY_SUBTYPE_PRIMARY}`]: { "@fields": "id" } },
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

describe("loader guard: @filterable on a subtype with no operator band (SP-H Unit9)", () => {
  test("errors with ERR_FILTERABLE_UNSUPPORTED_SUBTYPE on a filterable field.object", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "loader-filterable-noband-"));
    const path = join(tmp, "fixture.json");
    writeFileSync(path, JSON.stringify({
      metadata: { children: [
        { [`object.${OBJECT_SUBTYPE_ENTITY}`]: {
            name: "Inner",
            children: [
              { [`field.${FIELD_SUBTYPE_LONG}`]: { name: "id",
                  children: [{ [`identity.${IDENTITY_SUBTYPE_PRIMARY}`]: { "@fields": "id" } }] }},
            ],
        }},
        { [`object.${OBJECT_SUBTYPE_ENTITY}`]: {
            name: "Outer",
            children: [
              { [`field.${FIELD_SUBTYPE_LONG}`]: { name: "id",
                  children: [{ [`identity.${IDENTITY_SUBTYPE_PRIMARY}`]: { "@fields": "id" } }] }},
              // field.object has no filter-operator band — @filterable must error.
              { "field.object": { name: "blob",
                  "@objectRef": "Inner", "@storage": "jsonb",
                  "@filterable": true } },
            ],
        }},
      ]},
    }));
    try {
      const result = await new MetaDataLoader().load([new FileSource(path)]);
      const hit = result.errors.find((e) => (e as unknown as { code: string }).code === "ERR_FILTERABLE_UNSUPPORTED_SUBTYPE");
      expect(hit).toBeDefined();
      expect(hit?.message).toContain("Outer.blob");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("no error for a filterable currency / uuid / enum field (op band exists)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "loader-filterable-band-ok-"));
    const path = join(tmp, "fixture.json");
    writeFileSync(path, JSON.stringify({
      metadata: { children: [
        { [`object.${OBJECT_SUBTYPE_ENTITY}`]: {
            name: "Item",
            children: [
              { [`field.${FIELD_SUBTYPE_LONG}`]: { name: "id",
                  children: [{ [`identity.${IDENTITY_SUBTYPE_PRIMARY}`]: { "@fields": "id" } }] }},
              { "field.currency": { name: "price", "@currency": "USD",
                  "@filterable": true, "@db.indexed": true } },
              { "field.uuid": { name: "sku",
                  "@filterable": true, "@db.indexed": true } },
              { "field.enum": { name: "status", "@values": ["A", "B"],
                  "@filterable": true, "@db.indexed": true } },
            ],
        }},
      ]},
    }));
    try {
      const result = await new MetaDataLoader().load([new FileSource(path)]);
      const hit = result.errors.find((e) => (e as unknown as { code: string }).code === "ERR_FILTERABLE_UNSUPPORTED_SUBTYPE");
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
        { [`object.${OBJECT_SUBTYPE_ENTITY}`]: {
            name: "Subscriber",
            children: [
              { [`field.${FIELD_SUBTYPE_LONG}`]: { name: "id",
                  children: [{ [`identity.${IDENTITY_SUBTYPE_PRIMARY}`]: { "@fields": "id" } }] }},
              { [`field.${FIELD_SUBTYPE_STRING}`]: {
                  name: "tags",
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
        { [`object.${OBJECT_SUBTYPE_ENTITY}`]: {
            name: "Subscriber",
            children: [
              { [`field.${FIELD_SUBTYPE_LONG}`]: { name: "id",
                  children: [{ [`identity.${IDENTITY_SUBTYPE_PRIMARY}`]: { "@fields": "id" } }] }},
              { [`field.${FIELD_SUBTYPE_STRING}`]: {
                  name: "tags",
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
