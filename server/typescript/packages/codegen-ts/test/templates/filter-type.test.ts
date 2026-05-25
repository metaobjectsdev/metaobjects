import { describe, test, expect } from "bun:test";
import { renderFilterType } from "../../src/templates/filter-type.js";
import { resolve } from "node:path";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";

const FIXTURE = resolve(import.meta.dir, "..", "fixtures", "filter-fixture.json");

async function loadEntity(name: string) {
  const { root } = await new MetaDataLoader().load([new FileSource(FIXTURE)]);
  return root.objects().find((c) => c.name === name)!;
}

describe("renderFilterType", () => {
  test("emits SubscriberFilter type", async () => {
    const entity = await loadEntity("Subscriber");
    const out = renderFilterType(entity).toString();
    expect(out).toContain("export type SubscriberFilter");
  });

  test("includes only @filterable fields", async () => {
    const entity = await loadEntity("Subscriber");
    const out = renderFilterType(entity).toString();
    expect(out).toContain("email?:");
    expect(out).toContain("firstName?:");
    expect(out).toContain("subscribed?:");
    expect(out).toContain("createdAt?:");
    expect(out).not.toContain("internalNote?:");
  });

  test("string field has like operator", async () => {
    const entity = await loadEntity("Subscriber");
    const out = renderFilterType(entity).toString();
    // email is a string field with @filterable=true; should have like? in its op union
    expect(out).toMatch(/email\?:[\s\S]*?like\?:/);
  });

  test("string field does NOT have gte operator", async () => {
    const entity = await loadEntity("Subscriber");
    const out = renderFilterType(entity).toString();
    // Strings shouldn't get gte
    expect(out).not.toMatch(/email\?:\s*string\s*\|\s*\{[^}]*gte\?:/);
  });

  test("boolean field is restricted to eq + isNull", async () => {
    const entity = await loadEntity("Subscriber");
    const out = renderFilterType(entity).toString();
    expect(out).toMatch(/subscribed\?:\s*boolean\s*\|\s*\{[^}]*eq\?:/);
    expect(out).toMatch(/subscribed\?:\s*boolean\s*\|\s*\{[^}]*isNull\?:/);
    expect(out).not.toMatch(/subscribed\?:\s*boolean\s*\|\s*\{[^}]*like\?:/);
  });

  test("datetime field has gte/lte operators", async () => {
    const entity = await loadEntity("Subscriber");
    const out = renderFilterType(entity).toString();
    expect(out).toMatch(/createdAt\?:[\s\S]*?gte\?:/);
    expect(out).toMatch(/createdAt\?:[\s\S]*?lte\?:/);
  });

  test("includes limit, offset, sort, and or/and at type level", async () => {
    const entity = await loadEntity("Subscriber");
    const out = renderFilterType(entity).toString();
    expect(out).toContain("limit?:");
    expect(out).toContain("offset?:");
    expect(out).toContain("sort?:");
    expect(out).toContain("or?: SubscriberFilter[]");
    expect(out).toContain("and?: SubscriberFilter[]");
  });

  test("@filterable + @sortable:false field appears in filter type but NOT in sort union", async () => {
    // lastName has @filterable:true + @sortable:false — should be filterable but not sortable.
    const entity = await loadEntity("Subscriber");
    const out = renderFilterType(entity).toString();
    // lastName should appear as a filterable field
    expect(out).toContain("lastName?:");
    // lastName must NOT appear in the sort union
    expect(out).not.toMatch(/"lastName"/);
  });

  test("@sortable:true field with no @filterable appears in sort union", async () => {
    // Product.price has @sortable:true and no @filterable — sort union should include it.
    const entity = await loadEntity("Product");
    const out = renderFilterType(entity).toString();
    // price should appear in the sort union
    expect(out).toMatch(/"price"/);
    // price should NOT appear as a filterable field (no @filterable)
    expect(out).not.toContain("price?:");
  });
});
