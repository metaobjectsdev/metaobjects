// rc.21 — a projection's @filter on a @stringValueMap enum compares the member's stored string.

import { expect, test } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildProjectionViews } from "../../src/projection/build-projection-views.js";

test("a view @filter on a @stringValueMap enum binds the stored string", async () => {
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify({ "metadata.root": { package: "acme", children: [
    { "object.entity": { name: "Upload", children: [
      { "source.rdb": { "@table": "uploads" } },
      { "field.long": { name: "id" } },
      { "field.enum": { name: "status", "@values": ["Pending", "Delivered"], "@stringValueMap": { Pending: "pending", Delivered: "delivered" } } },
      { "identity.primary": { name: "id", "@fields": "id" } } ] } },
    { "object.projection": { name: "PendingUploads", "@filter": { status: "Pending" }, children: [
      { "source.rdb": { "@kind": "view", "@view": "v_pending_uploads" } },
      { "field.long": { name: "id", extends: "Upload.id" } },
      { "identity.primary": { name: "id", extends: "Upload.id" } } ] } } ] } }))]);
  expect(errors).toEqual([]);
  const sql = buildProjectionViews(root, { dialect: "postgres" })[0]!.sql;
  expect(sql).toContain("'pending'");
  expect(sql).not.toContain("'Pending'");
});
