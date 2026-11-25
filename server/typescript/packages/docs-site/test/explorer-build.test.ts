// `buildExplorer` — the explorer data spine — over the committed conformance fixture
// (`fixtures/explorer-conformance/shop/`), checked byte for byte, plus the behaviour a
// byte check alone would not explain when it breaks.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildExplorer, serializeExplorer, type ExplorerJson } from "../src/index.js";
import { CUSTOM_VOCABULARY_MODEL, CUSTOM_VOCABULARY_VERIFY } from "./fixture/custom-vocabulary.js";

const FIXTURE = resolve(import.meta.dir, "../../../../../fixtures/explorer-conformance/shop");
const text = (name: string): string => readFileSync(join(FIXTURE, name), "utf8");
const json = (name: string): unknown => JSON.parse(text(name));

function build(parts: { verify?: boolean; manifest?: boolean } = { verify: true, manifest: true }): ExplorerJson {
  return buildExplorer({
    model: json("effective.json"),
    ...(parts.verify ? { verify: json("verify.json") } : {}),
    ...(parts.manifest ? { manifest: json("hashes.json") } : {}),
  });
}

describe("explorer-conformance/shop", () => {
  test("builds expected.json byte for byte", () => {
    expect(serializeExplorer(build())).toBe(text("expected.json"));
  });

  test("object key order in the model and the manifest does not change the bytes", () => {
    const reversed = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(reversed)
        : typeof v === "object" && v !== null
          ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reversed(x)]))
          : v;
    const explorer = buildExplorer({
      model: reversed(json("effective.json")),
      verify: json("verify.json"),
      manifest: reversed(json("hashes.json")),
    });
    expect(serializeExplorer(explorer)).toBe(text("expected.json"));
  });
});

