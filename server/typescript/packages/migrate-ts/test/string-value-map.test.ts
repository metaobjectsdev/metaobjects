// rc.21 — a string-stored field.enum whose database spelling differs from its members
// (@stringValueMap): the column default, length and CHECK hold the stored strings.

import { describe, expect, test } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../src/expected-schema.js";

const MODEL = { "metadata.root": { package: "acme", children: [
  { "object.entity": { name: "Article", children: [
    { "source.rdb": { "@table": "articles" } },
    { "field.long": { name: "id" } },
    { "field.enum": { name: "status", "@values": ["Draft", "Published"], "@default": "Draft",
      "@stringValueMap": { Draft: "draft", Published: "published" } } },
    { "field.enum": { name: "channel", "@values": ["Email", "TextMessage"], "@maxLength": 16,
      "@stringValueMap": { Email: "EMAIL_V1", TextMessage: "SMS_LEGACY" } } },
    { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } } ] } } ] } };

describe("@stringValueMap in the expected schema", () => {
  test("the default, the length and the CHECK hold the stored strings", async () => {
    const { root, errors } = await new MetaDataLoader({ strict: true }).load([new InMemoryStringSource(JSON.stringify(MODEL))]);
    expect(errors).toEqual([]);
    const table = buildExpectedSchema(root, { dialect: "postgres" }).tables.find((t) => t.name === "articles")!;
    const status = table.columns.find((c) => c.name === "status")!;
    expect(status.default).toEqual({ kind: "literal", value: "draft" });
    expect(table.checks.map((c) => c.expression)).toContain(`"channel" IN ('EMAIL_V1', 'SMS_LEGACY')`);
  });

  test("a stored string longer than @maxLength is refused at load", async () => {
    const m = JSON.parse(JSON.stringify(MODEL));
    m["metadata.root"].children[0]["object.entity"].children[3]["field.enum"]["@maxLength"] = 9;
    const { errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(m))]);
    expect(errors.map((e) => String(e.message)).join("\n")).toContain(`shorter than its stored value "SMS_LEGACY"`);
  });
});
