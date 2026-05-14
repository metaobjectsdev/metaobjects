import { describe, test, expect } from "bun:test";
import {
  MetaModel,
  TypeId,
  TYPE_OBJECT,
  TYPE_FIELD,
  TYPE_IDENTITY,
  TYPE_VIEW,
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_CURRENCY,
  IDENTITY_SUBTYPE_PRIMARY,
  OBJECT_SUBTYPE_ENTITY,
  VIEW_SUBTYPE_CURRENCY,
} from "@metaobjects/metadata";
import { renderEntityConstants } from "../../src/templates/entity-constants.js";

function makeEntity(fields: MetaModel[]): MetaModel {
  const entity = new MetaModel(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), "Program");
  entity.setAttr("dbTable", "programs");

  const id = new MetaModel(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_INT), "id");
  entity.addChild(id);

  for (const f of fields) {
    entity.addChild(f);
  }

  const primary = new MetaModel(new TypeId(TYPE_IDENTITY, IDENTITY_SUBTYPE_PRIMARY), "primary");
  primary.setAttr("fields", ["id"]);
  primary.setAttr("generation", "increment");
  entity.addChild(primary);

  return entity;
}

function makeCurrencyField(name: string, currencyCode?: string): MetaModel {
  const field = new MetaModel(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_CURRENCY), name);
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
    const viewChild = new MetaModel(new TypeId(TYPE_VIEW, VIEW_SUBTYPE_CURRENCY), "currency");
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
    const intField = new MetaModel(new TypeId(TYPE_FIELD, FIELD_SUBTYPE_INT), "quantity");
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