describe("buildExplorer", () => {
  test("marks inherited members with the object that declares them", () => {
    const nodes = new Map(build().nodes.map((n) => [n.id, n]));
    expect(nodes.get("acme::shop::Order.id")?.inheritedFrom).toBe("acme::shop::BaseEntity");
    expect(nodes.get("acme::shop::Order.total")?.inheritedFrom).toBeUndefined();
    // AuditEntry declares its own `id` and does not extend BaseEntity.
    expect(nodes.get("acme::shop::AuditEntry.id")?.inheritedFrom).toBeUndefined();
  });

  test("an implementedBy edge exists only where the verify ledger resolved the link", () => {
    const withVerify = build().edges.filter((e) => e.kind === "implementedBy");
    expect(withVerify).toContainEqual({ kind: "implementedBy", from: "acme::shop::Shop.Checkout.Orders.Recorded.Quotable", to: "acme::shop::Order.reference" });
    // `Refunded` names `Refund`, which does not exist: a ledger row, no edge.
    expect(withVerify.some((e) => e.from.endsWith("Refunded"))).toBe(false);
    expect(build({ manifest: true }).edges.some((e) => e.kind === "implementedBy")).toBe(false);
    expect(build({ manifest: true }).ledger).toBeUndefined();
  });

  test("generated groups the manifest's attributed files by node; plain entries are skipped", () => {
    expect(build().generated?.map((g) => g.node)).toEqual(["acme::shop::Customer", "acme::shop::Order"]);
    expect(build({ verify: true }).generated).toBeUndefined();
  });

  test("routes are kept per known node, sorted, deduplicated; without them there is no api", () => {
    const api = buildExplorer({
      model: json("effective.json"),
      routes: [
        { node: "acme::shop::Order", method: "post", path: "/api/orders" },
        { node: "acme::shop::Order", method: "GET", path: "/api/orders" },
        { node: "acme::shop::Order", method: "GET", path: "/api/orders" },
        { node: "acme::shop::Customer", method: "GET", path: "/api/customers/{id}" },
        { node: "acme::shop::Gone", method: "GET", path: "/api/gone" },
        { node: "acme::shop::Order", path: "/api/no-method" },
      ],
    }).api;
    expect(api).toEqual([
      { node: "acme::shop::Customer", method: "GET", path: "/api/customers/{id}" },
      { node: "acme::shop::Order", method: "GET", path: "/api/orders" },
      { node: "acme::shop::Order", method: "POST", path: "/api/orders" },
    ]);
    expect(build().api).toBeUndefined();
  });

  test("a requirement slice holds the subtree, its targets and the owner of a claimed member", () => {
    const slice = build().slices.find((s) => s.id === "requirement:acme::shop::Shop.Checkout.Orders.Recorded");
    expect(slice?.nodes).toEqual([
      "acme::shop::Customer",
      "acme::shop::Order",
      "acme::shop::Order.reference",
      "acme::shop::Shop.Checkout.Orders.Recorded",
      "acme::shop::Shop.Checkout.Orders.Recorded.Quotable",
    ]);
  });

  test("rejects input that is not canonical metadata JSON", () => {
    expect(() => buildExplorer({ model: { nodes: [] } })).toThrow(/not canonical metadata JSON/);
  });

  test("a sibling sharing a member's name gets a type-qualified id; the member keeps the plain one", () => {
    const nodes = new Map(build().nodes.map((n) => [n.id, n]));
    expect(nodes.get("acme::shop::AuditEntry.id")?.type).toBe("field");
    expect(nodes.get("acme::shop::AuditEntry.id[identity.primary]")?.type).toBe("identity");
  });

  test("a top-level node of another type sharing an object's name gets a type-qualified id; the object keeps the plain one", () => {
    // The page is declared first: the object keeps the plain id anyway, since references name objects.
    const built = buildExplorer({ model: CUSTOM_VOCABULARY_MODEL, verify: CUSTOM_VOCABULARY_VERIFY });
    const nodes = new Map(built.nodes.map((n) => [n.id, n]));
    expect(nodes.get("acme::crm::Lead")?.type).toBe("object");
    expect(nodes.get("acme::crm::Lead.email")?.type).toBe("field");
    expect(nodes.get("acme::crm::Lead[page.list]")?.type).toBe("page");
    expect(nodes.get("acme::crm::Lead[page.list].leads")?.parent).toBe("acme::crm::Lead[page.list]");
    expect(built.edges).toContainEqual({ kind: "implementedBy", from: "acme::tax::Tax", to: "acme::tax::tax" });
  });

  test("a model with no collision keeps every top-level id plain", () => {
    for (const n of build().nodes) if (n.parent === undefined) expect(n.id).not.toContain("[");
  });

  test("a requirement whose id is qualified still takes its ledger row", () => {
    const model = {
      "metadata.root": {
        package: "p",
        children: [
          { "object.entity": { name: "Billing" } },
          { "requirement.functional": { name: "Billing", "@status": "live", children: [{ "requirement.functional": { name: "Invoices", "@status": "live" } }] } },
        ],
      },
    };
    const row = (path: string): unknown => ({ path, package: "p", qualifiedPath: `p::${path}`, subType: "functional", status: "live", digest: "", implementedBy: [{ ref: "Billing", resolves: true, target: "p::Billing" }], diagnostics: [], verdict: "clean" });
    const built = buildExplorer({ model, verify: { requirementLedger: [row("Billing"), row("Billing.Invoices")] } });
    expect(built.ledger?.rows.map((r) => r.node)).toEqual(["p::Billing[requirement.functional]", "p::Billing[requirement.functional].Invoices"]);
    expect(built.edges).toContainEqual({ kind: "implementedBy", from: "p::Billing[requirement.functional]", to: "p::Billing" });
  });

  test("rejects two top-level nodes of one type sharing an id", () => {
    const model = {
      "metadata.root": {
        package: "p",
        children: [
          { "object.entity": { name: "A" } },
          { "object.value": { name: "A" } },
        ],
      },
    };
    expect(() => buildExplorer({ model })).toThrow(/two nodes share the id "p::A"/);
  });

  test("a root-level target spelled `::Name` still gets its edges and inheritedFrom", () => {
    const idField = { name: "id", type: "long" };
    const model = {
      "metadata.root": {
        children: [
          { "object.entity": { name: "BaseEntity", abstract: true, children: [{ "field.long": idField }] } },
          {
            "object.entity": {
              name: "Order",
              package: "acme::shop",
              extends: "::BaseEntity",
              children: [
                { "field.long": idField },
                { "relationship.association": { name: "owner", "@objectRef": "::BaseEntity" } },
              ],
            },
          },
        ],
      },
    };
    const built = buildExplorer({ model });
    const nodes = new Map(built.nodes.map((n) => [n.id, n]));
    expect(nodes.get("acme::shop::Order")?.extends).toBe("BaseEntity");
    expect(nodes.get("acme::shop::Order.id")?.inheritedFrom).toBe("BaseEntity");
    expect(built.edges).toContainEqual({ kind: "extends", from: "acme::shop::Order", to: "BaseEntity" });
    expect(built.edges).toContainEqual({ kind: "association", from: "acme::shop::Order", to: "BaseEntity", via: "acme::shop::Order.owner" });
  });
});
