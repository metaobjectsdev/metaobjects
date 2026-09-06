// The entity descriptor carries metadata, and the API base URL is not metadata.
//
// `$apiPrefix` used to be stamped into every generated `<Entity>` const from
// `config.apiPrefix`, and 21 sites across the TanStack and Angular templates read it
// back to build a URL. The prefix has zero occurrences in `expected-registry.json` and
// none in any `spec/metamodel/*.json` — it is an application setting, and where the
// browser sends a request is a DEPLOYMENT fact that codegen was freezing at `meta gen`
// time. It now lives on the client provider as `baseUrl`.
//
// This test pins the removal at the emitter rather than in a golden, because a golden
// records what the tool did and this records what it must not do again.

import { describe, test, expect } from "bun:test";
import type { MetaObject } from "@metaobjectsdev/metadata";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { renderEntityConstants } from "../src/templates/entity-constants.js";
import { renderEntityMetaFile } from "../src/templates/entity-meta-file.js";

const MODEL = {
  "metadata.root": {
    package: "acme",
    children: [
      {
        "object.entity": {
          name: "Customer",
          children: [
            { "source.rdb": { "@kind": "table", "@table": "customers" } },
            { "field.long": { name: "id", "@required": true } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
            { "field.string": { name: "email" } },
          ],
        },
      },
    ],
  },
};

async function loadCustomer(): Promise<MetaObject> {
  const result = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify(MODEL)),
  ]);
  if (result.errors.length > 0) {
    throw new Error(result.errors.map((e) => e.message).join("\n"));
  }
  return result.root.objects()[0]!;
}

describe("the entity descriptor carries no API prefix", () => {
  test("$apiPrefix is absent even when a prefix is passed", async () => {
    const customer = await loadCustomer();
    // The parameter is still ACCEPTED — ADR-0034 ejected copies call this positionally
    // — and passing a real prefix is the case that would regress, so pass one.
    expect(renderEntityConstants(customer, "/api").toString()).not.toContain("$apiPrefix");
  });

  test("the metadata-derived members are still there", async () => {
    const customer = await loadCustomer();
    const out = renderEntityConstants(customer, "/api").toString();
    // A green "no $apiPrefix" would also be produced by emitting nothing at all, so
    // assert the members that MUST survive alongside it.
    expect(out).toContain("$entity");
    expect(out).toContain("$table");
    expect(out).toContain("$path");
  });

  test("the browser-safe descriptor module drops it too", async () => {
    const customer = await loadCustomer();
    // `<Entity>.meta.ts` is what the UI files actually import, so removing the prefix
    // from the entity module alone would leave every hook still able to read it.
    const out = renderEntityMetaFile(customer, "/api");
    expect(out).not.toContain("$apiPrefix");
    expect(out).toContain("$path");
  });
});
