// FR-017 Tier 2 — Drizzle TPH single-table emission.
//
// A discriminator-bearing base entity emits ONE Drizzle table whose columns are
// the union of the base's columns + every concrete subtype's own columns. Every
// subtype-only column is forced nullable (a row of any OTHER subtype stores NULL
// there), even when the field declares @required. Subtype entities emit NO table
// of their own (TPH is single-table by definition).

import { describe, expect, test } from "bun:test";
import {
  MetaDataLoader,
  InMemoryStringSource,
  type MetaObject,
  type MetaRoot,
} from "@metaobjectsdev/metadata";
import { renderDrizzleSchema } from "../../src/templates/drizzle-schema.js";
import { renderEntityFile } from "../../src/templates/entity-file.js";
import { makeRenderContext } from "../../src/render-context.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";

async function loadTph(): Promise<{ root: MetaRoot; base: MetaObject; bridge: MetaObject }> {
  const loader = new MetaDataLoader();
  const { root, errors } = await loader.load([
    new InMemoryStringSource(
      JSON.stringify({
        "metadata.root": {
          package: "demo",
          children: [
            {
              "object.entity": {
                name: "Auth",
                "@discriminator": "type",
                children: [
                  { "source.rdb": { "@table": "auths" } },
                  { "field.enum": { name: "type", "@values": ["Bridge", "Copay"] } },
                  { "field.long": { name: "id" } },
                  {
                    "identity.primary": { "@fields": "id", "@generation": "increment" },
                  },
                ],
              },
            },
            {
              "object.entity": {
                name: "BridgeAuth",
                extends: "Auth",
                "@discriminatorValue": "Bridge",
                // @required on a subtype-only column — must STILL be nullable in
                // the single TPH table (Copay rows store NULL here).
                children: [{ "field.int": { name: "quantity", "@required": true } }],
              },
            },
            {
              "object.entity": {
                name: "CopayAuth",
                extends: "Auth",
                "@discriminatorValue": "Copay",
                children: [
                  {
                    "field.decimal": {
                      name: "copayAmount",
                      "@precision": 10,
                      "@scale": 2,
                    },
                  },
                ],
              },
            },
          ],
        },
      }),
      { id: "auth.json" },
    ),
  ]);
  if (errors.length > 0) throw new Error(errors.map((e) => e.message).join("; "));
  const base = root.objects().find((o) => o.name === "Auth")! as MetaObject;
  const bridge = root.objects().find((o) => o.name === "BridgeAuth")! as MetaObject;
  return { root, base, bridge };
}

function ctxFor(root: MetaRoot) {
  return makeRenderContext({
    dialect: "postgres",
    loadedRoot: root,
    outDir: "/x",
    dbImport: "~/db",
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
  });
}

describe("FR-017 Tier 2 — Drizzle TPH single-table", () => {
  test("base table unions every concrete subtype's own columns", async () => {
    const { root, base } = await loadTph();
    const out = renderDrizzleSchema(base, ctxFor(root)).toString();

    expect(out).toContain('pgTable("auths"');
    // Base columns.
    expect(out).toContain("id:");
    expect(out).toContain("type:");
    // Subtype-only columns folded into the single table.
    expect(out).toContain("quantity:");
    expect(out).toContain("copay_amount");
  });

  test("subtype-only columns are nullable even when the field is @required", async () => {
    const { root, base } = await loadTph();
    const out = renderDrizzleSchema(base, ctxFor(root)).toString();

    // Isolate the quantity column line; it must NOT carry .notNull().
    const line = out.split("\n").find((l) => l.includes("quantity:"));
    expect(line).toBeDefined();
    expect(line!).not.toContain(".notNull()");
  });

  test("subtype entity emits no Drizzle table of its own", async () => {
    const { root, bridge } = await loadTph();
    const out = renderEntityFile(bridge, ctxFor(root));
    expect(out).not.toContain("pgTable(");
    expect(out).not.toContain("sqliteTable(");
  });
});
