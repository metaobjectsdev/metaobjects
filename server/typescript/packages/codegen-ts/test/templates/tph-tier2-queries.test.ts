// FR-017 Tier 2 — polymorphic + per-subtype queries file.
//
// For a TPH discriminator base, the queries file emits:
//   - Polymorphic reads: find<Base>ById / list<BasePlural> dispatch each row
//     through parse<Base> (returning the union type).
//   - NO create/update/delete on the base (you cannot create an abstract base).
//   - Per subtype: list / findById (filtered + parsed with <Sub>Schema) and
//     create / updateById / deleteById against the SINGLE base table, scoped to
//     the discriminator value.
// Subtype entities get NO standalone queries file (their CRUD lives in the
// base's queries file).

import { describe, expect, test } from "bun:test";
import {
  MetaDataLoader,
  InMemoryStringSource,
  type MetaObject,
  type MetaRoot,
} from "@metaobjectsdev/metadata";
import { renderQueriesFile } from "../../src/templates/queries-file.js";
import { queriesFile } from "../../src/generators/queries-file.js";
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

describe("FR-017 Tier 2 — polymorphic base queries", () => {
  test("base emits polymorphic find/list that dispatch through parseAuth", async () => {
    const { root, base } = await loadTph();
    const out = renderQueriesFile(base, ctxFor(root));
    expect(out).toContain("export async function findAuthById");
    expect(out).toContain("export async function listAuths");
    expect(out).toContain("parseAuth");
    // No polymorphic create on the abstract-shaped base.
    expect(out).not.toContain("export async function createAuth(");
  });

  test("base file carries per-subtype CRUD against the single table", async () => {
    const { root, base } = await loadTph();
    const out = renderQueriesFile(base, ctxFor(root));
    expect(out).toContain("export async function listBridgeAuths");
    expect(out).toContain("export async function findBridgeAuthById");
    expect(out).toContain("export async function createBridgeAuth");
    expect(out).toContain("export async function updateBridgeAuthById");
    expect(out).toContain("export async function deleteBridgeAuthById");
    // Per-subtype reads are scoped to the discriminator value + parse with the
    // subtype read schema.
    expect(out).toContain('"Bridge"');
    expect(out).toContain("BridgeAuthSchema");
    // Per-subtype create validates against the subtype insert schema.
    expect(out).toContain("BridgeAuthInsertSchema");
  });
});

describe("FR-017 Tier 2 — subtype gets no standalone queries file", () => {
  test("queriesFile generator filter skips TPH subtypes", async () => {
    const { bridge, base } = await loadTph();
    const gen = queriesFile();
    expect(gen.filter!(bridge)).toBe(false);
    // The base still gets a queries file.
    expect(gen.filter!(base)).toBe(true);
  });
});
