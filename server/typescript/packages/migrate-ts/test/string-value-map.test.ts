// rc.21 — a string-stored field.enum whose database spelling differs from its members
// (@stringValueMap): the column default, length and CHECK hold the stored strings.

import { describe, expect, test } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../src/expected-schema.js";

const MODEL = { "metadata.root": { package: "acme", children: [
  { "object.entity": { name: "Upload", children: [
    { "source.rdb": { "@table": "uploads" } },
    { "field.long": { name: "id" } },
    { "field.enum": { name: "status", "@values": ["Pending", "Delivered"], "@default": "Pending",
      "@stringValueMap": { Pending: "pending", Delivered: "delivered" } } },
    { "field.enum": { name: "authType", "@values": ["KeyFilePath", "KeyFileContent"], "@maxLength": 16,
      "@stringValueMap": { KeyFilePath: "Key_File_Path", KeyFileContent: "Key_File_Content" } } },
    { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } } ] } } ] } };

describe("@stringValueMap in the expected schema", () => {
  test("the default, the length and the CHECK hold the stored strings", async () => {
    const { root, errors } = await new MetaDataLoader({ strict: true }).load([new InMemoryStringSource(JSON.stringify(MODEL))]);
    expect(errors).toEqual([]);
    const table = buildExpectedSchema(root, { dialect: "postgres" }).tables.find((t) => t.name === "uploads")!;
    const status = table.columns.find((c) => c.name === "status")!;
    expect(status.default).toEqual({ kind: "literal", value: "pending" });
    expect(table.checks.map((c) => c.expression)).toContain(`"auth_type" IN ('Key_File_Path', 'Key_File_Content')`);
  });

  test("a stored string longer than @maxLength is refused at load", async () => {
    const m = JSON.parse(JSON.stringify(MODEL));
    m["metadata.root"].children[0]["object.entity"].children[3]["field.enum"]["@maxLength"] = 14;
    const { errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(m))]);
    expect(errors.map((e) => String(e.message)).join("\n")).toContain(`shorter than its stored value "Key_File_Content"`);
  });
});
