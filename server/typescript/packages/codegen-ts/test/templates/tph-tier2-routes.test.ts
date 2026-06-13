// FR-017 Tier 2 — per-subtype REST routes for a TPH base.
//
// A discriminator base mounts polymorphic list/get at the base path plus a full
// per-subtype CRUD route set at `<basePath>/<discriminatorValue lowercased>`,
// scoped via the runtime `discriminator` option. The per-subtype create body
// OMITS the discriminator (`.omit({ <disc>: true })`). Subtype entities get no
// standalone routes file.

import { describe, expect, test } from "bun:test";
import {
  MetaDataLoader,
  InMemoryStringSource,
  type MetaObject,
  type MetaRoot,
} from "@metaobjectsdev/metadata";
import { renderRoutesFile } from "../../src/templates/routes-file.js";
import { routesFile } from "../../src/generators/routes-file.js";
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

describe("FR-017 Tier 2 — TPH routes file", () => {
  test("base mounts polymorphic list/get at the base path", async () => {
    const { root, base } = await loadTph();
    const out = renderRoutesFile(base, ctxFor(root));
    expect(out).toContain("mountCrudRoutes");
    expect(out).toContain('expose: ["list", "get"]');
    expect(out).toContain("Auth.$path");
  });

  test("per-subtype route set is discriminator-scoped at the value-derived segment", async () => {
    const { root, base } = await loadTph();
    const out = renderRoutesFile(base, ctxFor(root));
    // Segment is the lowercased discriminator value.
    expect(out).toContain('Auth.$path + "/bridge"');
    expect(out).toContain('Auth.$path + "/copay"');
    // Scoped via the runtime discriminator option.
    expect(out).toContain('discriminator: { column: "type", value: "Bridge" }');
    // Create body OMITS the discriminator.
    expect(out).toContain("BridgeAuthInsertSchema.omit({ type: true })");
  });

  test("routesFile generator skips TPH subtypes", async () => {
    const { bridge, base } = await loadTph();
    const gen = routesFile();
    expect(gen.filter!(bridge)).toBe(false);
    expect(gen.filter!(base)).toBe(true);
  });
});
