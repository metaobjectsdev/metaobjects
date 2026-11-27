// The docs view corpus (`fixtures/explorer-conformance/`, `docs/features/docs-view.md`): each
// fixture's project is loaded, its committed optional inputs are read, and `buildDocsView`
// must reproduce the fixture's `expected.json` byte for byte. Every port that builds the docs
// view is held to the same files.
//
// A fixture may carry `provider.json`, a data-driven provider definition for vocabulary the
// core does not register. A provider attribute comes out linked when the loader resolves it as
// a reference (such as `@objectRef`), with no change to the builder: the view reads the
// loader's resolution, never a list of attribute names of its own.
//
// Regenerate after a deliberate change: `UPDATE_DOCS_VIEW=1 bun test test/docs-view-conformance.test.ts`.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  InMemoryStringSource,
  MetaData,
  MetaDataLoader,
  applyProviderDefinition,
  buildDocsView,
  composeRegistry,
  coreProviders,
  serializeDocsView,
  type DocsView,
  type FactoryMap,
  type MetaDataTypeProvider,
  type ProviderDefinition,
} from "../src/index.js";

/** A node of a type the fixture's provider.json declares: no behaviour beyond MetaData's own. */
class FixtureNode extends MetaData {}

const CORPUS = resolve(import.meta.dir, "../../../../../fixtures/explorer-conformance");
const UPDATE = process.env.UPDATE_DOCS_VIEW === "1";

const fixtures = readdirSync(CORPUS, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

function readJson(dir: string, name: string): unknown {
  const p = join(dir, name);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as unknown) : undefined;
}

/** A provider for a fixture's `provider.json`: every type it declares is a plain node. */
export function fixtureProvider(def: ProviderDefinition): MetaDataTypeProvider {
  const factories: FactoryMap = {};
  for (const t of def.types ?? []) factories[`${t.type}.${t.subType}`] = (id, name) => new FixtureNode(id, name);
  return {
    id: def.provider,
    dependencies: ["metaobjects-core-types"],
    registerTypes: (registry) => applyProviderDefinition(registry, def, factories),
  };
}

async function viewOf(name: string): Promise<DocsView> {
  const dir = join(CORPUS, name);
  const def = readJson(dir, "provider.json") as ProviderDefinition | undefined;
  const registry = composeRegistry(def !== undefined ? [...coreProviders, fixtureProvider(def)] : coreProviders);
  const loaded = await MetaDataLoader.fromDirectory(join(dir, "project", "metaobjects"), { strict: true, registry });
  expect(loaded.errors.map(String)).toEqual([]);
  const verify = readJson(dir, "verify.json");
  const manifest = readJson(dir, "hashes.json");
  const routes = readJson(dir, "routes.json");
  return buildDocsView({
    root: loaded.root,
    ...(verify !== undefined ? { verify } : {}),
    ...(manifest !== undefined ? { manifest } : {}),
    ...(routes !== undefined ? { routes } : {}),
  });
}

describe("docs view corpus", () => {
  test("the corpus holds the fixtures the README describes", () => {
    expect(fixtures).toEqual(["crm", "shop"]);
  });

  for (const name of fixtures) {
    test(`${name}: buildDocsView reproduces expected.json`, async () => {
      const actual = serializeDocsView(await viewOf(name));
      const file = join(CORPUS, name, "expected.json");
      if (UPDATE) writeFileSync(file, actual);
      expect(actual).toBe(readFileSync(file, "utf8"));
    });
  }
});

