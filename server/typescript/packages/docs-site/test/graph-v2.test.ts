import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadModel } from "../src/load";
import { LinkGraph } from "../src/link-graph";

const DIRS = [join(import.meta.dir, "fixture/input/acme")];

test("graph exposes relationship edges, origin provenance, and transitive ancestors", async () => {
  const g = new LinkGraph(await loadModel(DIRS));
  // relationship.association on Order → Customer (added to fixture in Task 12)
  const rels = g.relationshipsOf("acme::shop::Order");
  expect(rels.some((r) => r.cardinality === "one" && r.toFqn === "acme::shop::Customer")).toBe(true);
  // relationship edge is queryable as a ref kind
  expect(g.refsFrom("acme::shop::Order").some((r) => r.kind === "relationship")).toBe(true);
  // origin.passthrough on a projection object (fixture LineItemView)
  const origins = g.originsOf("acme::shop::LineItemView");
  expect(origins.some((o) => o.field === "customerName" && o.via.length > 0)).toBe(true);
  // transitive ancestors: Order extends BaseEntity (fixture) — chain non-empty and resolvable
  const anc = g.ancestors("acme::shop::Order");
  expect(anc.map((n) => n.name)).toContain("BaseEntity");
});
