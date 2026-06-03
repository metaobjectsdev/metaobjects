// FR-017 Tier 3 — TanStack hooks for a TPH discriminator base.
//
// The base entity's hooks file carries polymorphic reads (useAuth / useAuths
// returning the union) plus a full per-subtype hook set (list / get / create /
// update / delete) targeting the per-subtype REST sub-paths. Subtype entities
// get NO standalone hooks file.

import { describe, test, expect } from "bun:test";
import {
  MetaDataLoader,
  InMemoryStringSource,
  type MetaObject,
  type MetaRoot,
} from "@metaobjectsdev/metadata";
import { tanstackQuery } from "../src/tanstack-query.js";
import { renderHooksFile } from "../src/templates/hooks-file.js";
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
                  { "identity.primary": { "@fields": "id", "@generation": "increment" } },
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
    dbImport: "../db",
    extStyle: "none",
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
  });
}

describe("FR-017 Tier 3 — TPH TanStack hooks", () => {
  test("generator filter skips TPH subtypes", async () => {
    const { base, bridge } = await loadTph();
    const gen = tanstackQuery();
    expect(gen.filter!(bridge)).toBe(false);
    expect(gen.filter!(base)).toBe(true);
  });

  test("base hooks file emits polymorphic reads returning the union, no base create", async () => {
    const { root, base } = await loadTph();
    const out = renderHooksFile(base, ctxFor(root));
    expect(out).toContain("export const authKeys");
    expect(out).toContain("export function useAuth(");
    expect(out).toContain("export function useAuths(");
    // Polymorphic reads return the Auth union.
    expect(out).toContain("UseQueryResult<Auth>");
    expect(out).toContain("UseQueryResult<Auth[]>");
    // No polymorphic create/update/delete on the abstract-shaped base.
    expect(out).not.toContain("export function useCreateAuth(");
  });

  test("base hooks file carries per-subtype hooks against the sub-paths", async () => {
    const { root, base } = await loadTph();
    const out = renderHooksFile(base, ctxFor(root));
    expect(out).toContain("export function useBridgeAuths(");
    expect(out).toContain("export function useBridgeAuth(");
    expect(out).toContain("export function useCreateBridgeAuth(");
    expect(out).toContain("export function useUpdateBridgeAuth(");
    expect(out).toContain("export function useDeleteBridgeAuth(");
    // Per-subtype CopayAuth too.
    expect(out).toContain("export function useCreateCopayAuth(");
    // Sub-path derived from the lowercased discriminator value.
    expect(out).toContain("/bridge");
    expect(out).toContain("/copay");
    // Create input omits the discriminator.
    expect(out).toContain('Omit<BridgeAuth, "type">');
  });
});
