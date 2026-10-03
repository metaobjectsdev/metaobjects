// an already-plural entity name used to double-pluralize in generated
// TanStack hook names (useProgramPurchaseStatses instead of useProgramPurchaseStats).

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { renderHooksFile } from "../src/templates/hooks-file.js";
import { makeRenderContext, buildPkMap, buildRelationMap } from "@metaobjectsdev/codegen-ts";

async function loadMetadata(children: unknown[]) {
  const json = JSON.stringify({ "metadata.root": { package: "test", children } });
  const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  if (result.errors.length > 0) {
    throw new Error(
      `Loader errors:\n${result.errors.map((e: { message: string }) => e.message).join("\n")}`,
    );
  }
  return result.root;
}

async function loadFixture() {
  const root = await loadMetadata([
    {
      "object.entity": {
        name: "ProgramPurchaseStats",
        children: [
          { "source.rdb": { "@table": "program_purchase_stats" } },
          { "field.long": { name: "id" } },
          { "field.int": { name: "purchaseCount" } },
          { "identity.primary": { "name": "id", "@fields": "id" } },
        ],
      },
    },
  ]);

  const entity = root.findObject("ProgramPurchaseStats");
  if (!entity) throw new Error("ProgramPurchaseStats not found");

  const ctx = makeRenderContext({
    dialect: "sqlite",
    loadedRoot: root,
    outDir: "/x",
    dbImport: "~/db",
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
  });

  return { entity, ctx };
}

async function loadTphFixture() {
  const root = await loadMetadata([
    {
      "object.entity": {
        name: "AuthStatus",
        "@discriminator": "type",
        children: [
          { "source.rdb": { "@table": "auth_status" } },
          { "field.enum": { name: "type", "@values": ["Bridge"] } },
          { "field.long": { name: "id" } },
          { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } },
        ],
      },
    },
    {
      "object.entity": {
        name: "BridgeStats",
        extends: "AuthStatus",
        "@discriminatorValue": "Bridge",
        children: [{ "field.int": { name: "quantity" } }],
      },
    },
  ]);
  const base = root.findObject("AuthStatus");
  if (!base) throw new Error("AuthStatus not found");
  const ctx = makeRenderContext({
    dialect: "postgres",
    loadedRoot: root,
    outDir: "/x",
    dbImport: "../db",
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
  });
  return { base, ctx };
}

describe("renderHooksFile — TPH base/subtype with already-plural names", () => {
  test("disambiguates the polymorphic list hook and the per-subtype list hook", async () => {
    const { base, ctx } = await loadTphFixture();
    const out = renderHooksFile(base, ctx);
    // Base: detail useAuthStatus vs list useAuthStatusList (AuthStatus already-plural-ish? no —
    // "AuthStatus" is not already-plural, but the discriminator SUBTYPE name "BridgeStats" is).
    expect(out).toContain("export function useBridgeStats(");
    expect(out).toContain("export function useBridgeStatsList(");
    const declared = [...out.matchAll(/export function (use\w+)\(/g)].map((m) => m[1]);
    expect(new Set(declared).size).toBe(declared.length);
  });
});

describe("renderHooksFile — already-plural entity name", () => {
  test("detail hook keeps the bare name; list hook gets a disambiguating List suffix", async () => {
    const { entity, ctx } = await loadFixture();
    const out = renderHooksFile(entity, ctx);
    expect(out).toContain("export function useProgramPurchaseStats(");
    expect(out).toContain("export function useProgramPurchaseStatsList(");
    expect(out).not.toContain("useProgramPurchaseStatses");
  });

  test("never emits the same hook function name twice (would be a duplicate declaration)", async () => {
    const { entity, ctx } = await loadFixture();
    const out = renderHooksFile(entity, ctx);
    const declared = [...out.matchAll(/export function (use\w+)\(/g)].map((m) => m[1]);
    expect(new Set(declared).size).toBe(declared.length);
  });
});
