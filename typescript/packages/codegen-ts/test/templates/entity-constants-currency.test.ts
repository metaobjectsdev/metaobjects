import { describe, test, expect } from "bun:test";
import type { MetaObject, MetaData } from "@metaobjects/metadata";
import {
  TypeId,
  TYPE_IDENTITY,
  TYPE_VIEW,
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_CURRENCY,
  IDENTITY_SUBTYPE_PRIMARY,
  OBJECT_SUBTYPE_ENTITY,
  VIEW_SUBTYPE_CURRENCY,
} from "@metaobjects/metadata";
import { meta, metaObject, metaField } from "../_meta-build.js";
import { renderEntityConstants } from "../../src/templates/entity-constants.js";

function makeEntity(fields: MetaData[]): MetaObject {
  const entity = metaObject(OBJECT_SUBTYPE_ENTITY, "Program");
  entity.setAttr("dbTable", "programs");

  const id = metaField(FIELD_SUBTYPE_INT, "id");
  entity.addChild(id);

  for (const f of fields) {
    entity.addChild(f);
  }

  const primary = meta(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
  primary.setAttr("fields", ["id"]);
  primary.setAttr("generation", "increment");
  entity.addChild(primary);

  return entity;
}

function makeCurrencyField(name: string, currencyCode?: string): MetaData {
  const field = metaField(FIELD_SUBTYPE_CURRENCY, name);
  if (currencyCode !== undefined) {
    field.setAttr("currency", currencyCode);
  }
  return field;
}

describe("renderEntityConstants — currency field", () => {
  test("emits view: 'currency', currency: 'USD', locale: 'en-US' by default", () => {
    const field = makeCurrencyField("priceCents", "USD");
    const entity = makeEntity([field]);
    const out = renderEntityConstants(entity).toString();
    expect(out).toContain('view: "currency"');
    expect(out).toContain('currency: "USD"');
    expect(out).toContain('locale: "en-US"');
  });

  test("explicit @currency on field overrides default", () => {
    const field = makeCurrencyField("priceCents", "EUR");
    const entity = makeEntity([field]);
    const out = renderEntityConstants(entity).toString();
    expect(out).toContain('currency: "EUR"');
  });

  test("view[currency]@locale overrides default locale", () => {
    const field = makeCurrencyField("priceCents", "EUR");
    const viewChild = meta(new TypeId(TYPE_VIEW, VIEW_SUBTYPE_CURRENCY), "currency");
    viewChild.setAttr("locale", "de-DE");
    field.addChild(viewChild);
    const entity = makeEntity([field]);
    const out = renderEntityConstants(entity).toString();
    expect(out).toContain('locale: "de-DE"');
  });

  test("no @currency on field falls back to USD", () => {
    const field = makeCurrencyField("priceCents"); // no currencyCode set
    const entity = makeEntity([field]);
    const out = renderEntityConstants(entity).toString();
    expect(out).toContain('currency: "USD"');
  });

  test("currency keys do not leak into non-currency fields", () => {
    const currencyField = makeCurrencyField("priceCents", "USD");
    const intField = metaField(FIELD_SUBTYPE_INT, "quantity");
    const entity = makeEntity([currencyField, intField]);
    const out = renderEntityConstants(entity).toString();

    // Split to check per-field section for 'quantity' doesn't contain currency/locale
    const quantitySection = out.slice(out.indexOf("quantity:"));
    const nextFieldSep = quantitySection.indexOf("},");
    const quantityBlock = nextFieldSep !== -1 ? quantitySection.slice(0, nextFieldSep) : quantitySection;
    expect(quantityBlock).not.toContain("currency:");
    expect(quantityBlock).not.toContain("locale:");
  });
});
