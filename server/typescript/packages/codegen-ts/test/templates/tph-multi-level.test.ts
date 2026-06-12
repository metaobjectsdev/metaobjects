// FR-017 — multi-level TPH hierarchy (Base → abstract Mid → concrete Leaf).
//
// Per the FR-017 design (open-questions #4): the discriminator is declared once
// on the root; every concrete LEAF carrying @discriminatorValue is a union
// member; intermediate ABSTRACT levels emit no concrete types/routes but their
// fields are inherited by the leaf and folded into the single TPH table.

import { describe, expect, test } from "bun:test";
import {
  MetaDataLoader,
  InMemoryStringSource,
  type MetaObject,
  type MetaRoot,
} from "@metaobjectsdev/metadata";
import { renderEntityFile } from "../../src/templates/entity-file.js";
import { renderDrizzleSchema } from "../../src/templates/drizzle-schema.js";
import { tphPlan } from "../../src/templates/tph-discriminator.js";
import { makeRenderContext } from "../../src/render-context.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";

async function loadMultiLevel(): Promise<{ root: MetaRoot; base: MetaObject; leaf: MetaObject }> {
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
                  { "field.enum": { name: "type", "@values": ["Bridge"] } },
                  { "field.long": { name: "id" } },
                  { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } },
                ],
              },
            },
            {
              // Abstract intermediate level — declares a field, NO @discriminatorValue.
              "object.entity": {
                name: "MidAuth",
                extends: "Auth",
                abstract: true,
                children: [{ "field.string": { name: "midField" } }],
              },
            },
            {
              // Concrete leaf — three levels deep.
              "object.entity": {
                name: "BridgeAuth",
                extends: "MidAuth",
                "@discriminatorValue": "Bridge",
                children: [{ "field.int": { name: "quantity" } }],
              },
            },
          ],
        },
      }),
      { id: "auth.json" },
    ),
  ]);
  if (errors.length > 0) throw new Error(errors.map((e) => e.message).join("; "));
  const find = (n: string) => root.objects().find((o) => o.name === n)! as MetaObject;
  return { root, base: find("Auth"), leaf: find("BridgeAuth") };
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

describe("FR-017 — multi-level TPH hierarchy", () => {
  test("tphPlan includes only the concrete leaf, not the abstract intermediate", async () => {
    const { root, base } = await loadMultiLevel();
    const plan = tphPlan(base, root)!;
    expect(plan).not.toBeNull();
    expect(plan.discriminatorField).toBe("type");
    expect(plan.subtypes.map((s) => s.entity.name)).toEqual(["BridgeAuth"]);
    expect(plan.subtypes[0]!.routeSegment).toBe("bridge");
  });

  test("union is the leaf only; abstract mid is not a member", async () => {
    const { root, base } = await loadMultiLevel();
    const out = renderEntityFile(base, ctxFor(root));
    expect(out).toContain("export type Auth = BridgeAuth");
    expect(out).not.toContain("MidAuth");
  });

  test("single table folds intermediate-level + leaf fields (both nullable)", async () => {
    const { root, base } = await loadMultiLevel();
    const out = renderDrizzleSchema(base, ctxFor(root)).toString();
    expect(out).toContain('pgTable("auths"');
    // midField (from the abstract intermediate) AND quantity (from the leaf).
    expect(out).toContain("mid_field");
    expect(out).toContain("quantity:");
  });

  test("leaf read schema carries the inherited intermediate field", async () => {
    const { root, leaf } = await loadMultiLevel();
    const out = renderEntityFile(leaf, ctxFor(root));
    expect(out).toContain("export const BridgeAuthSchema");
    const idx = out.indexOf("export const BridgeAuthSchema");
    const block = out.slice(idx, idx + 400);
    expect(block).toContain("midField:");
    expect(block).toContain("quantity:");
  });
});
