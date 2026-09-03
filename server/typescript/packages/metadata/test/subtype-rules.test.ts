import { describe, it, expect } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";
import { ParseError } from "../src/errors.js";

async function load(json: string) {
  const loader = new MetaDataLoader();
  return loader.load([new InMemoryStringSource(json, { id: "test.json" })]);
}

function codes(errors: Error[]): string[] {
  return errors
    .filter((e): e is ParseError => e instanceof ParseError)
    .map((e) => e.code);
}

describe("subtype rule validation", () => {
  it("value object with a primary identity is an error", async () => {
    const { errors } = await load(
      JSON.stringify({
        "metadata.root": {
          package: "demo",
          children: [
            {
              "object.value": {
                name: "Money",
                children: [
                  { "field.long": { name: "amount" } },
                  { "identity.primary": { name: "pk", "@fields": ["amount"] } },
                ],
              },
            },
          ],
        },
      }),
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.message).toContain("value object");
    expect(errors[0]!.message).toContain("Money");
    expect(errors[0]!.message).toContain("must not have an identity");
    expect(errors[0]!.message).toContain("identity.primary");
  });

  it("value object without a primary identity is fine", async () => {
    const { errors, warnings } = await load(
      JSON.stringify({
        "metadata.root": {
          package: "demo",
          children: [
            {
              "object.value": {
                name: "Money",
                children: [
                  { "field.long": { name: "amount" } },
                  { "field.string": { name: "currency" } },
                ],
              },
            },
          ],
        },
      }),
    );
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it("entity without a primary identity emits a warning", async () => {
    const { errors, warnings } = await load(
      JSON.stringify({
        "metadata.root": {
          package: "demo",
          children: [
            {
              "object.entity": {
                name: "User",
                children: [{ "field.string": { name: "email" } }],
              },
            },
          ],
        },
      }),
    );
    expect(errors).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
    // FR5a: LoadResult.warnings is now LoaderWarning[] — inspect .message.
    expect(warnings[0]!.message).toContain("entity object");
    expect(warnings[0]!.message).toContain("User");
    expect(warnings[0]!.message).toContain("no primary identity");
  });

  it("abstract entity without identity does NOT warn (it's a template)", async () => {
    const { errors, warnings } = await load(
      JSON.stringify({
        "metadata.root": {
          package: "demo",
          children: [
            {
              "object.entity": {
                name: "Auditable",
                abstract: true,
                children: [{ "field.timestamp": { name: "createdAt" } }],
              },
            },
          ],
        },
      }),
    );
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it("entity with a primary identity is fine", async () => {
    const { errors, warnings } = await load(
      JSON.stringify({
        "metadata.root": {
          package: "demo",
          children: [
            {
              "object.entity": {
                name: "User",
                children: [
                  { "field.long": { name: "id" } },
                  { "identity.primary": { name: "pk", "@fields": ["id"] } },
                ],
              },
            },
          ],
        },
      }),
    );
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it("an authored object.base is REFUSED — every base subtype is an abstract anchor", async () => {
    // This test used to assert the opposite: that an `object.base` loads cleanly and is
    // exempt from the entity-without-identity warning. It loaded on TypeScript, C# and
    // Python and FAILED TO LOAD on the JVM, whose impl classes are `public abstract` —
    // the same document, two verdicts. `spec/metamodel/object.json` had said which one
    // was right all along ("Has no runtime semantics of its own; not authored directly").
    // The exemption it was really testing is still covered by the abstract-entity case
    // above, which is the supported way to declare a shape-only template.
    const { errors } = await load(
      JSON.stringify({
        "metadata.root": {
          package: "demo",
          children: [
            {
              "object.base": {
                name: "Tagged",
                children: [{ "field.string": { name: "label" } }],
              },
            },
          ],
        },
      }),
    );
    expect(codes(errors)).toContain("ERR_ABSTRACT_SUBTYPE_AUTHORED");
    expect(errors[0]!.message).toContain("object.base");
    expect(errors[0]!.message).toContain("abstract registry anchor");
  });

  it("an authored field.base is refused too — the rule is the whole base family", async () => {
    const { errors } = await load(
      JSON.stringify({
        "metadata.root": {
          package: "demo",
          children: [
            {
              "object.entity": {
                name: "Tagged",
                children: [{ "field.base": { name: "label" } }],
              },
            },
          ],
        },
      }),
    );
    expect(codes(errors)).toContain("ERR_ABSTRACT_SUBTYPE_AUTHORED");
    expect(errors[0]!.message).toContain("field.base");
  });

  it("a BARE wrapper key for a type with NO declared default is refused", async () => {
    // The other spelling. A bare key omits the subType, so the type's DECLARED default
    // decides — the same accessor the YAML desugar consults, whose contract the shared corpus
    // already pins (yaml-bare-default-subtypes: bare `object:` becomes `object.entity`).
    // `field` declares no default, so this is ERR_MISSING_SUBTYPE with the desugar's own
    // wording; the author omitted a subType, they did not author an anchor.
    //
    // The JSON parser used to GUESS instead — registration order, falling back to `base` —
    // which put the abstract anchor in the answer. See the bare-object case below for the
    // half that must keep loading.
    const { errors } = await load(
      JSON.stringify({
        "metadata.root": {
          package: "demo",
          children: [
            {
              "object.entity": {
                name: "Tagged",
                children: [{ field: { name: "label" } }],
              },
            },
          ],
        },
      }),
    );
    expect(codes(errors)).toContain("ERR_MISSING_SUBTYPE");
    expect(errors[0]!.message).toContain("has no default subType");
  });

  it("a BARE object key still resolves to object.entity — the chartered default", async () => {
    // The control the refusal above must not swallow. `object` DECLARES a default, and
    // `fixtures/yaml-conformance/yaml-bare-default-subtypes` pins bare `object:` desugaring
    // to `object.entity` cross-port. A JSON bare key has to agree with it, or the two input
    // formats mean different things — which is exactly what the guessing resolver did.
    const { errors, root } = await load(
      JSON.stringify({
        "metadata.root": {
          package: "demo",
          children: [
            { object: { name: "Product", children: [{ "field.string": { name: "sku" } }] } },
          ],
        },
      }),
    );
    expect(errors).toHaveLength(0);
    const product = root.children().find((c) => c.name === "Product")!;
    expect(product.subType).toBe("entity");
  });
});

// ---------------------------------------------------------------------------
// FR-024 B4a — value purity + projection licensing (ADR-0028).
// The entity-primary-source-readonly hard cutover is deferred to Phase E (B4b).
// ---------------------------------------------------------------------------

/** A Customer entity for projections to reference/extend. */
const CUSTOMER_ENTITY = {
  "object.entity": {
    name: "Customer",
    children: [
      { "field.uuid": { name: "id" } },
      { "field.string": { name: "name" } },
      { "identity.primary": { name: "id", "@fields": ["id"] } },
    ],
  },
};

describe("FR-024 B4a value purity", () => {
  it("value object with a secondary identity is an error (ANY identity, not just primary)", async () => {
    const { errors } = await load(
      JSON.stringify({
        "metadata.root": {
          package: "demo",
          children: [
            {
              "object.value": {
                name: "Money",
                children: [
                  { "field.long": { name: "amount" } },
                  { "identity.secondary": { name: "byAmount", "@fields": ["amount"] } },
                ],
              },
            },
          ],
        },
      }),
    );
    expect(codes(errors)).toEqual(["ERR_SUBTYPE_RULE_VIOLATION"]);
    expect(errors[0]!.message).toContain("Money");
    expect(errors[0]!.message).toContain("identity");
  });

  it("value object with an ENFORCED reference identity is an error (no table for a physical FK)", async () => {
    // @enforce defaults true → a hard FK, which a non-persisted value cannot carry.
    const { errors } = await load(
      JSON.stringify({
        "metadata.root": {
          package: "demo",
          children: [
            CUSTOMER_ENTITY,
            {
              "object.value": {
                name: "Money",
                children: [
                  { "field.uuid": { name: "customerId" } },
                  {
                    "identity.reference": {
                      name: "customerRef",
                      "@fields": ["customerId"],
                      "@references": "Customer",
                    },
                  },
                ],
              },
            },
          ],
        },
      }),
    );
    expect(codes(errors)).toEqual(["ERR_SUBTYPE_RULE_VIOLATION"]);
    expect(errors[0]!.message).toContain("@enforce: false");
  });

  it("value object with an explicit @enforce:true reference identity is still an error", async () => {
    const { errors } = await load(
      JSON.stringify({
        "metadata.root": {
          package: "demo",
          children: [
            CUSTOMER_ENTITY,
            {
              "object.value": {
                name: "Money",
                children: [
                  { "field.uuid": { name: "customerId" } },
                  {
                    "identity.reference": {
                      name: "customerRef",
                      "@fields": ["customerId"],
                      "@references": "Customer",
                      "@enforce": true,
                    },
                  },
                ],
              },
            },
          ],
        },
      }),
    );
    expect(codes(errors)).toEqual(["ERR_SUBTYPE_RULE_VIOLATION"]);
  });

  // ADR-0046: a value MAY carry a navigation-only (@enforce:false) reference —
  // a DTO/message referencing an entity by id is not persistence.
  it("value object with a navigation-only (@enforce:false) reference is legal", async () => {
    const { errors, warnings } = await load(
      JSON.stringify({
        "metadata.root": {
          package: "demo",
          children: [
            CUSTOMER_ENTITY,
            {
              "object.value": {
                name: "AskForStake",
                children: [
                  { "field.uuid": { name: "customerId" } },
                  {
                    "identity.reference": {
                      name: "customerRef",
                      "@fields": ["customerId"],
                      "@references": "Customer",
                      "@enforce": false,
                    },
                  },
                ],
              },
            },
          ],
        },
      }),
    );
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  // ADR-0046: the reference on a value still resolves — a dangling target fails
  // the load exactly as it would on an entity (ERR_INVALID_REFERENCE).
  it("value object with a navigation-only reference to a NON-existent target is an error", async () => {
    const { errors } = await load(
      JSON.stringify({
        "metadata.root": {
          package: "demo",
          children: [
            {
              "object.value": {
                name: "AskForStake",
                children: [
                  { "field.uuid": { name: "tableId" } },
                  {
                    "identity.reference": {
                      name: "tableRef",
                      "@fields": ["tableId"],
                      "@references": "NoSuchTable",
                      "@enforce": false,
                    },
                  },
                ],
              },
            },
          ],
        },
      }),
    );
    expect(codes(errors)).toEqual(["ERR_INVALID_REFERENCE"]);
  });

  it("value object with a source.* child is an error (values are not persisted shapes)", async () => {
    const { errors } = await load(
      JSON.stringify({
        "metadata.root": {
          package: "demo",
          children: [
            {
              "object.value": {
                name: "Money",
                children: [
                  { "field.long": { name: "amount" } },
                  { "source.rdb": { "@table": "money" } },
                ],
              },
            },
          ],
        },
      }),
    );
    expect(codes(errors)).toEqual(["ERR_SUBTYPE_RULE_VIOLATION"]);
    expect(errors[0]!.message).toContain("Money");
    expect(errors[0]!.message).toContain("source");
  });
});

describe("FR-024 B4a projection licensing", () => {
  it("projection extending an entity is an error (projections only extend projections)", async () => {
    const { errors } = await load(
      JSON.stringify({
        "metadata.root": {
          package: "demo",
          children: [
            CUSTOMER_ENTITY,
            {
              "object.projection": {
                name: "CustomersV1",
                extends: "Customer",
                children: [
                  { "field.string": { name: "extra" } },
                ],
              },
            },
          ],
        },
      }),
    );
    expect(codes(errors)).toEqual(["ERR_SUBTYPE_RULE_VIOLATION"]);
    expect(errors[0]!.message).toContain("CustomersV1");
    expect(errors[0]!.message).toContain("projection");
  });

  it("projection extending another projection is legal (abstract-projection reuse)", async () => {
    const { errors, warnings } = await load(
      JSON.stringify({
        "metadata.root": {
          package: "demo",
          children: [
            CUSTOMER_ENTITY,
            {
              "object.projection": {
                name: "CustomerCore",
                abstract: true,
                children: [
                  { "field.uuid": { name: "customerId", extends: "Customer.id" } },
                  { "field.string": { name: "name", extends: "Customer.name" } },
                ],
              },
            },
            {
              "object.projection": {
                name: "CustomersV1",
                extends: "CustomerCore",
                children: [
                  { "source.rdb": { "@kind": "view", "@view": "v_customers_v1" } },
                ],
              },
            },
          ],
        },
      }),
    );
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it("projection with a writable source (default @kind table) is an error", async () => {
    const { errors } = await load(
      JSON.stringify({
        "metadata.root": {
          package: "demo",
          children: [
            CUSTOMER_ENTITY,
            {
              "object.projection": {
                name: "CustomersV1",
                children: [
                  { "field.string": { name: "name", extends: "Customer.name" } },
                  { "source.rdb": { "@table": "customers_copy" } },
                ],
              },
            },
          ],
        },
      }),
    );
    expect(codes(errors)).toEqual(["ERR_PROJECTION_SOURCE_WRITABLE"]);
    expect(errors[0]!.message).toContain("CustomersV1");
    expect(errors[0]!.message).toContain("table");
  });

  it("projection with an explicit @kind table source is an error", async () => {
    const { errors } = await load(
      JSON.stringify({
        "metadata.root": {
          package: "demo",
          children: [
            CUSTOMER_ENTITY,
            {
              "object.projection": {
                name: "CustomersV1",
                children: [
                  { "field.string": { name: "name", extends: "Customer.name" } },
                  { "source.rdb": { "@kind": "table", "@table": "customers_copy" } },
                ],
              },
            },
          ],
        },
      }),
    );
    expect(codes(errors)).toEqual(["ERR_PROJECTION_SOURCE_WRITABLE"]);
  });

  it("projection with read-only sources (view, materializedView) is legal", async () => {
    const { errors, warnings } = await load(
      JSON.stringify({
        "metadata.root": {
          package: "demo",
          children: [
            CUSTOMER_ENTITY,
            {
              "object.projection": {
                name: "CustomersV1",
                children: [
                  { "field.string": { name: "name", extends: "Customer.name" } },
                  { "source.rdb": { "@kind": "view", "@view": "v_customers_v1" } },
                ],
              },
            },
            {
              "object.projection": {
                name: "CustomersMat",
                children: [
                  { "field.string": { name: "name", extends: "Customer.name" } },
                  {
                    "source.rdb": {
                      "@kind": "materializedView",
                      "@materializedView": "mv_customers",
                    },
                  },
                ],
              },
            },
          ],
        },
      }),
    );
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it("projection without any identity is legal — no error, no warning", async () => {
    const { errors, warnings } = await load(
      JSON.stringify({
        "metadata.root": {
          package: "demo",
          children: [
            CUSTOMER_ENTITY,
            {
              "object.projection": {
                name: "CustomerNames",
                children: [
                  { "field.string": { name: "name", extends: "Customer.name" } },
                ],
              },
            },
          ],
        },
      }),
    );
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });
});
