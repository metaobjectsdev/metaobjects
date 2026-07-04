import { expect, test } from "bun:test";
import { join } from "node:path";
import { loadModel, treeOf } from "../src/load";

const FIX = join(import.meta.dir, "fixture/input");

test("loads all fixture source dirs into one root", async () => {
  const model = await loadModel([join(FIX, "acme")]);
  const names = model.root.objects().map((o) => o.name).sort();
  expect(names).toEqual(["BaseEntity", "Customer", "CustomerFriend", "CustomerReferral", "ItemView", "LineItemView", "NpcPayload", "NpcResponse", "Order", "OrderLine", "OrderProduct", "OrphanLog", "OrphanVO", "Product"]);
  const order = model.root.objects().find((o) => o.name === "Order")!;
  expect(treeOf(order, model)).toBe("acme");
});
