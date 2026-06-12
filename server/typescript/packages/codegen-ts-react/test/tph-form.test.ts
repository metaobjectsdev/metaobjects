// FR-017 Tier 3 — React forms for a TPH hierarchy.
//
// Forms are ALWAYS per-subtype: the discriminator base gets NO form (you can't
// create an abstract base), and each concrete subtype gets a <Sub>Form bound to
// its create schema with the discriminator omitted (it's implicit + injected
// server-side, never rendered).

import { describe, test, expect } from "bun:test";
import {
  MetaDataLoader,
  InMemoryStringSource,
  type MetaObject,
  type MetaRoot,
} from "@metaobjectsdev/metadata";
import { formFile } from "../src/form-file.js";
import { renderFormFile } from "../src/templates/form-file.js";
import { makeRenderContext, buildPkMap, buildRelationMap } from "@metaobjectsdev/codegen-ts";

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
                  { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } },
                ],
              },
            },
            {
              "object.entity": {
                name: "BridgeAuth",
                extends: "Auth",
                "@discriminatorValue": "Bridge",
                children: [{ "field.int": { name: "quantity", "@required": true } }],
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
  const find = (n: string) => root.objects().find((o) => o.name === n)! as MetaObject;
  return { root, base: find("Auth"), bridge: find("BridgeAuth") };
}

function ctxFor(root: MetaRoot) {
  return makeRenderContext({
    dialect: "postgres",
    loadedRoot: root,
    outDir: "/x",
    dbImport: "../db",
    extStyle: "none",
    apiPrefix: "/api",
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
  });
}

describe("FR-017 Tier 3 — TPH React forms", () => {
  test("form generator skips the discriminator base, emits per-subtype forms", async () => {
    const { base, bridge } = await loadTph();
    const gen = formFile();
    expect(gen.filter!(base)).toBe(false);   // no abstract-base form
    expect(gen.filter!(bridge)).toBe(true);  // per-subtype form
  });

  test("subtype form binds to the create schema with the discriminator omitted and doesn't render it", async () => {
    const { root, bridge } = await loadTph();
    const out = renderFormFile(bridge, ctxFor(root));
    expect(out).toContain("export function BridgeAuthForm");
    // Form schema omits the discriminator.
    expect(out).toContain("BridgeAuthInsertSchema.omit({ type: true })");
    // Own subtype field renders; the discriminator field does not.
    expect(out).toContain("BridgeAuth.quantity");
    expect(out).not.toContain("BridgeAuth.type.name");
  });
});
