// FR-024 B3 — identity names required + projection identity pass-through.
//
// (a) a nameless identity.* node → ERR_IDENTITY_NAME_REQUIRED
// (b) a projection identity `extends: "Customer.id"` resolves to Customer's
//     IDENTITY named "id" (type-scoped), never the field of the same name
// (c) the identity's local key is COMPUTED (pure derivation, no tree mutation)
//     from the local pass-through fields, in the extended identity's order
// (d) an explicit @fields that agrees with the computed set is fine;
//     a disagreeing one → ERR_IDENTITY_KEY_MISMATCH
// (e) an extended-identity field with no local extending field → ERR_IDENTITY_KEY_MISMATCH
// (f) a projection identity without `extends` → ERR_PROJECTION_IDENTITY_NOT_EXTENDED

import { describe, expect, test } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";
import { ERROR_CODES, ParseError } from "../src/errors.js";
import { TYPE_IDENTITY, TYPE_FIELD } from "../src/shared/base-types.js";
import {
  computedIdentityFields,
  identityOwnFields,
} from "../src/core/identity/validate-identity-passthrough.js";

async function load(doc: unknown) {
  const loader = new MetaDataLoader();
  return loader.load([
    new InMemoryStringSource(JSON.stringify(doc), { id: "test.json" }),
  ]);
}

function codes(errors: Error[]): string[] {
  return errors
    .filter((e): e is ParseError => e instanceof ParseError)
    .map((e) => e.code);
}

/** Customer entity + a CustomersV1 projection whose identity passes through. */
function projectionDoc(identityBody: Record<string, unknown>) {
  return {
    "metadata.root": {
      package: "demo",
      children: [
        {
          "object.entity": {
            name: "Customer",
            children: [
              { "field.uuid": { name: "id" } },
              { "field.string": { name: "name" } },
              { "field.string": { name: "internalNotes" } },
              { "identity.primary": { name: "id", "@fields": ["id"] } },
            ],
          },
        },
        {
          "object.projection": {
            name: "CustomersV1",
            children: [
              { "field.uuid": { name: "customerId", extends: "Customer.id" } },
              { "field.string": { name: "name", extends: "Customer.name" } },
              { "identity.primary": identityBody },
            ],
          },
        },
      ],
    },
  };
}

describe("FR-024 B3 — error-code registration", () => {
  test("the three new codes are registered in ERROR_CODES", () => {
    expect(ERROR_CODES).toContain("ERR_IDENTITY_NAME_REQUIRED");
    expect(ERROR_CODES).toContain("ERR_PROJECTION_IDENTITY_NOT_EXTENDED");
    expect(ERROR_CODES).toContain("ERR_IDENTITY_KEY_MISMATCH");
  });
});

describe("FR-024 B3 (a) — identity names required", () => {
  test("a nameless identity.primary errors with ERR_IDENTITY_NAME_REQUIRED", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.entity": {
              name: "Customer",
              children: [
                { "field.uuid": { name: "id" } },
                { "identity.primary": { "@fields": ["id"] } },
              ],
            },
          },
        ],
      },
    });
    expect(codes(errors)).toContain("ERR_IDENTITY_NAME_REQUIRED");
  });

  test("a nameless identity.secondary errors too (all identity subtypes)", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.entity": {
              name: "Customer",
              children: [
                { "field.uuid": { name: "id" } },
                { "field.string": { name: "email" } },
                { "identity.primary": { name: "id", "@fields": ["id"] } },
                { "identity.secondary": { "@fields": ["email"] } },
              ],
            },
          },
        ],
      },
    });
    expect(codes(errors)).toContain("ERR_IDENTITY_NAME_REQUIRED");
  });

  test("a named identity does not error", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.entity": {
              name: "Customer",
              children: [
                { "field.uuid": { name: "id" } },
                { "identity.primary": { name: "id", "@fields": ["id"] } },
              ],
            },
          },
        ],
      },
    });
    expect(codes(errors)).not.toContain("ERR_IDENTITY_NAME_REQUIRED");
    expect(errors).toEqual([]);
  });
});

