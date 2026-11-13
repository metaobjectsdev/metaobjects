// rc.21 fix round (I2): two different CHECKs under one default name are refused at build, naming
// both, instead of a CREATE TABLE the database refuses ("constraint already exists").

import { expect, test } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../src/expected-schema.js";

test("two CHECKs under one default name are refused", async () => {
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify({ "metadata.root": { package: "acme", children: [
    { "object.entity": { name: "Window", children: [
      { "source.rdb": { "@table": "windows" } },
      { "field.long": { name: "id" } },
      { "field.int": { name: "a" } }, { "field.int": { name: "b" } }, { "field.int": { name: "c" } },
      { "identity.primary": { name: "id", "@fields": "id" } },
      { "validator.comparison": { name: "ab", "@left": "a", "@op": "lt", "@right": "b" } },
      { "validator.comparison": { name: "ac", "@left": "a", "@op": "lt", "@right": "c" } } ] } } ] } }))]);
  expect(errors).toEqual([]);
  expect(() => buildExpectedSchema(root, { dialect: "postgres" })).toThrow(/both named 'windows_a_cmp_chk'/);
});
