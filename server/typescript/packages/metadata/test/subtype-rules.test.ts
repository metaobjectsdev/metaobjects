import { describe, it, expect } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemorySource } from "../src/loader/meta-data-source.js";

async function load(json: string) {
  const loader = new MetaDataLoader();
  return loader.load([new InMemorySource(json, { id: "test.json" })]);
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
    expect(errors[0]!.message).toContain("must not have a primary identity");
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
    expect(warnings[0]!).toContain("entity object");
    expect(warnings[0]!).toContain("User");
    expect(warnings[0]!).toContain("no primary identity");
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

  it("base objects are not subject to the rule (templates)", async () => {
    const { errors, warnings } = await load(
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
    expect(errors).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });
});
