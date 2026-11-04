// `buildExplorer` — the explorer data spine — over the committed conformance fixture
// (`fixtures/explorer-conformance/shop/`), checked byte for byte, plus the behaviour a
// byte check alone would not explain when it breaks.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildExplorer, serializeExplorer, type ExplorerJson } from "../src/index.js";

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

  test("is deterministic: the same inputs give the same bytes", () => {
    expect(serializeExplorer(build())).toBe(serializeExplorer(build()));
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

  test("rejects two top-level nodes sharing an id", () => {
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
});