describe("FR-024 B3 (b) — projection identity extends resolves the IDENTITY, not the field", () => {
  test("identity extends Customer.id selects the identity named id (type-scoped)", async () => {
    const { errors, root } = await load(
      projectionDoc({ name: "id", extends: "Customer.id" }),
    );
    expect(errors).toEqual([]);
    const projection = root.ownChildByName("CustomersV1");
    expect(projection).toBeDefined();
    const identity = projection!
      .ownChildren()
      .find((c) => c.type === TYPE_IDENTITY);
    expect(identity).toBeDefined();
    const resolved = identity!.superResolved;
    expect(resolved).toBeDefined();
    // The tree ALSO has a field named "id" on Customer — the type-scoped
    // dotted resolution must pick the identity, never the field.
    expect(resolved!.type).toBe(TYPE_IDENTITY);
    expect(resolved!.name).toBe("id");
    expect(resolved!.parent?.name).toBe("Customer");
  });
});

describe("FR-024 B3 (c) — computed pass-through key (pure derivation, no mutation)", () => {
  test("computed fields = ['customerId'] from the local field extending Customer.id", async () => {
    const { errors, root } = await load(
      projectionDoc({ name: "id", extends: "Customer.id" }),
    );
    expect(errors).toEqual([]);
    const projection = root.ownChildByName("CustomersV1")!;
    const identity = projection
      .ownChildren()
      .find((c) => c.type === TYPE_IDENTITY)!;
    expect(computedIdentityFields(identity)).toEqual(["customerId"]);
    // NEVER mutate the tree: the identity declares no own @fields.
    expect(identityOwnFields(identity)).toBeUndefined();
  });
});

describe("FR-024 B3 (d) — explicit @fields agreement", () => {
  test("explicit agreeing @fields is accepted", async () => {
    const { errors } = await load(
      projectionDoc({
        name: "id",
        extends: "Customer.id",
        "@fields": ["customerId"],
      }),
    );
    expect(errors).toEqual([]);
  });

  test("explicit disagreeing @fields → ERR_IDENTITY_KEY_MISMATCH", async () => {
    const { errors } = await load(
      projectionDoc({
        name: "id",
        extends: "Customer.id",
        "@fields": ["name"],
      }),
    );
    expect(codes(errors)).toContain("ERR_IDENTITY_KEY_MISMATCH");
  });
});

describe("FR-024 B3 (e) — extended-identity field with no local pass-through", () => {
  test("no local field extends Customer.id → ERR_IDENTITY_KEY_MISMATCH", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.entity": {
              name: "Customer",
              children: [
                { "field.uuid": { name: "id" } },
                { "field.string": { name: "name" } },
                { "identity.primary": { name: "id", "@fields": ["id"] } },
              ],
            },
          },
          {
            "object.projection": {
              name: "CustomersV1",
              children: [
                // only `name` passes through — nothing extends Customer.id
                { "field.string": { name: "name", extends: "Customer.name" } },
                { "identity.primary": { name: "id", extends: "Customer.id" } },
              ],
            },
          },
        ],
      },
    });
    expect(codes(errors)).toContain("ERR_IDENTITY_KEY_MISMATCH");
  });
});

describe("FR-024 B3 (f) — projection identity must extend", () => {
  test("projection identity without extends → ERR_PROJECTION_IDENTITY_NOT_EXTENDED", async () => {
    const { errors } = await load(
      projectionDoc({ name: "id", "@fields": ["customerId"] }),
    );
    expect(codes(errors)).toContain("ERR_PROJECTION_IDENTITY_NOT_EXTENDED");
  });

  test("an ENTITY identity without extends is unaffected (rule is projection-only)", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.entity": {
              name: "Customer",
              children: [
                { "field.uuid": { name: "id" } },
                { "identity.primary": { name: "id", "@fields": ["id"] } },
              ],
            },
          },
        ],
      },
    });
    expect(codes(errors)).not.toContain("ERR_PROJECTION_IDENTITY_NOT_EXTENDED");
  });
});
