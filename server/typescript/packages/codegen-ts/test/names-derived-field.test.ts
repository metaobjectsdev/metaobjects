// rc.21 (U7): a derived (origin-bearing) field of a table-backed entity has no column — it is
// lowered where a projection reads it — so its names entry would name a column that does not
// exist. The artifact carries no entry for it. A projection's derived field IS a column of its
// view and keeps its entry.

import { describe, expect, test } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, isMetaObject, type MetaObject } from "@metaobjectsdev/metadata";
import { resolveObjectNames } from "../src/names.js";

const MODEL = { "metadata.root": { package: "acme", children: [
  { "object.entity": { name: "Account", children: [
    { "source.rdb": { "@table": "accounts" } },
    { "field.long": { name: "id" } },
    { "field.int": { name: "score" } },
    { "field.boolean": { name: "isHigh", children: [ { "origin.computed": { "@expr": {
      op: "gte", left: { field: "score" }, right: { value: 4 } } } } ] } },
    { "identity.primary": { name: "id", "@fields": "id" } } ] } },
  { "object.projection": { name: "AccountView", "@filter": { isHigh: true }, children: [
    { "source.rdb": { "@kind": "view", "@view": "v_accounts" } },
    { "field.long": { name: "id", extends: "Account.id" } },
    { "field.int": { name: "doubled", children: [ { "origin.computed": { "@expr": {
      fn: "coalesce", args: [ { field: "score" }, { value: 0 } ] } } } ] } },
    { "identity.primary": { name: "id", extends: "Account.id" } } ] } } ] } };

describe("names of a derived field", () => {
  test("a table entity's derived field has no names entry; a projection's keeps its column", async () => {
    const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(MODEL))]);
    expect(errors).toEqual([]);
    const obj = (name: string) => root.objects().find((o) => o.name === name && isMetaObject(o)) as MetaObject;
    const account = resolveObjectNames(obj("Account"))!;
    expect(Object.keys(account.fields).sort()).toEqual(["id", "score"]);
    expect(Object.keys(account.ownFields).sort()).toEqual(["id", "score"]);
    expect(resolveObjectNames(obj("AccountView"))!.fields["doubled"]?.column).toBe("doubled");
  });
});
