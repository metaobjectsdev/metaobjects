// Phase 5, bug TPH-scope: a TPH subtype shares its base's table, so a view whose base is a
// subtype, or whose join or origin.first lands on one, must add the subtype's discriminator
// predicate. Without it a "copay authorizations" view read every authorization row.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildProjectionViews } from "../../src/projection/build-projection-views.js";

const ENTITIES = [
  { "object.entity": { name: "CopayCard", children: [
    { "source.rdb": { "@table": "copay_cards" } },
    { "field.long": { name: "id" } },
    { "identity.primary": { name: "id", "@fields": "id" } },
  ] } },
  { "object.entity": { name: "Authorization", "@discriminator": "type", children: [
    { "source.rdb": { "@table": "authorizations" } },
    { "field.long": { name: "id" } },
    { "field.enum": { name: "type", "@required": true, "@values": ["Copay", "Prior", "Medical", "Pharmacy"], "@intValueMap": { Copay: 1, Prior: 2, Medical: 3, Pharmacy: 4 } } },
    { "field.string": { name: "code" } },
    { "identity.primary": { name: "id", "@fields": "id" } },
  ] } },
  { "object.entity": { name: "CopayAuthorization", extends: "Authorization", "@discriminatorValue": "Copay", children: [
    { "field.long": { name: "copayCardId" } },
    { "identity.reference": { name: "copayCard", "@fields": "copayCardId", "@references": "CopayCard" } },
  ] } },
  // An abstract level between the base and two concrete subtypes: its rows are both subtypes'.
  { "object.entity": { name: "BenefitAuthorization", extends: "Authorization", abstract: true, children: [
    { "field.string": { name: "payer" } },
  ] } },
  { "object.entity": { name: "MedicalAuthorization", extends: "BenefitAuthorization", "@discriminatorValue": "Medical", children: [] } },
  { "object.entity": { name: "PharmacyAuthorization", extends: "BenefitAuthorization", "@discriminatorValue": "Pharmacy", children: [] } },
];

const model = (projections: unknown[]) => ({ "metadata.root": { package: "acme", children: [...ENTITIES, ...projections] } });

async function viewSql(projections: unknown[]): Promise<string> {
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(model(projections)))]);
  expect(errors).toEqual([]);
  return buildProjectionViews(root, { dialect: "postgres" })[0]!.sql;
}

describe("TPH-scope — a view over a TPH subtype carries its discriminator", () => {
  test("a subtype base filters the shared table to its rows", async () => {
    const sql = await viewSql([{ "object.projection": { name: "CopayAuthView", children: [
      { "source.rdb": { "@kind": "view", "@table": "v_copay_auth" } },
      { "field.long": { name: "id", extends: "CopayAuthorization.id" } },
      { "field.string": { name: "code", extends: "CopayAuthorization.code" } },
      { "identity.primary": { name: "id", extends: "CopayAuthorization.id" } },
    ] } }]);
    expect(sql).toContain("FROM public.authorizations c");
    expect(sql).toContain("WHERE c.type = 1");
  });

  test("a join onto a subtype scopes the join, not the base rows", async () => {
    const sql = await viewSql([{ "object.projection": { name: "CardAuthCount", children: [
      { "source.rdb": { "@kind": "view", "@table": "v_card_auth_count" } },
      { "field.long": { name: "id", extends: "CopayCard.id" } },
      { "field.int": { name: "auths", children: [{ "origin.aggregate": { "@agg": "count", "@of": "CopayAuthorization.id", "@via": "CopayCard.copayAuthorizations" } }] } },
      { "field.string": { name: "latestCode", children: [{ "origin.first": { "@of": "CopayAuthorization.code", "@via": "CopayCard.copayAuthorizations", "@orderBy": ["id:desc"] } }] } },
      { "identity.primary": { name: "id", extends: "CopayCard.id" } },
    ] } }]);
    expect(sql).toMatch(/LEFT OUTER JOIN public\.authorizations (\w+) ON \1\.copay_card_id = c\.id AND \1\.type = 1/);
    expect(sql).toMatch(/FROM public\.authorizations (\w+) WHERE \1\.copay_card_id = c\.id AND \1\.type = 1 ORDER BY/);
    expect(sql).not.toContain("WHERE c.type");
  });

  test("an abstract intermediate level reads every concrete subtype beneath it", async () => {
    const sql = await viewSql([{ "object.projection": { name: "BenefitAuthView", children: [
      { "source.rdb": { "@kind": "view", "@table": "v_benefit_auth" } },
      { "field.long": { name: "id", extends: "BenefitAuthorization.id" } },
      { "field.string": { name: "payer", extends: "BenefitAuthorization.payer" } },
      { "identity.primary": { name: "id", extends: "BenefitAuthorization.id" } },
    ] } }]);
    expect(sql).toContain("WHERE b.type IN (3, 4)");
  });
});
