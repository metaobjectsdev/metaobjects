import { describe, test, expect } from "bun:test";
import {
  MetaDataLoader,
  InMemoryStringSource,
  type MetaObject,
} from "@metaobjectsdev/metadata";
import { buildGrid } from "../src/grid-from-metadata.js";

async function loadObject(doc: unknown, name: string): Promise<MetaObject> {
  const loader = new MetaDataLoader();
  const { errors } = await loader.load([
    new InMemoryStringSource(JSON.stringify(doc), { id: "grid-test.json" }),
  ]);
  if (errors.length) throw new Error(`load errors: ${JSON.stringify(errors)}`);
  return loader.findByTypeAndName("object", name) as MetaObject;
}

const SUBSCRIBER = (extraChildren: unknown[] = []) => ({
  "metadata.root": {
    package: "demo",
    children: [
      { "object.entity": { name: "Subscriber", children: [
        { "field.long": { name: "id" } },
        { "field.string": { name: "firstName" } },
        { "field.boolean": { name: "subscribed", "@required": true } },
        { "field.enum": { name: "status", "@values": ["ACTIVE", "PENDING"] } },
        { "identity.primary": { name: "id", "@fields": "id" } },
        ...extraChildren,
      ] } },
    ],
  },
});

describe("buildGrid (metadata-driven, generic)", () => {
  test("no dataGrid layout → every field becomes a column, headers humanized", async () => {
    const meta = await loadObject(SUBSCRIBER(), "Subscriber");
    const { config, columns } = buildGrid(meta);

    expect(columns.map((c) => c.field)).toEqual(["id", "firstName", "subscribed", "status"]);
    expect(columns.map((c) => c.header)).toEqual(["Id", "First Name", "Subscribed", "Status"]);
    // cell-renderer hint falls back to the field subtype when no view is declared
    expect(columns.map((c) => c.viewKind)).toEqual(["long", "string", "boolean", "enum"]);
    expect(config).toEqual({ name: "default", pageSize: 25, filterable: false });
  });

  test("dataGrid layout drives column set, order, page size, sort, filterable", async () => {
    const grid = { "layout.dataGrid": {
      name: "default",
      "@columns": ["firstName", "status"],
      "@pageSize": 10,
      "@defaultSortField": "firstName",
      "@defaultSortOrder": "desc",
      "@filterable": true,
    } };
    const meta = await loadObject(SUBSCRIBER([grid]), "Subscriber");
    const { config, columns } = buildGrid(meta);

    expect(columns.map((c) => c.field)).toEqual(["firstName", "status"]);
    expect(config).toEqual({
      name: "default",
      pageSize: 10,
      filterable: true,
      defaultSort: { field: "firstName", order: "desc" },
    });
  });

  test("is generic — the SAME call works on a different object with no shared names", async () => {
    const doc = { "metadata.root": { package: "demo", children: [
      { "object.entity": { name: "Invoice", children: [
        { "field.long": { name: "id" } },
        { "field.currency": { name: "amountDue", "@currency": "USD" } },
        { "identity.primary": { name: "id", "@fields": "id" } },
      ] } },
    ] } };
    const meta = await loadObject(doc, "Invoice");
    const { columns } = buildGrid(meta);
    expect(columns.map((c) => c.field)).toEqual(["id", "amountDue"]);
    expect(columns.map((c) => c.header)).toEqual(["Id", "Amount Due"]);
  });
});
