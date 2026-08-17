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

// The int-backed twin of the rule above. @intValueMap is @values' numeric half —
// the symbol→int mapping belongs to the enum VOCABULARY, not to one column that
// uses it. A shared enum is materialized ONCE as a single named type, so a
// per-field map would give one logical type N storage encodings (and, in ports
// that emit per-TYPE codec artifacts, two same-named declarations).
describe("field.enum — extends a shared abstract enum AND declares own @intValueMap", () => {
  const sharedDecl = {
    "field.enum": {
      name: "Status",
      abstract: true,
      "@values": ["A", "B"],
    },
  };

  function conflicts(errors: unknown[]) {
    return errors.filter(
      (e) => (e as { code?: string }).code === "ERR_ENUM_EXTENDS_VALUES_CONFLICT",
    );
  }

  it("emits ERR_ENUM_EXTENDS_VALUES_CONFLICT when the consuming field owns @intValueMap", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "acme",
        children: [
          sharedDecl,
          {
            "object.entity": {
              name: "Order",
              children: [
                { "field.long": { name: "id" } },
                {
                  "field.enum": {
                    name: "status",
                    extends: "acme::Status",
                    "@intValueMap": { A: 0, B: 1 },
                  },
                },
                { "identity.primary": { name: "id", "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });

    expect(conflicts(errors)).toHaveLength(1);
  });

  it("does NOT emit the conflict when @intValueMap sits on the shared declaration and the field inherits it", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "acme",
        children: [
          {
            "field.enum": {
              name: "Status",
              abstract: true,
              "@values": ["A", "B"],
              "@intValueMap": { A: 0, B: 1 },
            },
          },
          {
            "object.entity": {
              name: "Order",
              children: [
                { "field.long": { name: "id" } },
                { "field.enum": { name: "status", extends: "acme::Status" } },
                { "identity.primary": { name: "id", "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });

    expect(conflicts(errors)).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it("does NOT emit the conflict for an ABSTRACT but NON-ROOT super (nested inside an object), where a per-field map stays legal", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "acme",
        children: [
          {
            "object.entity": {
              name: "Container",
              abstract: true,
              children: [
                { "field.enum": { name: "kind", abstract: true, "@values": ["A", "B"] } },
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
                    "@intValueMap": { A: 0, B: 1 },
                  },
                },
                { "identity.primary": { name: "id", "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });

    expect(conflicts(errors)).toHaveLength(0);
  });
});
