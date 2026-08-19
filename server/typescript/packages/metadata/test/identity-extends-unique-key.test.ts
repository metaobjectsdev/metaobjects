// #310 — a borrowed key borrows UNIQUENESS, not the entity's choice of main handle.
//
// FR-024 says a projection's identity extends an entity identity, and the shipped,
// byte-gated registry text for `object.projection` says exactly that: "Identity is
// optional and, when present, MUST extend an entity identity." Not "an entity's PRIMARY
// identity" — and an `identity.secondary` IS an entity identity. The loader was stricter
// than the text it ships, so a read model keyed on a business key (a unique code/slug the
// entity models as `identity.secondary`) could not be declared at all, while the surrogate
// `identity.primary` it deliberately never surfaces was the only thing it could borrow.
//
// ADR-0040 is what makes the rule statable: uniqueness lives in the TYPE, so `primary` and
// `secondary` are both unique keys and `identity.reference` — a foreign key — is not.
//
// TWO DOORS. The eager check in parser-core and the deferred one in super-resolve held
// independent copies of the subtype boolean. Every case below runs through BOTH, because a
// one-sided fix passes whichever path the rest of the suite happens to take.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";
import { parseJson } from "../src/parser-json.js";
import { composeRegistry } from "../src/provider.js";
import { coreProviders } from "../src/core-types.js";

/** Account: a surrogate primary key AND a unique business key. */
function model(projectionChildren: Record<string, unknown>[]): string {
  return JSON.stringify({
    "metadata.root": {
      package: "probe::keys",
      children: [
        {
          "object.entity": {
            name: "Account",
            children: [
              { "source.rdb": { "@table": "accounts" } },
              { "field.long": { name: "id", "@column": "id" } },
              { "field.string": { name: "tenant", "@column": "tenant" } },
              { "field.string": { name: "code", "@column": "code" } },
              { "field.long": { name: "ownerId", "@column": "owner_id" } },
              { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
              { "identity.secondary": { name: "byCode", "@fields": ["tenant", "code"] } },
              { "identity.reference": { name: "ownerRef", "@fields": ["ownerId"], "@references": "Account" } },
            ],
          },
        },
        {
          "object.projection": {
            name: "AccountView",
            children: [
              { "source.rdb": { "@kind": "view", "@table": "v_account" } },
              ...projectionChildren,
            ],
          },
        },
      ],
    },
  });
}

/** Door 1 — deferred resolution, the path `MetaDataLoader.load` takes. */
async function loadDeferred(json: string): Promise<string[]> {
  const r = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  return r.errors.map((e) => (e as { code?: string }).code ?? "");
}

/** Door 2 — the EAGER in-parser check (deferSuperResolution defaults to false). */
function loadEager(json: string): string[] {
  try {
    parseJson(json, {
      registry: composeRegistry(coreProviders, { validate: true }),
      sourceName: "probe.json",
    });
    return [];
  } catch (err) {
    return [(err as { code?: string }).code ?? "THREW"];
  }
}

const TENANT_AND_CODE = [
  { "field.string": { name: "tenant", extends: "Account.tenant" } },
  { "field.string": { name: "code", extends: "Account.code" } },
];

describe("#310 — a projection's identity may borrow any UNIQUE key", () => {
  test("identity.primary extends an entity's identity.secondary — both doors", async () => {
    const json = model([
      ...TENANT_AND_CODE,
      { "identity.primary": { name: "pk", extends: "Account.byCode" } },
    ]);
    expect(await loadDeferred(json)).toEqual([]);
    expect(loadEager(json)).toEqual([]);
  });

  test("the borrowed key's @fields pass through, so the view is addressable", async () => {
    const r = await new MetaDataLoader().load([
      new InMemoryStringSource(
        model([...TENANT_AND_CODE, { "identity.primary": { name: "pk", extends: "Account.byCode" } }]),
      ),
    ]);
    expect(r.errors).toEqual([]);
    const proj = r.root.children().find((c) => c.name === "AccountView");
    const pk = proj?.children().find((c) => c.type === "identity" && c.subType === "primary");
    // Composite, and in the extended identity's order — this is what get-by-id keys on.
    expect(pk?.attr("fields")).toEqual(["tenant", "code"]);
  });

  test("the same-subtype cases still load — the relaxation adds, never replaces", async () => {
    const primary = model([
      { "field.long": { name: "id", extends: "Account.id" } },
      { "identity.primary": { name: "pk", extends: "Account.pk" } },
    ]);
    expect(await loadDeferred(primary)).toEqual([]);
    expect(loadEager(primary)).toEqual([]);

    const secondary = model([
      ...TENANT_AND_CODE,
      { "identity.secondary": { name: "byCode", extends: "Account.byCode" } },
    ]);
    expect(await loadDeferred(secondary)).toEqual([]);
    expect(loadEager(secondary)).toEqual([]);
  });
});

describe("#310 — the relaxation is bounded by UNIQUENESS, not by identity-ness", () => {
  test("identity.primary extending an identity.reference is still refused — both doors", async () => {
    // A foreign key is not unique, so it can never back a key. This is the case that
    // separates "borrow any unique key" from "identities extend anything".
    const json = model([
      { "field.long": { name: "ownerId", extends: "Account.ownerId" } },
      { "identity.primary": { name: "pk", extends: "Account.ownerRef" } },
    ]);
    expect(await loadDeferred(json)).toContain("ERR_EXTENDS_TARGET_MISMATCH");
    expect(loadEager(json)).toEqual(["ERR_EXTENDS_TARGET_MISMATCH"]);
  });

  test("a FIELD still may not extend across subtypes — both doors", async () => {
    // The gate's original and only conformance fixture is a field case, and it must be
    // untouched: for a field, subtype IS the datatype. Only the identity axis moved.
    const json = model([
      { "field.uuid": { name: "code", extends: "Account.code" } },
      { "identity.primary": { name: "pk", extends: "Account.pk" } },
    ]);
    expect(await loadDeferred(json)).toContain("ERR_EXTENDS_TARGET_MISMATCH");
    expect(loadEager(json)).toEqual(["ERR_EXTENDS_TARGET_MISMATCH"]);
  });
});