describe("buildDocsView over the corpus", () => {
  test("ids, pages and inheritance come from the loaded model", async () => {
    const v = await viewOf("shop");
    const customer = v.nodes.find((n) => n.id === "acme::shop::Customer")!;
    expect(customer.path).toBe("model/acme/shop/Customer.html");
    expect(customer.extends?.id).toBe("acme::shop::BaseEntity");
    const members = customer.memberGroups.flatMap((g) => g.members);
    // An inherited member keeps its place on the subtype and names where it is declared.
    const id = members.find((m) => m.name === "id")!;
    expect(id.declaredOn?.id).toBe("acme::shop::BaseEntity");
    expect(id.path).toBe("model/acme/shop/Customer.html#m-id");
    expect(members.find((m) => m.name === "name")!.declaredOn).toBeNull();
    // Of a field and an identity both named `id`, the field keeps the plain id.
    const audit = v.nodes.find((n) => n.id === "acme::shop::AuditEntry")!;
    expect(audit.memberGroups.flatMap((g) => g.members).map((m) => m.id)).toContain("acme::shop::AuditEntry.id[identity.primary]");
    expect(audit.unclaimed).toBe(true);
  });

  test("references and their reverse come from the loader's resolution", async () => {
    const v = await viewOf("shop");
    const order = v.nodes.find((n) => n.id === "acme::shop::Order")!;
    expect(order.refs.map((r) => [r.attr, r.via?.id ?? null, r.target.id])).toEqual([
      ["extends", null, "acme::shop::BaseEntity"],
      ["references", "acme::shop::Order.customerRef", "acme::shop::Customer"],
    ]);
    const customer = v.nodes.find((n) => n.id === "acme::shop::Customer")!;
    expect(customer.referencedBy.map((r) => [r.attr, r.from.id])).toEqual([["references", "acme::shop::Order"]]);
  });

  test("requirements are flat, in document order, with depth, claims and roll-up", async () => {
    const v = await viewOf("shop");
    expect(v.requirements.map((r) => [r.address, r.depth])).toEqual([
      ["Addressable", 0],
      ["Shop", 0],
      ["Shop.Checkout", 1],
      ["Shop.Checkout.Orders", 2],
      ["Shop.Checkout.Orders.Recorded", 3],
      ["Shop.Checkout.Orders.Recorded.Quotable", 4],
      ["Shop.Checkout.Orders.Noted", 3],
      ["Shop.Checkout.Orders.Refunded", 3],
      ["Shop.Checkout.Shipping", 2],
    ]);
    const refunded = v.requirements.find((r) => r.address === "Shop.Checkout.Orders.Refunded")!;
    expect(refunded.implementedBy).toEqual([{ ref: "Refund", resolves: false, target: { label: "Refund", id: "", path: "", kind: "", unresolved: true } }]);
    const quotable = v.requirements.find((r) => r.address === "Shop.Checkout.Orders.Recorded.Quotable")!;
    expect(quotable.implementedBy[0]!.target.path).toBe("model/acme/shop/Order.html#m-reference");
    const order = v.nodes.find((n) => n.id === "acme::shop::Order")!;
    const reference = order.memberGroups.flatMap((g) => g.members).find((m) => m.name === "reference")!;
    expect(reference.claims.map((c) => c.requirement.id)).toEqual(["acme::shop::Shop.Checkout.Orders.Recorded.Quotable"]);
    const shop = v.requirements.find((r) => r.address === "Shop")!;
    expect(shop.rollup.filter((s) => s.count > 0)).toEqual([{ status: "planned", count: 1 }, { status: "live", count: 3 }]);
  });

  test("custom vocabulary: members and references appear with no docs code for them", async () => {
    const v = await viewOf("crm");
    const page = v.nodes.find((n) => n.id === "acme::crm::Lead[page.list]")!;
    expect(page.path).toBe("model/acme/crm/Lead.page-list.html");
    expect(page.memberGroups.map((g) => [g.type, g.count])).toEqual([["block", 2]]);
    expect(page.refs.map((r) => [r.attr, r.via?.id ?? null, r.target.id])).toEqual([
      ["objectRef", null, "acme::crm::Lead"],
      ["objectRef", "acme::crm::Lead[page.list].leads", "acme::crm::Lead"],
      ["objectRef", "acme::crm::Lead[page.list].accounts", "acme::crm::Account"],
    ]);
    // An attribute the provider declares but the loader does not resolve stays text.
    const columns = page.memberGroups[0]!.members[0]!.attrs.find((a) => a.name === "columns")!;
    expect(columns.values.map((x) => [x.text, x.link])).toEqual([["email", null], ["accountId", null]]);
    const account = v.nodes.find((n) => n.id === "acme::crm::Account")!;
    expect(account.referencedBy.map((r) => [r.attr, r.from.id])).toEqual([
      ["references", "acme::crm::Lead"],
      ["objectRef", "acme::crm::Lead[page.list]"],
    ]);
    const tax = v.nodes.find((n) => n.id === "acme::tax::tax")!;
    expect(tax.claims.map((c) => c.requirement.id)).toEqual(["acme::crm::Crm.Leads"]);
  });

  test("without the optional inputs their parts are empty and say so", async () => {
    const dir = join(CORPUS, "shop");
    const loaded = await MetaDataLoader.fromDirectory(join(dir, "project", "metaobjects"), { strict: true });
    const v = buildDocsView({ root: loaded.root });
    expect(v.sources).toEqual({ requirements: false, files: false, routes: false });
    expect(v.advisories).toEqual([]);
    expect(v.requirements.every((r) => !r.inLedger && r.verdict === "")).toBe(true);
    expect(v.nodes.every((n) => n.files.length === 0 && n.routes.length === 0)).toBe(true);
    // Claims are the model's own, so they hold without the gate's payload.
    expect(v.counts.claims).toBe(5);
  });

  test("a map attribute's keys are in code-unit order, whatever order they were declared in", async () => {
    const model = {
      "metadata.root": {
        package: "p",
        children: [{ "object.entity": { name: "Doc", children: [
          { "field.enum": { name: "state", "@values": ["DRAFT", "PUBLISHED", "ARCHIVED"], "@intValueMap": { DRAFT: 0, PUBLISHED: 5, ARCHIVED: 9 } } },
        ] } }],
      },
    };
    const loaded = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(model))]);
    expect(loaded.errors.map(String)).toEqual([]);
    const state = buildDocsView({ root: loaded.root }).nodes[0]!.memberGroups[0]!.members[0]!;
    const map = state.attrs.find((a) => a.name === "intValueMap")!;
    expect(JSON.stringify(map.value)).toBe(`{"ARCHIVED":9,"DRAFT":0,"PUBLISHED":5}`);
    expect(map.values[0]!.text).toBe(`{"ARCHIVED":9,"DRAFT":0,"PUBLISHED":5}`);
    // A list keeps its order: it is the declaration.
    expect(state.attrs.find((a) => a.name === "values")!.values.map((v) => v.text)).toEqual(["DRAFT", "PUBLISHED", "ARCHIVED"]);
  });

  test("a node named like an entity and declared before it leaves the entity its claims, files, routes and findings", async () => {
    const req = { "@level": 1, "@status": "live", "@statement": "s", "@counterexample": "c" };
    const model = {
      "metadata.root": {
        package: "acme::shop",
        children: [
          { "requirement.functional": { name: "Order", ...req, "@implementedBy": ["Order", "Order.email"], children: [
            { "requirement.functional": { name: "email", ...req } },
          ] } },
          { "object.entity": { name: "Order", children: [{ "field.string": { name: "email" } }] } },
        ],
      },
    };
    const loaded = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(model))]);
    expect(loaded.errors.map(String)).toEqual([]);
    const finding = { code: "WARN_REQUIREMENT_OBJECT_UNCLAIMED", node: "acme::shop::Order", path: "", severity: "warn", source: "", message: "" };
    const v = buildDocsView({
      root: loaded.root,
      verify: { requirementLedger: [], requirements: { rows: [finding] } },
      manifest: { "src/Order.ts": { generatedBy: "entity", sourceNode: "acme::shop::Order" } },
      routes: [{ node: "acme::shop::Order", method: "get", path: "/orders" }],
    });
    const entity = v.nodes.find((n) => n.id === "acme::shop::Order")!;
    expect(entity.type).toBe("object");
    expect(entity.claims.map((c) => c.member)).toEqual(["", "email"]);
    expect(entity.memberGroups[0]!.members[0]!.claims.map((c) => c.member)).toEqual(["email"]);
    expect(entity.files).toEqual([{ generatedBy: "entity", paths: ["src/Order.ts"] }]);
    expect(entity.routes).toEqual([{ method: "GET", path: "/orders" }]);
    expect(entity.unclaimed).toBe(true);
    const named = v.nodes.find((n) => n.id === "acme::shop::Order[requirement.functional]")!;
    expect([named.claims, named.files, named.routes, named.unclaimed]).toEqual([[], [], [], false]);
    expect(v.requirements[0]!.implementedBy.map((l) => l.target.path)).toEqual(["model/acme/shop/Order.html", "model/acme/shop/Order.html#m-email"]);
    expect(v.advisories[0]!.subject?.id).toBe("acme::shop::Order");
  });

  test("a reference and a claim naming an inherited member land on the owner's row; extends names the declarer", async () => {
    const model = {
      "metadata.root": {
        package: "acme::shop",
        children: [
          { "requirement.functional": { name: "Totals", "@level": 4, "@status": "live", "@statement": "s", "@counterexample": "c", "@implementedBy": ["Order.total"] } },
          { "object.entity": { name: "Base", abstract: true, children: [
            { "field.long": { name: "id" } },
            { "field.long": { name: "total" } },
            { "identity.primary": { name: "pk", "@fields": "id" } },
          ] } },
          { "object.entity": { name: "Order", extends: "Base", children: [] } },
          { "object.entity": { name: "Customer", children: [
            { "field.long": { name: "id" } },
            { "relationship.association": { name: "orders", "@objectRef": "Order", "@cardinality": "many" } },
            { "identity.primary": { name: "pk", "@fields": "id" } },
          ] } },
          { "object.value": { name: "Params", children: [{ "field.long": { name: "customerId" } }] } },
          { "object.projection": { name: "CustomerTotals", children: [
            { "source.rdb": { "@kind": "storedProc", "@storedProc": "p_totals", "@parameterRef": "Params" } },
            { "field.long": { name: "sum", children: [
              { "origin.aggregate": { "@agg": "sum", "@of": "Order.total", "@via": "Customer.orders" } },
            ] } },
          ] } },
        ],
      },
    };
    const loaded = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(model))]);
    expect(loaded.errors.map(String)).toEqual([]);
    const v = buildDocsView({ root: loaded.root });
    const totals = v.nodes.find((n) => n.id === "acme::shop::CustomerTotals")!;
    const of = totals.refs.find((r) => r.attr === "of")!;
    expect([of.target.id, of.target.path, of.target.label]).toEqual(["acme::shop::Order.total", "model/acme/shop/Order.html#m-total", "Order.total"]);
    expect(v.requirements[0]!.implementedBy[0]!.target.path).toBe("model/acme/shop/Order.html#m-total");
    const total = v.nodes.find((n) => n.id === "acme::shop::Order")!.memberGroups.flatMap((g) => g.members).find((m) => m.name === "total")!;
    expect(total.declaredOn?.path).toBe("model/acme/shop/Base.html");
    // A member with no name keeps its index in its label, as in its id.
    const source = totals.refs.find((r) => r.attr === "parameterRef")!;
    expect([source.via?.id, source.via?.label]).toEqual(["acme::shop::CustomerTotals#0", "CustomerTotals#0"]);
  });

  test("the same inputs give the same bytes", async () => {
    expect(serializeDocsView(await viewOf("shop"))).toBe(serializeDocsView(await viewOf("shop")));
  });
});
