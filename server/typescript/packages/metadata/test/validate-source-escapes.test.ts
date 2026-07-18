// #208 — DDL-ownership escape valves loader validation (§5 R1–R6).
// One test per rule: R1–R5 are hard errors, R6 is a WARN (not an error).

import { describe, expect, test } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";

async function loadDoc(doc: unknown) {
  return new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(doc))]);
}
const codesOf = (errors: readonly Error[]) => errors.map((e) => (e as { code?: string }).code);

describe("#208 source escape validation (@sql / @unmanaged)", () => {
  test("R1: @sql AND @unmanaged on one source → ERR_SQL_BODY_WITH_UNMANAGED", async () => {
    const { errors } = await loadDoc({
      "metadata.root": { package: "acme", children: [
        { "object.projection": { name: "H", children: [
          { "source.rdb": { "@kind": "view", "@view": "v", "@sql": "SELECT 1", "@unmanaged": true } },
          { "field.long": { name: "id" } },
        ] } },
      ] },
    });
    expect(codesOf(errors)).toContain("ERR_SQL_BODY_WITH_UNMANAGED");
  });

  test("R2: @sql on @kind:table (writable, default) → ERR_SQL_BODY_ON_WRITABLE_KIND", async () => {
    const { errors } = await loadDoc({
      "metadata.root": { package: "acme", children: [
        { "object.entity": { name: "H", children: [
          { "source.rdb": { "@table": "t", "@sql": "SELECT 1" } },
          { "field.long": { name: "id" } },
          { "identity.primary": { name: "id", "@fields": ["id"] } },
        ] } },
      ] },
    });
    expect(codesOf(errors)).toContain("ERR_SQL_BODY_ON_WRITABLE_KIND");
  });

  test("R3: @sql present but empty string → ERR_BAD_ATTR_VALUE", async () => {
    const { errors } = await loadDoc({
      "metadata.root": { package: "acme", children: [
        { "object.projection": { name: "H", children: [
          { "source.rdb": { "@kind": "view", "@view": "v", "@sql": "" } },
          { "field.long": { name: "id" } },
        ] } },
      ] },
    });
    expect(codesOf(errors)).toContain("ERR_BAD_ATTR_VALUE");
  });

  test("R3b: @sql present but whitespace-only → ERR_BAD_ATTR_VALUE", async () => {
    const { errors } = await loadDoc({
      "metadata.root": { package: "acme", children: [
        { "object.projection": { name: "H", children: [
          { "source.rdb": { "@kind": "view", "@view": "v", "@sql": "   " } },
          { "field.long": { name: "id" } },
        ] } },
      ] },
    });
    expect(codesOf(errors)).toContain("ERR_BAD_ATTR_VALUE");
  });

  test("R4: origin.* under an @sql host → ERR_ORIGIN_UNDER_SQL_BODY", async () => {
    const { errors } = await loadDoc({
      "metadata.root": { package: "acme", children: [
        { "object.entity": { name: "Base", children: [
          { "field.long": { name: "id" } },
          { "field.string": { name: "title" } },
          { "identity.primary": { name: "id", "@fields": "id" } },
        ] } },
        { "object.projection": { name: "H", children: [
          { "source.rdb": { "@kind": "view", "@view": "v_h", "@sql": "SELECT id, title FROM base" } },
          { "field.long": { name: "id", extends: "acme::Base.id" } },
          { "field.string": { name: "displayTitle", children: [
            { "origin.passthrough": { "@from": "acme::Base.title" } },
          ] } },
          { "identity.primary": { name: "id", extends: "acme::Base.id" } },
        ] } },
      ] },
    });
    expect(codesOf(errors)).toContain("ERR_ORIGIN_UNDER_SQL_BODY");
  });

  test("R5: @filter (#207) + @sql on a projection → ERR_ORIGIN_UNDER_SQL_BODY", async () => {
    const { errors } = await loadDoc({
      "metadata.root": { package: "acme", children: [
        { "object.entity": { name: "Order", children: [
          { "source.rdb": { "@table": "orders" } },
          { "field.uuid": { name: "id" } },
          { "field.string": { name: "status" } },
          { "identity.primary": { name: "id", "@fields": ["id"] } },
        ] } },
        { "object.projection": { name: "ActiveOrders", "@filter": { status: { ne: "archived" } }, children: [
          { "source.rdb": {
              "@kind": "view",
              "@view": "v_active_orders",
              "@sql": "SELECT * FROM orders WHERE status <> 'archived'",
          } },
          { "field.uuid": { name: "id", extends: "acme::Order.id" } },
          { "field.string": { name: "status", extends: "acme::Order.status" } },
          { "identity.primary": { name: "id", extends: "acme::Order.id" } },
        ] } },
      ] },
    });
    expect(codesOf(errors)).toContain("ERR_ORIGIN_UNDER_SQL_BODY");
  });

  test("R6: origin.* under an @unmanaged host → WARN, not error", async () => {
    const { errors, warnings } = await loadDoc({
      "metadata.root": { package: "acme", children: [
        { "object.entity": { name: "Base", children: [
          { "field.long": { name: "id" } },
          { "field.string": { name: "title" } },
          { "identity.primary": { name: "id", "@fields": "id" } },
        ] } },
        { "object.projection": { name: "H", children: [
          { "source.rdb": { "@kind": "view", "@view": "v_h", "@unmanaged": true } },
          { "field.long": { name: "id", extends: "acme::Base.id" } },
          { "field.string": { name: "displayTitle", children: [
            { "origin.passthrough": { "@from": "acme::Base.title" } },
          ] } },
          { "identity.primary": { name: "id", extends: "acme::Base.id" } },
        ] } },
      ] },
    });
    expect(errors).toEqual([]);
    expect(warnings.map((w) => w.code)).toContain("WARN_ORIGIN_UNDER_UNMANAGED");
  });
});
