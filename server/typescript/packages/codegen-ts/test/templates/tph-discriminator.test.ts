// FR-017 Tier 1 — TS discriminated union + per-subtype Zod emission.
//
// For an entity with @discriminator + concrete subtypes carrying
// @discriminatorValue, entityFile additionally emits:
//   - The union type `Auth = BridgeAuth | CopayAuth | ...`
//   - Type guards `isBridgeAuth(a): a is BridgeAuth`
//   - The `parseAuth(row)` dispatcher
//
// For each subtype, the subtype's Zod schema pins the discriminator field
// via z.literal("<value>"), so a subtype schema rejects a row of a different
// subtype.

import { describe, expect, test } from "bun:test";
import {
  MetaDataLoader,
  InMemoryStringSource,
  type MetaObject,
} from "@metaobjectsdev/metadata";
import { renderTphDiscriminatorUnion } from "../../src/templates/tph-discriminator.js";
import { renderZodValidators } from "../../src/templates/zod-validators.js";

async function loadTph() {
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
                  {
                    "field.enum": {
                      name: "type",
                      "@values": ["Bridge", "Copay"],
                    },
                  },
                  { "field.long": { name: "id" } },
                  { "identity.primary": { "@fields": "id" } },
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
  const copay = root.objects().find((o) => o.name === "CopayAuth")! as MetaObject;
  return { root, base, bridge, copay };
}

describe("FR-017 Tier 1 — renderTphDiscriminatorUnion", () => {
  test("emits the discriminated union + type guards + parser dispatcher on the base entity", async () => {
    const { root, base } = await loadTph();
    const out = renderTphDiscriminatorUnion(base, root).toString();

    // Union type spans every concrete subtype, base does not appear in members.
    expect(out).toContain("export type Auth = BridgeAuth | CopayAuth");

    // Type guards per subtype.
    expect(out).toContain("export function isBridgeAuth(value: Auth)");
    expect(out).toContain("export function isCopayAuth(value: Auth)");
    expect(out).toContain('value.type === "Bridge"');
    expect(out).toContain('value.type === "Copay"');

    // Dispatcher function reads the discriminator without committing to a
    // subtype yet, then dispatches via switch.
    expect(out).toContain("export function parseAuth(row: unknown): Auth");
    expect(out).toContain('case "Bridge":');
    expect(out).toContain('case "Copay":');
  });

  test("returns null for an entity that has no @discriminator", async () => {
    const { root, bridge } = await loadTph();
    // bridge is a subtype, not the discriminator-bearing root.
    expect(renderTphDiscriminatorUnion(bridge, root)).toBeNull();
  });
});

describe("FR-017 Tier 1 — subtype Zod pins discriminator via z.literal", () => {
  test("BridgeAuth's Zod schema pins type to z.literal(\"Bridge\")", async () => {
    const { bridge } = await loadTph();
    const out = renderZodValidators(bridge).toString();
    expect(out).toContain('z.literal("Bridge")');
  });

  test("CopayAuth's Zod schema pins type to z.literal(\"Copay\")", async () => {
    const { copay } = await loadTph();
    const out = renderZodValidators(copay).toString();
    expect(out).toContain('z.literal("Copay")');
  });

  test("BridgeAuth's schema still emits the subtype-only field", async () => {
    const { bridge } = await loadTph();
    const out = renderZodValidators(bridge).toString();
    expect(out).toContain("quantity:");
  });
});
