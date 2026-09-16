// Regression guard: a VIEW-backed read model carrying an int-backed `field.enum`
// (@intValueMap) generated a module that did not compile —
//
//   src/generated/ShipmentSummary.ts(6,3): error TS2305:
//     Module '"drizzle-orm/sqlite-core"' has no exported member 'statusIntEnum'.
//
// The entity (table) path emits the `customType` codec as a module-local const and
// references it by name. The view path emitted the CALL SITE only, and let the codec
// name fall through to `imp(fnName@drizzle-orm/*-core)` — an import of something that
// package does not export. `meta gen` exits 0; only a typecheck catches it.
//
// `renderExistingViewDecl` serves BOTH a projection and a write-through entity's replica
// view, so the entity read-view — the pattern the authoring guidance recommends over a
// projection — broke the same way. THIS file covers the projection host only: its Shipment
// declares a table source alone, so `isWriteThrough` is false and no view section is built.
// The read-view host, where the table and the view share one module and must not both
// declare the codec, is covered by `int-enum-replica-view-no-dup.test.ts`.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { entityFile } from "../../src/generators/entity-file.js";
import { makeRenderContext } from "../../src/render-context.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";
import type { GenContext } from "../../src/generator.js";

const STATUS = {
  "@values": ["DRAFT", "BOOKED", "DELIVERED", "CANCELLED"],
  "@intValueMap": { DRAFT: 0, BOOKED: 10, DELIVERED: 30, CANCELLED: 90 },
};

async function loadRoot() {
  const json = JSON.stringify({
    "metadata.root": {
      package: "test",
      children: [
        {
          "object.entity": {
            name: "Shipment",
            children: [
              { "source.rdb": { "@table": "shipment" } },
              { "field.int": { name: "id" } },
              { "field.enum": { name: "status", "@required": true, ...STATUS } },
              { "identity.primary": { name: "pk", "@fields": "id" } },
              { "relationship.association": { name: "legs", "@objectRef": "Leg", "@cardinality": "many" } },
            ],
          },
        },
        {
          "object.entity": {
            name: "Leg",
            children: [
              { "source.rdb": { "@table": "leg" } },
              { "field.int": { name: "id" } },
              { "field.int": { name: "shipmentId" } },
              { "identity.primary": { name: "pk", "@fields": "id" } },
              { "identity.reference": { name: "shipmentRef", "@fields": "shipmentId", "@references": "Shipment" } },
            ],
          },
        },
        {
          "object.projection": {
            name: "ShipmentSummary",
            children: [
              { "source.rdb": { "@kind": "view", "@view": "v_shipment_summary" } },
              { "field.int": { name: "id", extends: "Shipment.id", "@required": true } },
              // The int-backed enum, exposed through the VIEW.
              { "field.enum": { name: "status", extends: "Shipment.status", "@required": true } },
              {
                "field.int": {
                  name: "legCount",
                  children: [{ "origin.aggregate": { "@agg": "count", "@of": "Leg.id", "@via": "Shipment.legs" } }],
                },
              },
              { "identity.primary": { name: "pk", extends: "Shipment.pk" } },
            ],
          },
        },
      ],
    },
  });
  const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  if (result.errors.length > 0) {
    throw new Error(`Loader errors:\n${result.errors.map((e) => e.message).join("\n")}`);
  }
  return result.root;
}

function compile(dir: string, files: string[]): readonly ts.Diagnostic[] {
  const program = ts.createProgram(files.map((f) => join(dir, f)), {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
  });
  return ts.getPreEmitDiagnostics(program);
}

async function generate(dialect: "sqlite" | "postgres", dir: string) {
  const root = await loadRoot();
  const renderContext = makeRenderContext({
    dialect,
    loadedRoot: root,
    outDir: dir,
    dbImport: "~/db",
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
  });
  const ctx: GenContext = {
    entities: root.objects(),
    loadedRoot: root,
    matches: () => true,
    projectRoot: dir,
    config: { outDir: dir, extStyle: "none", dbImport: "~/db", dialect } as never,
    renderContext,
    warn: () => {},
  };
  return await entityFile({ allowlists: false }).generate(ctx);
}

describe("view-backed read model with an int-backed field.enum", () => {
  for (const dialect of ["sqlite", "postgres"] as const) {
    test(`${dialect}: the projection module declares its codec and compiles`, async () => {
      const dir = mkdtempSync(join(import.meta.dir, `tmp-int-enum-view-${dialect}-`));
      try {
        const files = await generate(dialect, dir);
        for (const f of files) writeFileSync(join(dir, f.path), f.content);

        const summary = files.find((f) => f.path.includes("ShipmentSummary"))!;
        const core = `drizzle-orm/${dialect === "postgres" ? "pg" : "sqlite"}-core`;

        // The codec must be declared locally, never imported from drizzle core.
        expect(summary.content).toContain("const statusIntEnum");
        expect(summary.content).not.toMatch(
          new RegExp(`import\\s*\\{[^}]*statusIntEnum[^}]*\\}\\s*from\\s*"${core.replace("/", "\\/")}"`),
        );

        const diagnostics = compile(dir, files.map((f) => f.path));
        expect(
          diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")),
        ).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
