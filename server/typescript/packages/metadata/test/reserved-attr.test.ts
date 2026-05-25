// reserved-attr.test.ts — ERR_RESERVED_ATTR (reserved word as @-attr).
//
// A reserved structural body key (name/package/extends/abstract/overlay/
// isArray/children/value) must NEVER be authored with the @-prefix — the
// runtime form is bare. The parser must reject the @-prefixed form with
// ERR_RESERVED_ATTR so the violation surfaces at load time instead of
// silently materializing a same-named MetaAttr that downstream consumers
// might mistake for a real attribute.

import { describe, expect, test } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";

async function loadDoc(doc: unknown) {
  return new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(doc))]);
}

const codesOf = (errors: readonly Error[]) =>
  errors.map((e) => (e as { code?: string }).code);

describe("ERR_RESERVED_ATTR — reserved word as @-attr", () => {
  test("@isArray on field.object → ERR_RESERVED_ATTR", async () => {
    const { errors } = await loadDoc({
      "metadata.root": {
        package: "acme",
        children: [
          {
            "object.entity": {
              name: "X",
              children: [
                { "field.long": { name: "id" } },
                {
                  "field.object": {
                    name: "bad",
                    "@isArray": true,
                    "@objectRef": "Y",
                  },
                },
                { "identity.primary": { "@fields": "id" } },
              ],
            },
          },
          {
            "object.entity": {
              name: "Y",
              children: [
                { "field.long": { name: "id" } },
                { "identity.primary": { "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });
    expect(codesOf(errors)).toContain("ERR_RESERVED_ATTR");
  });

  test("@name on object.entity → ERR_RESERVED_ATTR", async () => {
    const { errors } = await loadDoc({
      "metadata.root": {
        package: "acme",
        children: [
          {
            "object.entity": {
              "@name": "X",
              children: [
                { "field.long": { name: "id" } },
                { "identity.primary": { "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });
    expect(codesOf(errors)).toContain("ERR_RESERVED_ATTR");
  });

  test("bare isArray on field.object → no ERR_RESERVED_ATTR", async () => {
    const { errors } = await loadDoc({
      "metadata.root": {
        package: "acme",
        children: [
          {
            "object.entity": {
              name: "X",
              children: [
                { "field.long": { name: "id" } },
                {
                  "field.object": {
                    name: "good",
                    isArray: true,
                    "@objectRef": "Y",
                  },
                },
                { "identity.primary": { "@fields": "id" } },
              ],
            },
          },
          {
            "object.entity": {
              name: "Y",
              children: [
                { "field.long": { name: "id" } },
                { "identity.primary": { "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });
    expect(codesOf(errors)).not.toContain("ERR_RESERVED_ATTR");
  });

  test("ordinary @objectRef on field.object → no ERR_RESERVED_ATTR", async () => {
    const { errors } = await loadDoc({
      "metadata.root": {
        package: "acme",
        children: [
          {
            "object.entity": {
              name: "X",
              children: [
                { "field.long": { name: "id" } },
                {
                  "field.object": {
                    name: "rel",
                    "@objectRef": "Y",
                  },
                },
                { "identity.primary": { "@fields": "id" } },
              ],
            },
          },
          {
            "object.entity": {
              name: "Y",
              children: [
                { "field.long": { name: "id" } },
                { "identity.primary": { "@fields": "id" } },
              ],
            },
          },
        ],
      },
    });
    expect(codesOf(errors)).not.toContain("ERR_RESERVED_ATTR");
  });
});
