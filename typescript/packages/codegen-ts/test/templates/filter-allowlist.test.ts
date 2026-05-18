import { describe, test, expect } from "bun:test";
import { TYPE_OBJECT } from "@metaobjects/metadata";
import { FileMetaDataLoader } from "@metaobjects/metadata/core";
import { renderFilterAllowlist, renderSortAllowlist } from "../../src/templates/filter-allowlist.js";
import { resolve } from "node:path";

const FIXTURE = resolve(import.meta.dir, "..", "fixtures", "filter-fixture.json");

async function loadEntity(name: string) {
  const { root } = await new FileMetaDataLoader().loadFiles([FIXTURE]);
  return root.ownChildren().find((c) => c.type === TYPE_OBJECT && c.name === name)!;
}

describe("renderFilterAllowlist", () => {
  test("emits ops gated by field subtype", async () => {
    const entity = await loadEntity("Subscriber");
    const out = renderFilterAllowlist(entity).toString();
    expect(out).toContain("export const SubscriberFilterAllowlist");
    // String field email: gets eq/ne/in/like/isNull
    expect(out).toMatch(/email:\s*\{[^}]*"eq"/);
    expect(out).toMatch(/email:[\s\S]*?"like"/);
    expect(out).not.toMatch(/email:\s*\{[^}]*"gte"/);
    // Boolean field subscribed: only eq + isNull
    expect(out).toMatch(/subscribed:\s*\{[^}]*"eq"/);
    expect(out).toMatch(/subscribed:\s*\{[^}]*"isNull"/);
    expect(out).not.toMatch(/subscribed:\s*\{[^}]*"like"/);
    // Datetime field createdAt: gets gte/lte
    expect(out).toMatch(/createdAt:\s*\{[^}]*"gte"/);
  });

  test("only @filterable fields appear in allowlist", async () => {
    const entity = await loadEntity("Subscriber");
    const out = renderFilterAllowlist(entity).toString();
    expect(out).not.toContain("internalNote");
  });

  test("entity with no filterable fields emits empty allowlist", async () => {
    const { root } = await new FileMetaDataLoader().loadFiles([FIXTURE]);
    const subscriber = root.ownChildren().find((c) => c.type === TYPE_OBJECT && c.name === "Subscriber")!;
    const out = renderFilterAllowlist(subscriber).toString();
    expect(out).toContain("SubscriberFilterAllowlist");
  });
});

describe("renderSortAllowlist", () => {
  test("inherits sortable from @filterable when @sortable absent", async () => {
    const entity = await loadEntity("Subscriber");
    const out = renderSortAllowlist(entity).toString();
    expect(out).toContain("export const SubscriberSortAllowlist");
    // email is @filterable, no @sortable → still appears as sortable
    expect(out).toMatch(/email:\s*\{/);
  });

  test("emits defaultOrder when @sortableDefaultOrder is set", async () => {
    const entity = await loadEntity("Subscriber");
    const out = renderSortAllowlist(entity).toString();
    // createdAt has @sortableDefaultOrder: "desc"
    expect(out).toMatch(/createdAt:\s*\{[^}]*defaultOrder:\s*"desc"/);
  });

  test("@filterable + @sortable:false field is excluded from SortAllowlist", async () => {
    // lastName has @filterable:true + @sortable:false — must NOT appear in SortAllowlist.
    const entity = await loadEntity("Subscriber");
    const out = renderSortAllowlist(entity).toString();
    expect(out).not.toContain("lastName");
  });

  test("@sortable:true field with no @filterable appears in SortAllowlist", async () => {
    // Product.price has @sortable:true and no @filterable — must appear in SortAllowlist.
    const entity = await loadEntity("Product");
    const out = renderSortAllowlist(entity).toString();
    expect(out).toContain("export const ProductSortAllowlist");
    expect(out).toMatch(/price:\s*\{/);
  });
});
