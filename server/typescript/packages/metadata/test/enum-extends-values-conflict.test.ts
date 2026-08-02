// #246 — a field.enum that both extends a shared package-level abstract enum
// AND declares its own @values must fail to load with
// ERR_ENUM_EXTENDS_VALUES_CONFLICT: one shared enum type has one member set,
// so own @values would be silently dropped by the shared-enum codegen collapse.

import { describe, it, expect } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";

async function load(doc: unknown) {
  const loader = new MetaDataLoader();
  return loader.load([new InMemoryStringSource(JSON.stringify(doc))]);
}

describe("field.enum — extends a shared abstract enum AND declares own @values", () => {
  it("emits ERR_ENUM_EXTENDS_VALUES_CONFLICT on the 'status' field when it extends a root-level abstract enum and also declares own @values", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "acme",
        children: [
          {
            "field.enum": {
              name: "Status",
              abstract: true,
              "@values": ["A", "B"],
            },
          },
          {
            "object.entity": {
              name: "Order",
              children: [
                { "field.long": { name: "id" } },
                {
                  "field.enum": {
                    name: "status",
                    extends: "acme::Status",
                    "@values": ["A", "B", "C"],
                  },
                },
                { "identity.primary": { "name": "id", "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });

    const conflictErrors = errors.filter(
      (e) => (e as { code?: string }).code === "ERR_ENUM_EXTENDS_VALUES_CONFLICT",
    );
    expect(conflictErrors).toHaveLength(1);
    expect(conflictErrors[0]!.message).toContain("status");
  });

  it("does NOT emit ERR_ENUM_EXTENDS_VALUES_CONFLICT when the field extends a CONCRETE (non-abstract) enum and also declares own @values", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "acme",
        children: [
          {
            "field.enum": {
              name: "Status",
              "@values": ["A", "B"],
            },
          },
          {
            "object.entity": {
              name: "Order",
              children: [
                { "field.long": { name: "id" } },
                {
                  "field.enum": {
                    name: "status",
                    extends: "acme::Status",
                    "@values": ["A", "B", "C"],
                  },
                },
                { "identity.primary": { "name": "id", "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });

    const conflictErrors = errors.filter(
      (e) => (e as { code?: string }).code === "ERR_ENUM_EXTENDS_VALUES_CONFLICT",
    );
    expect(conflictErrors).toHaveLength(0);
  });

  it("does NOT emit ERR_ENUM_EXTENDS_VALUES_CONFLICT when the field extends an ABSTRACT but NON-ROOT enum (nested inside an object, not the shared package level) and also declares own @values", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "acme",
        children: [
          {
            "object.entity": {
              name: "Container",
              abstract: true,
              children: [
                {
                  "field.enum": {
                    name: "kind",
                    abstract: true,
                    "@values": ["X", "Y"],
                  },
                },
              ],
            },
          },
          {
            "object.entity": {
              name: "Order",
              children: [
                { "field.long": { name: "id" } },
                {
                  "field.enum": {
                    name: "status",
                    extends: "acme::Container.kind",
                    "@values": ["X", "Y", "Z"],
                  },
                },
                { "identity.primary": { "name": "id", "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });

    const conflictErrors = errors.filter(
      (e) => (e as { code?: string }).code === "ERR_ENUM_EXTENDS_VALUES_CONFLICT",
    );
    expect(conflictErrors).toHaveLength(0);
  });
});
