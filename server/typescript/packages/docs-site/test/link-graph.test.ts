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
  // Order -> Customer is now the enriched relationship edge (the bare FK is de-duped away)
  expect(g.refsFrom("acme::shop::Order").some((r) => r.to === "acme::shop::Customer" && r.kind === "relationship")).toBe(true);
  expect(g.refsFrom("acme::shop::Order").some((r) => r.to === "acme::shop::Customer" && r.kind === "fk")).toBe(false);
  // payload ref: prompt npcReview -> NpcPayload; nested objectRef NpcPayload -> ItemView
  expect(g.refsFrom("acme::ai::npcReview").some((r) => r.to === "acme::ai::NpcPayload" && r.kind === "payload")).toBe(true);
  expect(g.refsFrom("acme::ai::NpcPayload").some((r) => r.to === "acme::ai::ItemView" && r.kind === "field")).toBe(true);
  // backlinks to Customer: Order.customer (relationship) + LineItemView origin-passthrough
  //   + the self-join junction FKs (CustomerReferral x2, CustomerFriend x2) + the self relationships (referrals, friends)
  expect(g.refsTo("acme::shop::Customer").some((r) => r.from === "acme::shop::Order" && r.kind === "relationship")).toBe(true);
  expect(g.refsTo("acme::shop::Customer").some((r) => r.from === "acme::shop::Order" && r.kind === "fk")).toBe(false);
  // extends (Task 1 grew the fixture: Product/OrderProduct/CustomerReferral/CustomerFriend also extend BaseEntity)
  expect(g.extendedBy("acme::common::BaseEntity").map((n) => n.name).sort()).toEqual(["Customer", "CustomerFriend", "CustomerReferral", "Order", "OrderProduct", "Product"]);
  // relative href
  expect(g.relHref("acme/shop/Order.html", "acme/ai/NpcPayload.html")).toBe("../ai/NpcPayload.html");
  expect(g.relHref("index.html", "acme/shop/Order.html")).toBe("acme/shop/Order.html");
});

test("phase-2 fixture loads the M:N + self-join entities", async () => {
  const model = await loadModel([join(FIX, "acme")]);
  const g = new LinkGraph(model);
  for (const fqn of ["acme::shop::Product", "acme::shop::OrderProduct", "acme::shop::CustomerReferral", "acme::shop::CustomerFriend"]) {
    expect(g.byFqn(fqn), fqn).toBeDefined();
  }
});

test("belongs-to relationship edge carries cardinality/onDelete/subtype and supersedes the bare FK", async () => {
  const model = await loadModel([join(FIX, "acme")]);
  const g = new LinkGraph(model);
  const toCustomer = g.refsFrom("acme::shop::Order").filter((r) => r.to === "acme::shop::Customer");
  // the FK edge is de-duplicated away; only the enriched relationship edge remains
  expect(toCustomer.map((r) => r.kind)).toEqual(["relationship"]);
  const rel = toCustomer[0]!;
  expect(rel.cardinality).toBe("one");
  expect(rel.onDelete).toBe("cascade");
  expect(rel.subtype).toBe("association");
  expect(rel.via).toBe("customer");
});

test("M:N through-junction edge carries the derived join fields (hetero)", async () => {
  const model = await loadModel([join(FIX, "acme")]);
  const g = new LinkGraph(model);
  const e = g.refsFrom("acme::shop::Order").find((r) => r.to === "acme::shop::Product");
  expect(e).toBeDefined();
  expect(e!.kind).toBe("relationship");
  expect(e!.cardinality).toBe("many");
  expect(e!.through).toBe("acme::shop::OrderProduct");
  expect(e!.sourceJoinField).toBe("orderId");
  expect(e!.targetJoinField).toBe("productId");
  // the junction is still its own node with its two FK edges (neither covered by a relationship)
  expect(g.refsFrom("acme::shop::OrderProduct").filter((r) => r.kind === "fk").map((r) => r.to).sort())
    .toEqual(["acme::shop::Order", "acme::shop::Product"]);
});

test("directed self-join (@sourceRefField) resolves source/target join fields", async () => {
  const model = await loadModel([join(FIX, "acme")]);
  const g = new LinkGraph(model);
  const e = g.refsFrom("acme::shop::Customer").find((r) => r.to === "acme::shop::Customer" && r.via === "referrals");
  expect(e).toBeDefined();
  expect(e!.through).toBe("acme::shop::CustomerReferral");
  expect(e!.sourceJoinField).toBe("referrerId");
  expect(e!.targetJoinField).toBe("referredId");
  expect(e!.symmetric).toBeFalsy();
});

test("symmetric self-join (@symmetric) is flagged symmetric", async () => {
  const model = await loadModel([join(FIX, "acme")]);
  const g = new LinkGraph(model);
  const e = g.refsFrom("acme::shop::Customer").find((r) => r.to === "acme::shop::Customer" && r.via === "friends");
  expect(e).toBeDefined();
  expect(e!.through).toBe("acme::shop::CustomerFriend");
  expect(e!.symmetric).toBe(true);
});
