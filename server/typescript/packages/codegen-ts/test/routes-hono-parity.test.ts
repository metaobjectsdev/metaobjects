// The Hono routes generator must not disagree with the Fastify one about WHICH
// entities it serves, or about how a write-through entity is read.
//
// Two defects, one shape — the Hono adapter kept getting features Fastify already
// had, and nothing compared them:
//
//  1. TPH subtypes. Fastify excludes them and dispatches to a discriminator-aware
//     renderer. Hono's filter had no TPH clause, so it mounted VANILLA CRUD on a
//     subtype — which shares its base's table. The list returned every subtype's
//     rows; get/patch/delete by id operated on rows belonging to other subtypes.
//     Silently wrong data.
//  2. Write-through read view (#214). Fastify passes `readView` so reads carry the
//     derived origin.* columns. Hono did not, so every GET omitted fields the
//     generated type and Zod schema promise — and a filter or sort on one, both
//     ALLOWED by the generated allowlists, queried a column the table does not have.
//
// The durable assertion is the FIRST test: the two generators must agree on their
// entity set. That is what makes the next divergence fail on arrival, whatever it is.
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, type MetaObject } from "@metaobjectsdev/metadata";
import { routesFile } from "../src/generators/routes-file.js";
import { routesFileHono } from "../src/generators/routes-file-hono.js";
import { renderRoutesFileHono } from "../src/templates/routes-file-hono.js";
import { makeRenderContext } from "../src/render-context.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";

const META = JSON.stringify({
  "metadata.root": {
    package: "acme",
    children: [
      // TPH base + two subtypes.
      { "object.entity": { name: "Auth", "@discriminator": "type", children: [
        { "source.rdb": { "@table": "auths" } },
        { "field.enum": { name: "type", "@values": ["Bridge", "Copay"] } },
        { "field.long": { name: "id" } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
      ] } },
      { "object.entity": { name: "BridgeAuth", extends: "Auth", "@discriminatorValue": "Bridge",
        children: [{ "field.int": { name: "quantity" } }] } },
      // Write-through: writable table + replica view + a derived passthrough field.
      { "object.entity": { name: "Customer", children: [
        { "source.rdb": { "@table": "customers" } },
        { "field.long": { name: "id" } },
        { "field.string": { name: "name" } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
      ] } },
      { "object.entity": { name: "Order", children: [
        { "source.rdb": { "@role": "primary", "@table": "orders" } },
        { "source.rdb": { "@role": "replica", "@kind": "view", "@table": "v_order_with_customer" } },
        { "field.long": { name: "id" } },
        { "field.long": { name: "customerId", "@required": true } },
        { "field.string": { name: "customerName", "@filterable": true, children: [
          { "origin.passthrough": { "@from": "Customer.name", "@via": "Order.customer" } } ] } },
        { "relationship.association": { name: "customer", "@objectRef": "Customer", "@cardinality": "one" } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
        { "identity.reference": { name: "ref_customer", "@fields": "customerId", "@references": "Customer" } },
      ] } },
    ],
  },
});

async function load() {
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(META)]);
  expect(errors).toEqual([]);
  return root;
}

describe("Hono routes generator — parity with Fastify", () => {
  test("both generators serve exactly the same entity set", async () => {
    const root = await load();
    const fastify = routesFile(), hono = routesFileHono();
    const served = (g: { filter?: (e: MetaObject) => boolean }) =>
      root.objects().filter((o) => g.filter?.(o) ?? true).map((o) => o.name).sort();
    expect(served(hono)).toEqual(served(fastify));
  });

  test("a TPH subtype gets NO Hono routes, and the run says why", async () => {
    const root = await load();
    const hono = routesFileHono();
    const bridge = root.objects().find((o) => o.name === "BridgeAuth")!;
    expect(hono.filter!(bridge)).toBe(false);
    // The base still serves — only the per-subtype artifact is withheld.
    expect(hono.filter!(root.objects().find((o) => o.name === "Auth")!)).toBe(true);

    const warnings: string[] = [];
    await hono.generate({
      entities: root.objects(), loadedRoot: root,
      matches: (e) => hono.filter?.(e) ?? true,
      config: { outDir: "/tmp/x", extStyle: "none", dbImport: "./db", dialect: "sqlite" },
      renderContext: makeRenderContext({
        dialect: "sqlite", loadedRoot: root, outDir: "/tmp/x", dbImport: "./db",
        pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
      }),
      warn: (m) => warnings.push(m),
    });
    const note = warnings.join("\n");
    expect(note).toContain("BridgeAuth");
    expect(note).toContain("discriminator");
    // Actionable: names the generator that DOES handle TPH.
    expect(note).toContain("routesFile()");
  });

  test("a write-through entity reads through its replica view", async () => {
    const root = await load();
    const ctx = makeRenderContext({
      dialect: "postgres", loadedRoot: root, outDir: "/tmp/x", dbImport: "./db",
      pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
    });
    const out = renderRoutesFileHono(root.objects().find((o) => o.name === "Order")!, ctx);
    expect(out).toContain("readView: orderView");
    expect(out).toMatch(/import \{[\s\S]*orderView[\s\S]*\} from/);
  });

  test("a vanilla entity passes NO readView — output is unchanged for it", async () => {
    const root = await load();
    const ctx = makeRenderContext({
      dialect: "postgres", loadedRoot: root, outDir: "/tmp/x", dbImport: "./db",
      pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
    });
    const out = renderRoutesFileHono(root.objects().find((o) => o.name === "Customer")!, ctx);
    expect(out).not.toContain("readView");
  });
});
