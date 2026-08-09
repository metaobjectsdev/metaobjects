import { describe, test, expect } from "bun:test";
import { renderFilterAllowlist, renderSortAllowlist } from "../../src/templates/filter-allowlist.js";
import { resolve } from "node:path";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";
import { makeRenderContext } from "../../src/render-context.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";

const FIXTURE = resolve(import.meta.dir, "..", "fixtures", "filter-fixture.json");

async function loadEntity(name: string) {
  const { root } = await new MetaDataLoader().load([new FileSource(FIXTURE)]);
  return root.objects().find((c) => c.name === name)!;
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
    const { root } = await new MetaDataLoader().load([new FileSource(FIXTURE)]);
    const subscriber = root.objects().find((c) => c.name === "Subscriber")!;
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

describe("renderFilterAllowlist — timestampMode date-mode marking", () => {
  // A date-mode timestamp column binds a JS Date, so the rule must carry
  // `dateValues: true` for runtime-ts's parser to coerce with `new Date(...)`
  // instead of binding a string (which threw at request time). The behavioral
  // half of this contract is pinned in runtime-ts's filter-parser-date-mode test.
  async function allowlistFor(mode?: "date" | "string") {
    const { root } = await new MetaDataLoader().load([new FileSource(FIXTURE)]);
    const entity = root.objects().find((c) => c.name === "Subscriber")!;
    const ctx = makeRenderContext({
      dialect: "postgres",
      ...(mode !== undefined && { timestampMode: mode }),
      loadedRoot: root,
      outDir: "/x",
      dbImport: "~/db",
      pkMap: buildPkMap(root),
      relationMap: buildRelationMap(root),
    });
    return renderFilterAllowlist(entity, undefined, ctx).toString();
  }

  test('timestampMode:"date" marks the timestamp field and ONLY the timestamp field', async () => {
    const out = await allowlistFor("date");
    expect(out).toMatch(/createdAt:\s*\{[^}]*dateValues: true/);
    // Non-timestamp fields must not be marked — the flag is meaningless for them
    // and would make the parser try to Date-coerce a string or boolean.
    expect(out).not.toMatch(/email:\s*\{[^}]*dateValues/);
    expect(out).not.toMatch(/subscribed:\s*\{[^}]*dateValues/);
  });

  test('the default "string" mode emits no dateValues at all', async () => {
    expect(await allowlistFor()).not.toContain("dateValues");
    expect(await allowlistFor("string")).not.toContain("dateValues");
  });

  test('dialect:"sqlite" never marks — timestampMode normalizes to "string" there', async () => {
    const { root } = await new MetaDataLoader().load([new FileSource(FIXTURE)]);
    const entity = root.objects().find((c) => c.name === "Subscriber")!;
    const ctx = makeRenderContext({
      dialect: "sqlite", timestampMode: "date", loadedRoot: root,
      outDir: "/x", dbImport: "~/db",
      pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
    });
    expect(renderFilterAllowlist(entity, undefined, ctx).toString()).not.toContain("dateValues");
  });

  test("no ctx (bare call) is unchanged", async () => {
    const entity = await loadEntity("Subscriber");
    expect(renderFilterAllowlist(entity).toString()).not.toContain("dateValues");
  });
});
