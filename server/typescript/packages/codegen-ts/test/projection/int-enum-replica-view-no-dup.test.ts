// A write-through entity (writable table + read-only replica view) emits BOTH the
// Drizzle table and the view declaration into ONE module (entity-file.ts builds
// `[renderDrizzleSchema(...), ...viewSections]`). Both reference the int-backed enum's
// customType codec — and ts-poet deduplicates IMPORTS, never raw code blocks — so the
// codec must be declared exactly once in that file. Declaring it on both sides is a
// duplicate-identifier compile error, i.e. the same class of bug as emitting none.

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

async function loadRoot() {
  const json = JSON.stringify({
    "metadata.root": {
      package: "test",
      children: [
        {
          "object.entity": {
            name: "Shipment",
            children: [
              // Write-through: a writable table AND a read-only replica view.
              { "source.rdb": { "@kind": "table", "@table": "shipment", "@role": "primary" } },
              { "source.rdb": { "@kind": "view", "@view": "v_shipment", "@role": "replica" } },
              { "field.int": { name: "id" } },
              {
                "field.enum": {
                  name: "status",
                  "@required": true,
                  "@values": ["DRAFT", "BOOKED", "DELIVERED"],
                  "@intValueMap": { DRAFT: 0, BOOKED: 10, DELIVERED: 30 },
                },
              },
              { "identity.primary": { name: "pk", "@fields": "id" } },
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

describe("write-through entity: table + replica view in one module", () => {
  for (const dialect of ["sqlite", "postgres"] as const) {
    test(`${dialect}: the int-enum codec is declared exactly once and the module compiles`, async () => {
      const dir = mkdtempSync(join(import.meta.dir, `tmp-replica-dup-${dialect}-`));
      try {
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
        const files = await entityFile({ allowlists: false }).generate(ctx);
        for (const f of files) writeFileSync(join(dir, f.path), f.content);

        const mod = files.find((f) => f.path.includes("Shipment"))!;
        // Declared — the table needs it…
        expect(mod.content).toContain("const statusIntEnum");
        // …exactly once. Twice is `TS2451: Cannot redeclare block-scoped variable`.
        const count = (s: string, needle: string) => s.split(needle).length - 1;
        expect(count(mod.content, "const statusIntEnum =")).toBe(1);
        expect(count(mod.content, "const STATUS_TO_INT =")).toBe(1);
        expect(count(mod.content, "const STATUS_FROM_INT")).toBe(1);

        const program = ts.createProgram(files.map((f) => join(dir, f.path)), {
          strict: true,
          noEmit: true,
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          skipLibCheck: true,
        });
        expect(
          ts.getPreEmitDiagnostics(program).map((d) =>
            ts.flattenDiagnosticMessageText(d.messageText, "\n"),
          ),
        ).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
