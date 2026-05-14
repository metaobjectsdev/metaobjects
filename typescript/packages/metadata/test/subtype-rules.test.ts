import { describe, it, expect } from "bun:test";
import { Loader } from "../src/loader.js";

function load(json: string) {
  const loader = new Loader();
  return loader.loadJsonStrings([{ content: json, sourceName: "test.json" }]);
}

describe("subtype rule validation", () => {
  it("value object with a primary identity is an error", () => {
    const { errors } = load(
      JSON.stringify({
        metadata: {
          package: "demo",
          children: [
            {
              object: {
                name: "Money",
                subType: "value",
                children: [
                  { field: { name: "amount", subType: "long" } },
                  { identity: { name: "pk", subType: "primary", "@fields": ["amount"] } },
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
    expect(errors[0]!.message).toContain("must not have a primary identity");
  });

  it("value object without a primary identity is fine", () => {
    const { errors, warnings } = load(
      JSON.stringify({
        metadata: {
          package: "demo",
          children: [
            {
              object: {
                name: "Money",
                subType: "value",
                children: [
                  { field: { name: "amount", subType: "long" } },
                  { field: { name: "currency", subType: "string" } },
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

  it("entity without a primary identity emits a warning", () => {
    const { errors, warnings } = load(
      JSON.stringify({
        metadata: {
          package: "demo",
          children: [
            {
              object: {
                name: "User",
                subType: "entity",
                children: [{ field: { name: "email", subType: "string" } }],
              },
            },
          ],
        },
      }),
    );
    expect(errors).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]!).toContain("entity object");
    expect(warnings[0]!).toContain("User");
    expect(warnings[0]!).toContain("no primary identity");
  });

  it("abstract entity without identity does NOT warn (it's a template)", () => {
    const { errors, warnings } = load(
      JSON.stringify({
        metadata: {
          package: "demo",
          children: [
            {
              object: {
                name: "Auditable",
                subType: "entity",
                "@isAbstract": true,
                children: [{ field: { name: "createdAt", subType: "timestamp" } }],
              },
            },
          ],
        },
      }),
    );
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it("entity with a primary identity is fine", () => {
    const { errors, warnings } = load(
      JSON.stringify({
        metadata: {
          package: "demo",
          children: [
            {
              object: {
                name: "User",
                subType: "entity",
                children: [
                  { field: { name: "id", subType: "long" } },
                  { identity: { name: "pk", subType: "primary", "@fields": ["id"] } },
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

  it("base objects are not subject to the rule (templates)", () => {
    const { errors, warnings } = load(
      JSON.stringify({
        metadata: {
          package: "demo",
          children: [
            {
              object: {
                name: "Tagged",
                subType: "base",
                children: [{ field: { name: "label", subType: "string" } }],
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
