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
import { resolveObjectNames } from "../../src/names.js";

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

// §A6 fix round 3 (RULING R14) — a TPH subtype declares no source.rdb of its own;
// it INHERITS the discriminator base's single shared table (`children()` is
// resolving — ADR-0039). Established empirically before converting: `resolveObjectNames`
// DOES return a defined result for a TPH subtype (name = the base's physical table,
// fields = base-inherited + subtype-own columns), and `namesFile()` really does emit a
// `<Sub>.names.ts` for it — so the literal was NOT correct-and-must-stay here, unlike a
// genuinely sourceless projection (see the Task 1 report, fix round 2).
function ctxForNames(root: MetaRoot, includeNames: boolean) {
  return makeRenderContext({
    dialect: "postgres",
    loadedRoot: root,
    outDir: "/x",
    dbImport: "~/db",
    includeNames,
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
  });
}

describe("FR-017 Tier 3 — a TPH subtype's own $table constant (§A6 fix round 3)", () => {
  test("with the names generator ACTIVE, the subtype's $table references its OWN constant", async () => {
    const { root, bridge } = await loadTph();
    const out = renderEntityFile(bridge, ctxForNames(root, true));

    expect(out).toContain(`import { BridgeAuthNames } from "./BridgeAuth.names.js";`);
    expect(out).toContain("$table: BridgeAuthNames.name");
    // The literal must be GONE, not merely accompanied.
    expect(out).not.toContain('$table: "auths"');
  });

  test("BridgeAuthNames.name and AuthNames.name resolve to the SAME shared table — TPH is single-table by definition", async () => {
    const { root, base, bridge } = await loadTph();
    const baseOut = renderEntityFile(base, ctxForNames(root, true));
    const subOut = renderEntityFile(bridge, ctxForNames(root, true));

    // Both descriptors reference their OWN constant symbol (not each other's) —
    // §A2/§A3's point is that each object gets its own artifact, resolved through
    // the SAME function, so two independently-resolved constants cannot disagree —
    // not that a subtype borrows its base's symbol.
    expect(baseOut).toContain("$table: AuthNames.name");
    expect(subOut).toContain("$table: BridgeAuthNames.name");
    // And the two artifacts' own `name` fields, read directly off the resolver both
    // ultimately defer to, are identical strings (the shared physical table).
    const baseNames = resolveObjectNames(base, "snake_case");
    const subNames = resolveObjectNames(bridge, "snake_case");
    expect(baseNames?.name).toBe("auths");
    expect(subNames?.name).toBe("auths");
  });

  test("with the names generator ABSENT, the subtype's $table keeps its literal", async () => {
    const { root, bridge } = await loadTph();
    const out = renderEntityFile(bridge, ctxForNames(root, false));

    expect(out).toContain('$table: "auths"');
    expect(out).not.toContain("BridgeAuthNames");
  });
});
