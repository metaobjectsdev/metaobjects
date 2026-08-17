// resolveClaim — shared resolution of an `@implementedBy` reference to the node it
// names. Extracted from the CLI's requirement-check so codegen can share ONE resolver:
// a second implementation would fork the ADR-0042 package-local binding contract.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, resolveClaim } from "../src/index.js";
import type { MetaData } from "../src/index.js";

const MODEL = {
  "metadata.root": {
    package: "acme::probe",
    children: [
      {
        "object.entity": {
          name: "Council",
          children: [
            { "field.long": { name: "id" } },
            {
              "field.string": {
                name: "slug",
                children: [{ "view.text": { name: "display" } }],
              },
            },
            { "source.rdb": { "@table": "councils" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
    ],
  },
};

async function load(): Promise<MetaData> {
  const r = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify(MODEL)),
  ]);
  if (r.errors.length > 0) {
    throw new Error(`Loader errors:\n${r.errors.map((e) => e.message).join("\n")}`);
  }
  return r.root;
}

describe("resolveClaim", () => {
  test("resolves a top-level object by bare name", async () => {
    const root = await load();
    const n = resolveClaim(root, "Council", "acme::probe");
    expect(n?.name).toBe("Council");
    expect(n?.type).toBe("object");
  });

  test("resolves one dotted member segment to the FIELD node", async () => {
    const root = await load();
    const n = resolveClaim(root, "Council.slug", "acme::probe");
    expect(n?.name).toBe("slug");
    expect(n?.type).toBe("field");
  });

  test("resolves a nested member segment to the VIEW node", async () => {
    // Depth matters: the fan-out keys on the resolved node's type, so a resolver
    // that stopped at the field would collapse two concerns into one.
    const root = await load();
    const n = resolveClaim(root, "Council.slug.display", "acme::probe");
    expect(n?.name).toBe("display");
    expect(n?.type).toBe("view");
  });

  test("returns undefined for an unresolvable member", async () => {
    const root = await load();
    expect(resolveClaim(root, "Council.nope", "acme::probe")).toBeUndefined();
  });

  test("returns undefined for an unresolvable owner", async () => {
    const root = await load();
    expect(resolveClaim(root, "Ghost", "acme::probe")).toBeUndefined();
  });
});
