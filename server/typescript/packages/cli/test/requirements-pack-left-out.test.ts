// The requirements vocabulary is its own pack (`metaobjects-requirements`), composed by
// default. The verify gate's ledger reads requirement nodes the pack registered, so with
// the pack left out of an embedder's registry the gate has nothing to read and reports
// nothing, and a model that declares a requirement fails to load instead.
import { describe, test, expect } from "bun:test";
import {
  MetaDataLoader,
  InMemoryStringSource,
  composeRegistry,
  coreProviders,
  REQUIREMENTS_PROVIDER_ID,
} from "@metaobjectsdev/metadata";
import { checkRequirements, scanRequirements, summariseRequirements } from "../src/lib/requirement-check.js";

const ORDER = {
  "object.entity": {
    name: "Order",
    children: [
      { "source.rdb": { "@table": "orders" } },
      { "field.long": { name: "id" } },
      { "identity.primary": { name: "pk", "@fields": ["id"] } },
    ],
  },
};
const REQUIREMENT = {
  "requirement.functional": {
    name: "PlaceOrder",
    "@level": 4,
    "@status": "live",
    "@statement": "A customer places an order",
    "@counterexample": "A customer cannot place an order",
    "@implementedBy": ["app::Order"],
  },
};

function model(children: unknown[]): string {
  return JSON.stringify({ "metadata.root": { package: "app", children } });
}

const withoutPack = () => composeRegistry(coreProviders.filter((p) => p.id !== REQUIREMENTS_PROVIDER_ID));

describe("requirements pack left out", () => {
  test("a model with no requirements loads and the gate reports nothing", async () => {
    const result = await new MetaDataLoader({ registry: withoutPack(), strict: true }).load([
      new InMemoryStringSource(model([ORDER]), { format: "json" }),
    ]);
    expect(result.errors).toEqual([]);
    const scan = scanRequirements(result.root);
    expect(checkRequirements(result.root, scan)).toEqual([]);
    expect(summariseRequirements(result.root, scan)).toBeUndefined();
  });

  test("a model that declares a requirement fails to load with ERR_UNKNOWN_TYPE", async () => {
    const result = await new MetaDataLoader({ registry: withoutPack(), strict: true }).load([
      new InMemoryStringSource(model([ORDER, REQUIREMENT]), { format: "json" }),
    ]);
    expect(result.errors.map((e) => (e as { code?: string }).code)).toEqual(["ERR_UNKNOWN_TYPE"]);
  });

  test("with the default bundle the same requirement reaches the ledger", async () => {
    const result = await new MetaDataLoader({ registry: composeRegistry(coreProviders), strict: true }).load([
      new InMemoryStringSource(model([ORDER, REQUIREMENT]), { format: "json" }),
    ]);
    expect(result.errors).toEqual([]);
    expect(summariseRequirements(result.root, scanRequirements(result.root))?.total).toBe(1);
  });
});
