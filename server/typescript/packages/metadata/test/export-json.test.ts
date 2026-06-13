// Tests for loadAndExportJson — Phase C-1
//
// Covers:
//   1. Valid multi-file directory → {json, errors:[], warnings:[]} with correct
//      canonical-JSON shape.
//   2. Round-trip stability: json → loadJson → canonicalSerialize produces the
//      same string (stable canonical form).
//   3. Directory with validation errors → errors non-empty, json still returned.
//   4. Uses the conformance fixture `loader-basic-multi-file-same-package`
//      as the multi-file input to prove "multiple files → one payload."

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadAndExportJson } from "../src/core/export-json.js";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";
import { canonicalSerialize } from "../src/serializer-json.js";
import { TYPE_METADATA, SUBTYPE_ROOT } from "../src/index.js";

// ---------------------------------------------------------------------------
// Fixtures directory (repo root relative)
// ---------------------------------------------------------------------------

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..");
const CONFORMANCE_ROOT = join(REPO_ROOT, "fixtures", "conformance");

// ---------------------------------------------------------------------------
// Helper — make a temp directory, clean it up after the suite
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "export-json-test-"));
}

// ---------------------------------------------------------------------------
// 1. Valid multi-file directory (conformance fixture)
// ---------------------------------------------------------------------------

describe("loadAndExportJson — multi-file happy path (conformance fixture)", () => {
  const inputDir = join(CONFORMANCE_ROOT, "loader-basic-multi-file-same-package", "input");

  it("returns empty errors and warnings", async () => {
    const result = await loadAndExportJson(inputDir);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("returns a non-empty json string", async () => {
    const result = await loadAndExportJson(inputDir);
    expect(typeof result.json).toBe("string");
    expect(result.json.length).toBeGreaterThan(0);
  });

  it("json is valid JSON and has canonical metadata.root shape", async () => {
    const result = await loadAndExportJson(inputDir);
    const parsed = JSON.parse(result.json) as unknown;
    expect(parsed).toBeTypeOf("object");
    // Canonical form wraps the root with a fused key
    const keys = Object.keys(parsed as Record<string, unknown>);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe(`${TYPE_METADATA}.${SUBTYPE_ROOT}`);
  });

  it("json contains both ProductA and ProductB (multi-file merge)", async () => {
    const result = await loadAndExportJson(inputDir);
    const parsed = JSON.parse(result.json) as Record<string, unknown>;
    const root = parsed["metadata.root"] as Record<string, unknown>;
    const children = root["children"] as Array<Record<string, unknown>>;
    const entityNames = children.map((child) => {
      const entityBody = Object.values(child)[0] as Record<string, unknown>;
      return entityBody["name"] as string;
    });
    expect(entityNames).toContain("ProductA");
    expect(entityNames).toContain("ProductB");
  });
});

// ---------------------------------------------------------------------------
// 2. Round-trip stability
// ---------------------------------------------------------------------------

describe("loadAndExportJson — round-trip stability", () => {
  const inputDir = join(CONFORMANCE_ROOT, "loader-basic-multi-file-same-package", "input");

  it("json re-loads and re-serializes identically (stable canonical form)", async () => {
    const { json: firstJson } = await loadAndExportJson(inputDir);

    // Parse the exported JSON back into a MetaData tree, then re-serialize.
    const loader = new MetaDataLoader();
    const reloadResult = await loader.load([new InMemoryStringSource(firstJson, { id: "round-trip" })]);
    const secondJson = canonicalSerialize(reloadResult.root);

    expect(secondJson).toBe(firstJson);
  });
});

// ---------------------------------------------------------------------------
// 3. Metadata with validation errors → errors non-empty, json still returned
// ---------------------------------------------------------------------------

describe("loadAndExportJson — validation errors", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = makeTempDir();
    // Write a metadata file that references a non-existent super class.
    writeFileSync(
      join(tempDir, "meta.bad.json"),
      JSON.stringify({
        "metadata.root": {
          package: "test::bad",
          children: [
            {
              "object.entity": {
                name: "Premium",
                extends: "DoesNotExist",
              },
            },
          ],
        },
      }),
    );
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("errors is non-empty", async () => {
    const result = await loadAndExportJson(tempDir);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("json is still returned despite errors", async () => {
    const result = await loadAndExportJson(tempDir);
    expect(typeof result.json).toBe("string");
    expect(result.json.length).toBeGreaterThan(0);
  });

  it("json is valid JSON", async () => {
    const result = await loadAndExportJson(tempDir);
    expect(() => JSON.parse(result.json)).not.toThrow();
  });

  it("error message mentions the missing super class", async () => {
    const result = await loadAndExportJson(tempDir);
    const messages = result.errors.map((e) => e.message);
    expect(messages.some((m) => m.includes("DoesNotExist"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Single valid metadata string in a temp dir (basic smoke test)
// ---------------------------------------------------------------------------

describe("loadAndExportJson — single file smoke test", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = makeTempDir();
    writeFileSync(
      join(tempDir, "meta.items.json"),
      JSON.stringify({
        "metadata.root": {
          package: "test::items",
          children: [
            {
              "object.entity": {
                name: "Item",
                children: [
                  { "field.long": { name: "id" } },
                  { "identity.primary": { "name": "id", "@fields": "id" } },
                ],
              },
            },
          ],
        },
      }),
    );
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns no errors and no warnings", async () => {
    const result = await loadAndExportJson(tempDir);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("json contains the Item entity", async () => {
    const result = await loadAndExportJson(tempDir);
    const parsed = JSON.parse(result.json) as Record<string, unknown>;
    const root = parsed["metadata.root"] as Record<string, unknown>;
    const children = root["children"] as Array<Record<string, unknown>>;
    const entityBody = Object.values(children[0]!)[0] as Record<string, unknown>;
    expect(entityBody["name"]).toBe("Item");
  });
});
