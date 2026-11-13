// A view over an abstract intermediate level of a TPH hierarchy reads the rows of every concrete
// subtype beneath it (an IN list), not nothing and not the whole shared table.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildProjectionViews } from "../../src/projection/build-projection-views.js";

const MODEL = { "metadata.root": { package: "acme", children: [
  { "object.entity": { name: "Authorization", "@discriminator": "type", children: [
    { "source.rdb": { "@table": "authorizations" } },
    { "field.long": { name: "id" } },
    { "field.enum": { name: "type", "@required": true, "@values": ["Copay", "Prior", "Appeal"], "@intValueMap": { Copay: 1, Prior: 2, Appeal: 3 } } },
    { "field.string": { name: "code" } },
    { "identity.primary": { name: "id", "@fields": "id" } },
  ] } },
  { "object.entity": { name: "CardAuthorization", extends: "Authorization", abstract: true, children: [] } },
  { "object.entity": { name: "CopayAuthorization", extends: "CardAuthorization", "@discriminatorValue": "Copay", children: [] } },
  { "object.entity": { name: "PriorAuthorization", extends: "CardAuthorization", "@discriminatorValue": "Prior", children: [] } },
  { "object.entity": { name: "AppealAuthorization", extends: "Authorization", "@discriminatorValue": "Appeal", children: [] } },
  { "object.projection": { name: "CardAuthView", children: [
    { "source.rdb": { "@kind": "view", "@table": "v_card_auth" } },
    { "field.long": { name: "id", extends: "CardAuthorization.id" } },
    { "field.string": { name: "code", extends: "CardAuthorization.code" } },
    { "identity.primary": { name: "id", extends: "CardAuthorization.id" } },
  ] } },
] } };

describe("TPH scope of an abstract level", () => {
  test("lists every concrete subtype beneath it", async () => {
    const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(MODEL))]);
    expect(errors).toEqual([]);
    const [v] = buildProjectionViews(root, { dialect: "postgres" });
    expect(v!.sql).toMatch(/WHERE \w+\.type IN \(1, 2\)/);
  });
});
