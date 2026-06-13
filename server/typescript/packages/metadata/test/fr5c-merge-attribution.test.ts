// FR5c — multi-file overlay merge attribution.
//
// Verifies the loader's overlay-merge phase tracks contributors, raises
// ERR_MERGE_CONFLICT on attribute-level conflicts, and emits
// WARN_DUPLICATE_DECLARATION when a second file re-declares a node
// identically. See `docs/superpowers/specs/2026-05-25-fr5c-multi-file-merge-error-attribution.md`
// and ADR-0009.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "../src/index.js";
import { ParseError } from "../src/errors.js";
import type { ErrorSource } from "../src/source.js";

function mkSource(content: object, id: string): InMemoryStringSource {
  return new InMemoryStringSource(JSON.stringify(content), { id, format: "json" });
}

const baseEntity = {
  "metadata.root": {
    package: "acme",
    children: [
      {
        "object.entity": {
          name: "Subscriber",
          children: [
            { "field.long": { name: "id" } },
            { "field.string": { name: "email" } },
            { "identity.primary": { "name": "id", "@fields": ["id"] } },
          ],
        },
      },
    ],
  },
};

const baseEntityWithStringField = (extraAttrs: Record<string, unknown> = {}) => ({
  "metadata.root": {
    package: "acme",
    children: [
      {
        "object.entity": {
          name: "Subscriber",
          children: [
            { "field.long": { name: "id" } },
            { "field.string": { name: "email", ...extraAttrs } },
            { "identity.primary": { "name": "id", "@fields": ["id"] } },
          ],
        },
      },
    ],
  },
});

describe("FR5c — merge phase tracks contributors", () => {
  test("single-file load → node's source stays format=json (no MergedSource)", async () => {
    const res = await new MetaDataLoader().load([
      mkSource(baseEntity, "meta.a.json"),
    ]);
    expect(res.errors).toEqual([]);
    const sub = res.root.ownChildByName("Subscriber");
    expect(sub).toBeDefined();
    expect(sub!.source.format).toBe("json");
  });

  test("two files contribute → second file with semantic change produces format=merged with both contributors", async () => {
    // File A declares the entity with just id + email.
    // File B re-opens it via overlay and adds @description — that's a real
    // semantic change, so the merged source should list both files.
    const fileA = baseEntity;
    const fileB = {
      "metadata.root": {
        package: "acme",
        children: [
          {
            "object.entity": {
              name: "Subscriber",
              "@description": "A newsletter subscriber.",
            },
          },
        ],
      },
    };
    const res = await new MetaDataLoader().load([
      mkSource(fileA, "meta.a.json"),
      mkSource(fileB, "meta.b.json"),
    ]);
    expect(res.errors).toEqual([]);
    const sub = res.root.ownChildByName("Subscriber");
    expect(sub).toBeDefined();
    expect(sub!.source.format).toBe("merged");
    const src = sub!.source as Extract<ErrorSource, { format: "merged" }>;
    // Files are alphabetically sorted, per the cross-port contract.
    expect(src.files).toEqual(["meta.a.json", "meta.b.json"]);
    expect(src.contributors).toEqual([
      { file: "meta.a.json", role: "overlay-base" },
      { file: "meta.b.json", role: "overlay-extension" },
    ]);
    expect(sub!.ownAttr("description")).toBe("A newsletter subscriber.");
  });

  test("three files contribute → MergedSource lists all three", async () => {
    const fileA = baseEntity;
    const fileB = {
      "metadata.root": {
        package: "acme",
        children: [
          {
            "object.entity": {
              name: "Subscriber",
              "@description": "Subscriber to a newsletter.",
            },
          },
        ],
      },
    };
    const fileC = {
      "metadata.root": {
        package: "acme",
        children: [
          {
            "object.entity": {
              name: "Subscriber",
              "@title": "Subscriber",
            },
          },
        ],
      },
    };
    const res = await new MetaDataLoader().load([
      mkSource(fileA, "meta.a.json"),
      mkSource(fileB, "meta.b.json"),
      mkSource(fileC, "meta.c.json"),
    ]);
    expect(res.errors).toEqual([]);
    const sub = res.root.ownChildByName("Subscriber");
    expect(sub!.source.format).toBe("merged");
    const src = sub!.source as Extract<ErrorSource, { format: "merged" }>;
    expect(src.files).toEqual(["meta.a.json", "meta.b.json", "meta.c.json"]);
    expect(src.contributors[0]!.role).toBe("overlay-base");
    expect(src.contributors[1]!.role).toBe("overlay-extension");
    expect(src.contributors[2]!.role).toBe("overlay-extension");
  });
});

