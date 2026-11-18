import { describe, expect, test } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";

function doc(pkg: string, name: string, extendsRef?: string): InMemoryStringSource {
  return new InMemoryStringSource(
    JSON.stringify({
      "metadata.root": {
        package: pkg,
        children: [{ "object.value": { name, ...(extendsRef !== undefined ? { extends: extendsRef } : {}) } }],
      },
    }),
    { id: `meta.${pkg.replace(/::/g, ".")}.${name}.json`, format: "json" },
  );
}

describe("ERR_UNRESOLVED_SUPER names the fix", () => {
  test("a bare cross-package extends lists the candidate and the qualified spelling", async () => {
    const res = await new MetaDataLoader().load([doc("app::a", "Base"), doc("app::b", "Widget", "Base")]);
    const err = res.errors.find((e) => (e as { code?: string }).code === "ERR_UNRESOLVED_SUPER");
    expect(err).toBeDefined();
    expect(err!.message).toContain("app::a::Base");
    expect(err!.message).toContain('extends: "app::a::Base"');
  });

  test("no same-named object anywhere: no hint", async () => {
    const res = await new MetaDataLoader().load([doc("app::b", "Widget", "Nope")]);
    const err = res.errors.find((e) => (e as { code?: string }).code === "ERR_UNRESOLVED_SUPER");
    expect(err!.message).not.toContain("exists in");
  });
});

// rc.21 (U1): a projection over a TPH root anchors its identity on the root's identity, which the
// root inherits from an abstract base in another package. The identity is unnamed, so it is named
// "primary": `Shipment.primary` resolves through the inherited member, and `Shipment.id`
// (the identity spelled by its field) names the members it could have meant.
describe("a dotted extends onto an inherited identity", () => {
  const common = JSON.stringify({ "metadata.root": { package: "acme::common", children: [
    { "object.entity": { name: "BaseEntity", abstract: true, children: [
      { "field.int": { name: "id" } },
      { "identity.primary": { "@fields": "id", "@generation": "increment" } } ] } } ] } });
  const auth = (target: string) => JSON.stringify({ "metadata.root": { package: "acme::shipping", children: [
    { "object.entity": { name: "Shipment", extends: "acme::common::BaseEntity", "@discriminator": "kind", children: [
      { "source.rdb": { "@table": "shipments" } },
      { "field.string": { name: "kind" } } ] } },
    { "object.entity": { name: "AirShipment", extends: "Shipment", "@discriminatorValue": "Air", children: [
      { "field.string": { name: "key" } } ] } },
    { "object.projection": { name: "ShipmentView", children: [
      { "source.rdb": { "@kind": "view", "@view": "v_shipments" } },
      { "field.int": { name: "id", extends: "Shipment.id" } },
      { "field.string": { name: "key", extends: "AirShipment.key" } },
      { "identity.primary": { extends: target } } ] } } ] } });
  const load = (target: string) => new MetaDataLoader({ strict: true }).load([
    new InMemoryStringSource(common, { id: "common.json", format: "json" }),
    new InMemoryStringSource(auth(target), { id: "auth.json", format: "json" }),
  ]);

  test("resolves through the member the owner inherits", async () => {
    expect((await load("Shipment.primary")).errors).toEqual([]);
  });

  test("a missing member lists the owner's members, not a package qualification", async () => {
    const err = (await load("Shipment.id")).errors.find((e) => (e as { code?: string }).code === "ERR_UNRESOLVED_SUPER");
    expect(err!.message).toContain(`'acme::shipping::Shipment' has no identity named "id"; its identity children are: "primary" (identity.primary).`);
    expect(err!.message).toContain(`An identity.primary declared without a name is named "primary".`);
    expect(err!.message).not.toContain("Qualify it with its package");
  });
});
