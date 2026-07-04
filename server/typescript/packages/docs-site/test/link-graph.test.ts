import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadModel } from "../src/load";
import { LinkGraph } from "../src/link-graph";

const FIX = join(import.meta.dir, "fixture/input");

test("builds nodes, refs, backlinks, degree, hrefs", async () => {
  const model = await loadModel([join(FIX, "acme")]);
  const g = new LinkGraph(model);
  const order = g.byFqn("acme::shop::Order")!;
  expect(order.href).toBe("acme/shop/Order.html");
  // FK ref Order -> Customer via customerId
  expect(g.refsFrom("acme::shop::Order").some((r) => r.to === "acme::shop::Customer" && r.kind === "fk")).toBe(true);
  // payload ref: prompt npcReview -> NpcPayload; nested objectRef NpcPayload -> ItemView
  expect(g.refsFrom("acme::ai::npcReview").some((r) => r.to === "acme::ai::NpcPayload" && r.kind === "payload")).toBe(true);
  expect(g.refsFrom("acme::ai::NpcPayload").some((r) => r.to === "acme::ai::ItemView" && r.kind === "field")).toBe(true);
  // backlink + degree: 3 refs (Order fk + Order relationship + LineItemView origin-passthrough)
  expect(g.refsTo("acme::shop::Customer").length).toBe(3);
  expect(g.degree("acme::shop::Customer")).toBe(3);
  // extends
  expect(g.extendedBy("acme::common::BaseEntity").map((n) => n.name).sort()).toEqual(["Customer", "Order"]);
  // relative href
  expect(g.relHref("acme/shop/Order.html", "acme/ai/NpcPayload.html")).toBe("../ai/NpcPayload.html");
  expect(g.relHref("index.html", "acme/shop/Order.html")).toBe("acme/shop/Order.html");
});
