// FR-017 Tier 3 — per-subtype filter/sort allowlists.
//
// Each TPH subtype emits its OWN <Sub>FilterAllowlist / <Sub>SortAllowlist,
// excluding the discriminator (it's pinned by the per-subtype route path) and
// including the subtype's own + inherited base filterable fields. The
// per-subtype routes wire to these (not the base's allowlist).

import { describe, expect, test } from "bun:test";
import {
  MetaDataLoader,
  InMemoryStringSource,
  type MetaObject,
  type MetaRoot,
} from "@metaobjectsdev/metadata";
import { renderEntityFile } from "../../src/templates/entity-file.js";
import { renderRoutesFile } from "../../src/templates/routes-file.js";
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
                  // Discriminator is filterable on the base (polymorphic GET).
                  { "field.enum": { name: "type", "@values": ["Bridge", "Copay"], "@filterable": true } },
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
                children: [{ "field.int": { name: "quantity", "@filterable": true } }],
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
    dbImport: "~/db",
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
  });
}

describe("FR-017 Tier 3 — per-subtype filter allowlists", () => {
  test("subtype allowlist includes own filterable fields, excludes the discriminator", async () => {
    const { root, bridge } = await loadTph();
    const out = renderEntityFile(bridge, ctxFor(root));
    expect(out).toContain("export const BridgeAuthFilterAllowlist");
    expect(out).toContain("export const BridgeAuthSortAllowlist");
    // quantity (own, filterable) is allowed; the discriminator `type` is NOT.
    const idx = out.indexOf("BridgeAuthFilterAllowlist");
    const block = out.slice(idx, idx + 300);
    expect(block).toContain("quantity:");
    // Row keys are 2-space indented (`  type:`); guard against the `subType:`
    // substring false-positive.
    expect(block).not.toContain("  type:");
  });

  test("the base entity allowlist still includes the discriminator (polymorphic filter)", async () => {
    const { root, base } = await loadTph();
    const out = renderEntityFile(base, ctxFor(root));
    const idx = out.indexOf("AuthFilterAllowlist");
    const block = out.slice(idx, idx + 300);
    expect(block).toContain("  type:");
  });

  test("per-subtype routes wire to the per-subtype allowlist", async () => {
    const { root, base } = await loadTph();
    const out = renderRoutesFile(base, ctxFor(root));
    expect(out).toContain("BridgeAuthFilterAllowlist");
    expect(out).toContain("BridgeAuthSortAllowlist");
  });
});
