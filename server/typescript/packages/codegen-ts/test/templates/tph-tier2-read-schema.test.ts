// FR-017 Tier 2 — per-subtype full read schema `<Sub>Schema`.
//
// Tier 1's parse<Base>(row) dispatcher (tph-discriminator.ts) parses each row
// with `<Subtype>Schema` — a FULL read schema (every effective field, PK
// included, discriminator pinned). The value-object path only emits
// `<Sub>InsertSchema`, so without this schema the generated Auth.ts +
// BridgeAuth.ts do not compile together. This slice emits the read schema in
// each TPH subtype's file.

import { describe, expect, test } from "bun:test";
import {
  MetaDataLoader,
  InMemoryStringSource,
  type MetaObject,
  type MetaRoot,
} from "@metaobjectsdev/metadata";
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
                  // increment generation → InsertSchema OMITS id, read schema KEEPS it.
                  { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } },
                ],
              },
            },
            {
              "object.entity": {
                name: "BridgeAuth",
                extends: "Auth",
                "@discriminatorValue": "Bridge",
                children: [{ "field.int": { name: "quantity" } }],
              },
            },
            {
              "object.entity": {
                name: "CopayAuth",
                extends: "Auth",
                "@discriminatorValue": "Copay",
                children: [
                  { "field.decimal": { name: "copayAmount", "@precision": 10, "@scale": 2 } },
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

describe("FR-017 Tier 2 — per-subtype full read schema", () => {
  test("subtype file emits `export const <Sub>Schema` with the discriminator pinned", async () => {
    const { root, bridge } = await loadTph();
    const out = renderEntityFile(bridge, ctxFor(root));
    expect(out).toContain("export const BridgeAuthSchema");
    expect(out).toContain('type: z.literal("Bridge")');
  });

  test("subtype file emits its field-metadata constants object (for Tier 3 forms)", async () => {
    const { root, bridge } = await loadTph();
    const out = renderEntityFile(bridge, ctxFor(root));
    // The `<Sub>` constants object (used by the React form generator).
    expect(out).toContain("export const BridgeAuth = {");
    expect(out).toContain('$entity: "BridgeAuth"');
    expect(out).toContain("quantity: {");
  });

  test("read schema KEEPS the auto-generated PK (unlike the insert schema)", async () => {
    const { root, bridge } = await loadTph();
    const out = renderEntityFile(bridge, ctxFor(root));
    // Slice the <Sub>Schema block out and assert `id:` is present in it.
    const idx = out.indexOf("export const BridgeAuthSchema");
    expect(idx).toBeGreaterThanOrEqual(0);
    const block = out.slice(idx, idx + 400);
    expect(block).toContain("id:");
    expect(block).toContain("quantity:");
  });

  test("base file's parseAuth references the subtype read schema (Tier 1 contract)", async () => {
    const { root, base } = await loadTph();
    const out = renderEntityFile(base, ctxFor(root));
    expect(out).toContain("parseAuth");
    expect(out).toContain("BridgeAuthSchema");
  });

  test("base file emits the union as the sole `export type Auth` (no collision with the Drizzle row type)", async () => {
    const { root, base } = await loadTph();
    const out = renderEntityFile(base, ctxFor(root));
    // Exactly one `export type Auth =` — the discriminated union.
    const count = (out.match(/export type Auth =/g) ?? []).length;
    expect(count).toBe(1);
    expect(out).toContain("export type Auth = BridgeAuth | CopayAuth");
    // The raw single-table row type is emitted under the non-colliding `AuthRow`.
    expect(out).toContain("export type AuthRow =");
  });
});