describe("FR5c — ERR_MERGE_CONFLICT on conflicting attr values", () => {
  test("two files set the same @-attr to different non-empty values → ERR_MERGE_CONFLICT with both contributors", async () => {
    const fileA = baseEntityWithStringField({ "@description": "Primary email." });
    const fileB = baseEntityWithStringField({ "@description": "Backup email." });
    const res = await new MetaDataLoader().load([
      mkSource(fileA, "meta.a.json"),
      mkSource(fileB, "meta.b.json"),
    ]);
    const conflicts = res.errors.filter(
      (e) => e instanceof ParseError && e.code === "ERR_MERGE_CONFLICT",
    ) as ParseError[];
    expect(conflicts.length).toBe(1);
    const env = conflicts[0]!.source as Extract<ErrorSource, { format: "merged" }>;
    expect(env.format).toBe("merged");
    expect(env.files).toEqual(["meta.a.json", "meta.b.json"]);
    expect(env.contributors).toEqual([
      { file: "meta.a.json", role: "overlay-base" },
      { file: "meta.b.json", role: "overlay-extension" },
    ]);
    expect(env.jsonPath).toContain("@description");
  });

  test("same attr set to same value → no ERR_MERGE_CONFLICT (last-writer-wins on equal values is fine)", async () => {
    const fileA = baseEntityWithStringField({ "@description": "Email." });
    const fileB = baseEntityWithStringField({ "@description": "Email." });
    const res = await new MetaDataLoader().load([
      mkSource(fileA, "meta.a.json"),
      mkSource(fileB, "meta.b.json"),
    ]);
    const conflicts = res.errors.filter(
      (e) => e instanceof ParseError && e.code === "ERR_MERGE_CONFLICT",
    );
    expect(conflicts).toEqual([]);
  });

  test("only one side declares the attr → no ERR_MERGE_CONFLICT (overlay semantics by design)", async () => {
    const fileA = baseEntityWithStringField({ "@description": "Email." });
    const fileB = baseEntityWithStringField({});
    const res = await new MetaDataLoader().load([
      mkSource(fileA, "meta.a.json"),
      mkSource(fileB, "meta.b.json"),
    ]);
    const conflicts = res.errors.filter(
      (e) => e instanceof ParseError && e.code === "ERR_MERGE_CONFLICT",
    );
    expect(conflicts).toEqual([]);
  });
});

describe("FR5c — WARN_DUPLICATE_DECLARATION via semantic_diff", () => {
  test("two files declare the same node identically → WARN_DUPLICATE_DECLARATION emitted", async () => {
    // Use an abstract entity (no identity.primary, no anonymous children that
    // would duplicate on a second pass through the wrapper). Two identical
    // declarations from different files should produce no semantic change and
    // therefore emit the duplicate-declaration warning.
    const file = {
      "metadata.root": {
        package: "acme",
        children: [
          {
            "object.entity": {
              name: "Subscriber",
              abstract: true,
              children: [
                { "field.long": { name: "id" } },
                { "field.string": { name: "email" } },
              ],
            },
          },
        ],
      },
    };
    const res = await new MetaDataLoader().load([
      mkSource(file, "meta.a.json"),
      mkSource(file, "meta.b.json"),
    ]);
    expect(res.errors).toEqual([]);
    const dups = res.warnings.filter((w) => w.code === "WARN_DUPLICATE_DECLARATION");
    expect(dups.length).toBeGreaterThan(0);
    // One of the warnings should target the top-level Subscriber entity; the
    // walk also visits nested same-name children (id, email, identity.primary).
    // Every warning carries the same merged envelope shape so we inspect the
    // top-level one for clarity.
    const subWarn = dups.find((w) => w.message.includes("Subscriber"));
    expect(subWarn).toBeDefined();
    expect(subWarn!.source.format).toBe("merged");
    const src = subWarn!.source as Extract<ErrorSource, { format: "merged" }>;
    expect(src.files).toEqual(["meta.a.json", "meta.b.json"]);
    expect(src.contributors[0]!.role).toBe("overlay-base");
    expect(src.contributors[1]!.role).toBe("overlay-extension");
  });

  test("real semantic overlay → no WARN_DUPLICATE_DECLARATION (genuine merge)", async () => {
    const fileA = baseEntity;
    const fileB = {
      "metadata.root": {
        package: "acme",
        children: [
          {
            "object.entity": {
              name: "Subscriber",
              "@description": "Differs from A.",
            },
          },
        ],
      },
    };
    const res = await new MetaDataLoader().load([
      mkSource(fileA, "meta.a.json"),
      mkSource(fileB, "meta.b.json"),
    ]);
    const dups = res.warnings.filter((w) => w.code === "WARN_DUPLICATE_DECLARATION");
    expect(dups).toEqual([]);
  });
});

describe("FR5c — overlay-base/overlay-extension role ordering", () => {
  test("contributors[0].role is overlay-base, contributors[i>0].role is overlay-extension", async () => {
    const fileA = baseEntity;
    const fileB = {
      "metadata.root": {
        package: "acme",
        children: [
          {
            "object.entity": {
              name: "Subscriber",
              "@title": "Subscriber",
            },
          },
        ],
      },
    };
    const res = await new MetaDataLoader().load([
      mkSource(fileA, "meta.a.json"),
      mkSource(fileB, "meta.b.json"),
    ]);
    const sub = res.root.ownChildByName("Subscriber")!;
    const src = sub.source as Extract<ErrorSource, { format: "merged" }>;
    expect(src.contributors[0]!.role).toBe("overlay-base");
    expect(src.contributors[1]!.role).toBe("overlay-extension");
  });
});
