// Phase A3 — unit tests for the attribute-schema validation pass.
//
// Each test parses a small metadata document through the MetaDataLoader (which runs
// validateAttrSchema as its seventh pass) and asserts the resulting errors.
// A few tests also call validateAttrSchema directly against a parsed root.

import { describe, it, expect } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemorySource } from "../src/loader/meta-data-source.js";
import { validateAttrSchema } from "../src/attr-schema-validate.js";
import { TypeRegistry } from "../src/registry.js";
import { registerCoreTypes } from "../src/core-types.js";
import { parseJson } from "../src/parser-json.js";

async function load(doc: unknown) {
  const loader = new MetaDataLoader();
  return loader.load([
    new InMemorySource(JSON.stringify(doc), { id: "test.json" }),
  ]);
}

/** Parse a doc and run validateAttrSchema directly (bypasses other passes). */
function validateDirect(doc: unknown) {
  const registry = new TypeRegistry();
  registerCoreTypes(registry);
  const { root } = parseJson(JSON.stringify(doc), { registry });
  return validateAttrSchema(root, registry);
}

describe("attr-schema validation — required attrs", () => {
  it("flags an identity.primary missing its required @fields attr", async () => {
    // Full loader is fine here: no other pass also flags a missing @fields on
    // identity.primary, so this test asserts exactly one error from A3.
    const { errors } = await load({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.entity": {
              name: "Account",
              children: [
                { "field.long": { name: "id" } },
                { "identity.primary": { name: "pk" } },
              ],
            },
          },
        ],
      },
    });
    const msgs = errors.map((e) => e.message);
    expect(msgs).toContain(
      "identity.primary 'pk' is missing required attribute '@fields'",
    );
  });

  it("flags an origin.aggregate missing required @via / @of", () => {
    // Validate directly so the loader's origin-path pass does not also fire.
    const { errors } = validateDirect({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.entity": {
              name: "Summary",
              children: [
                {
                  "field.int": {
                    name: "weekCount",
                    children: [{ "origin.aggregate": { "@agg": "count" } }],
                  },
                },
              ],
            },
          },
        ],
      },
    });
    const msgs = errors.map((e) => e.message);
    expect(msgs).toContain(
      "origin.aggregate is missing required attribute '@of'",
    );
    expect(msgs).toContain(
      "origin.aggregate is missing required attribute '@via'",
    );
  });

  it("does not flag when all required attrs are present", () => {
    const { errors } = validateDirect({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.entity": {
              name: "Account",
              children: [
                { "field.long": { name: "id" } },
                { "identity.primary": { name: "pk", "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });
    expect(errors).toHaveLength(0);
  });

  it("does not flag a node that satisfies a required attr via inheritance (Fix 1)", async () => {
    // BaseAccount declares @fields on its identity.primary. DerivedAccount extends
    // BaseAccount and inherits that identity — the required-attr check must consult
    // effectiveAttrs() so the inherited @fields satisfies the requirement.
    const { errors } = await load({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.entity": {
              name: "BaseAccount",
              "@isAbstract": true,
              children: [
                { "field.long": { name: "id" } },
                { "identity.primary": { name: "pk", "@fields": "id" } },
              ],
            },
          },
          {
            "object.entity": {
              name: "DerivedAccount",
              extends: "BaseAccount",
              children: [
                { "field.string": { name: "email" } },
              ],
            },
          },
        ],
      },
    });
    // DerivedAccount inherits identity.primary with @fields — must not be flagged.
    const relevantErrors = errors.filter((e) =>
      e.message.includes("missing required") && e.message.includes("DerivedAccount"),
    );
    expect(relevantErrors).toHaveLength(0);
  });
});

describe("attr-schema validation — declared attr value types", () => {
  it("flags a layout.dataGrid @pageSize that is a string, not an int", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.entity": {
              name: "Subscriber",
              children: [
                { "field.long": { name: "id" } },
                { "field.string": { name: "email" } },
                { "identity.primary": { name: "pk", "@fields": "id" } },
                {
                  "layout.dataGrid": {
                    name: "default",
                    "@pageSize": "lots",
                    "@columns": ["email"],
                  },
                },
              ],
            },
          },
        ],
      },
    });
    const msgs = errors.map((e) => e.message);
    expect(msgs).toContain(
      "layout.dataGrid 'default' attribute '@pageSize' must be of type 'int' but got string",
    );
  });

  it("accepts a numeric @pageSize", () => {
    const { errors } = validateDirect({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.entity": {
              name: "Subscriber",
              children: [
                {
                  "layout.dataGrid": { name: "default", "@pageSize": 25 },
                },
              ],
            },
          },
        ],
      },
    });
    expect(errors).toHaveLength(0);
  });

  it("flags a boolean attr (@filterable) supplied as a string", () => {
    // "yes" does not coerce to a boolean — it stays a string.
    const { errors } = validateDirect({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.entity": {
              name: "User",
              children: [
                { "field.string": { name: "email", "@filterable": "yes" } },
              ],
            },
          },
        ],
      },
    });
    const msgs = errors.map((e) => e.message);
    expect(msgs).toContain(
      "field.string 'email' attribute '@filterable' must be of type 'boolean' but got string",
    );
  });

  it("accepts @fields as a single string (degenerate one-element form)", () => {
    const { errors } = validateDirect({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.entity": {
              name: "Account",
              children: [
                { "identity.primary": { name: "pk", "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });
    expect(errors).toHaveLength(0);
  });

  it("accepts @fields as a string array (composite identity)", () => {
    const { errors } = validateDirect({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.entity": {
              name: "Account",
              children: [
                {
                  "identity.secondary": {
                    name: "byName",
                    "@fields": ["firstName", "lastName"],
                  },
                },
              ],
            },
          },
        ],
      },
    });
    expect(errors).toHaveLength(0);
  });
});

describe("attr-schema validation — allowedValues", () => {
  it("flags an @generation value outside the allowed set", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.entity": {
              name: "Account",
              children: [
                { "field.long": { name: "id" } },
                {
                  "identity.primary": {
                    name: "pk",
                    "@fields": "id",
                    "@generation": "sequence",
                  },
                },
              ],
            },
          },
        ],
      },
    });
    const msgs = errors.map((e) => e.message);
    expect(msgs).toContain(
      "identity.primary 'pk' attribute '@generation' has value 'sequence' " +
        "which is not one of the allowed values: increment, uuid, assigned",
    );
  });

  it("accepts an @generation value inside the allowed set", () => {
    const { errors } = validateDirect({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.entity": {
              name: "Account",
              children: [
                {
                  "identity.primary": {
                    name: "pk",
                    "@fields": "id",
                    "@generation": "uuid",
                  },
                },
              ],
            },
          },
        ],
      },
    });
    expect(errors).toHaveLength(0);
  });
});

describe("attr-schema validation — open policy", () => {
  it("does NOT flag an undeclared @-attr on a node", () => {
    const { errors } = validateDirect({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.entity": {
              name: "Account",
              children: [
                {
                  "field.string": {
                    name: "email",
                    "@somethingCustom": "anything goes",
                  },
                },
              ],
            },
          },
        ],
      },
    });
    expect(errors).toHaveLength(0);
  });

  it("a fully-clean tree produces no errors and no warnings", () => {
    const { errors, warnings } = validateDirect({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.entity": {
              name: "Program",
              children: [
                { "field.long": { name: "id" } },
                {
                  "field.string": {
                    name: "title",
                    "@maxLength": 200,
                    "@filterable": true,
                  },
                },
                { "identity.primary": { name: "pk", "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });
});
