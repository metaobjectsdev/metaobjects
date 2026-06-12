// FR-019 — shared + externally-provided enum codegen (TS reference).
//
// Exercises the FULL runGen flow so the shared `enums.ts` module is actually
// emitted and entity files reference it. Three cases:
//   • shared materialized: a root-level abstract field.enum extended by TWO
//     entities → the type + z.enum are emitted ONCE in enums.ts; both entity
//     files reference (no inline redeclaration).
//   • @provided: nothing is emitted for the enum; entity files import it from the
//     configured providedEnumModule; a missing config is a codegen-time error.
//   • inline: a plain <Entity><Field> union is unchanged (no enums.ts, no import).

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGen, defineConfig } from "../../src/index.js";
import { entityFile, queriesFile, barrel } from "../../src/generators/index.js";
import { MetaDataLoader, InMemoryStringSource, type MetaRoot } from "@metaobjectsdev/metadata";

async function loadRoot(doc: unknown): Promise<MetaRoot> {
  const result = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(doc))]);
  expect(result.errors).toEqual([]);
  return result.root;
}

interface RunOut {
  files: Record<string, string>;
  warnings: string[];
}

async function gen(root: MetaRoot, providedEnumModule?: string): Promise<RunOut> {
  const tmp = mkdtempSync(join(tmpdir(), "enum-fr019-"));
  try {
    const result = await runGen({
      config: defineConfig({
        outDir: tmp,
        extStyle: "none",
        dbImport: "~/db",
        dialect: "sqlite",
        generators: [entityFile(), queriesFile(), barrel()],
        ...(providedEnumModule !== undefined && { providedEnumModule }),
      }),
      metadata: root,
    });
    const files: Record<string, string> = {};
    for (const name of readdirSync(tmp)) {
      files[name] = readFileSync(join(tmp, name), "utf-8");
    }
    return { files, warnings: result.warnings };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** A model with a root-level abstract field.enum `Status` extended by two entities. */
function sharedModel(opts: { provided?: boolean } = {}): unknown {
  const decl: Record<string, unknown> = {
    name: "Status",
    abstract: true,
    "@values": ["DRAFT", "PUBLISHED", "ARCHIVED"],
  };
  if (opts.provided) decl["@provided"] = true;
  return {
    "metadata.root": {
      package: "acme",
      children: [
        { "field.enum": decl },
        {
          "object.entity": {
            name: "Order",
            children: [
              { "field.long": { name: "id" } },
              { "field.enum": { name: "status", extends: "Status" } },
              { "source.rdb": { "@table": "orders" } },
              { "identity.primary": { "name": "id", "@fields": ["id"], "@generation": "increment" } },
            ],
          },
        },
        {
          "object.entity": {
            name: "Article",
            children: [
              { "field.long": { name: "id" } },
              { "field.enum": { name: "state", extends: "Status" } },
              { "source.rdb": { "@table": "articles" } },
              { "identity.primary": { "name": "id", "@fields": ["id"], "@generation": "increment" } },
            ],
          },
        },
      ],
    },
  };
}

describe("FR-019 enum-shared-materialized-once", () => {
  test("a root abstract enum extended by two entities is materialized ONCE; both entities reference it", async () => {
    const root = await loadRoot(sharedModel());
    const { files } = await gen(root);

    // The shared module exists and declares the type + z.enum EXACTLY once.
    expect(files["enums.ts"]).toBeDefined();
    const enums = files["enums.ts"]!;
    expect(enums.split('export type Status =').length - 1).toBe(1);
    expect(enums).toContain('export type Status = "DRAFT" | "PUBLISHED" | "ARCHIVED";');
    expect(enums.split("export const StatusEnum =").length - 1).toBe(1);
    expect(enums).toContain('z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"])');

    // Neither entity file redeclares the union — each references the shared type.
    for (const name of ["Order.ts", "Article.ts"]) {
      const f = files[name]!;
      expect(f).toBeDefined();
      expect(f).not.toContain("export type Status =");
      expect(f).toContain('from "./enums"');
      // The shared Zod const is referenced (not an inline z.enum) in the entity schema.
      expect(f).toContain("StatusEnum");
      expect(f).not.toContain('z.enum(["DRAFT"');
    }
  });
});

describe("FR-019 enum-provided", () => {
  test("@provided: true emits NO type anywhere; entities import from the configured module", async () => {
    const root = await loadRoot(sharedModel({ provided: true }));
    const { files } = await gen(root, "@acme/domain-enums");

    // No shared enums module is emitted for a provided enum.
    expect(files["enums.ts"]).toBeUndefined();

    for (const name of ["Order.ts", "Article.ts"]) {
      const f = files[name]!;
      expect(f).not.toContain("export type Status =");
      // The provided type is imported/re-exported from the configured module.
      expect(f).toContain('from "@acme/domain-enums"');
      // Validation stays metaobjects-owned: @values still drive the inline z.enum.
      expect(f).toContain('z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"])');
    }
  });

  test("a @provided enum with no providedEnumModule config is a codegen-time error naming the enum + the key", async () => {
    const root = await loadRoot(sharedModel({ provided: true }));
    let err: unknown;
    try {
      await gen(root); // no providedEnumModule
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toContain("Status");
    expect(msg).toContain("providedEnumModule");
  });
});

describe("FR-019 inline enum unchanged", () => {
  test("a plain inline field.enum still emits a <Entity><Field> union and no shared module", async () => {
    const root = await loadRoot({
      "metadata.root": {
        package: "acme",
        children: [
          {
            "object.entity": {
              name: "Ticket",
              children: [
                { "field.long": { name: "id" } },
                { "field.enum": { name: "priority", "@values": ["LOW", "HIGH"] } },
                { "source.rdb": { "@table": "tickets" } },
                { "identity.primary": { "name": "id", "@fields": ["id"], "@generation": "increment" } },
              ],
            },
          },
        ],
      },
    });
    const { files } = await gen(root);

    expect(files["enums.ts"]).toBeUndefined();
    const t = files["Ticket.ts"]!;
    expect(t).toContain('export type TicketPriority = "LOW" | "HIGH";');
    expect(t).toContain('z.enum(["LOW", "HIGH"])');
    expect(t).not.toContain('from "./enums"');
  });
});
