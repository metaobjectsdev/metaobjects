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

  test("a layout naming a field with NO order takes the field's @sortableDefaultOrder", async () => {
    // The test above declares BOTH layout attrs, so it can only ever exercise the
    // explicit branch — the same blind spot that let every other grid tier ship with no
    // read for @sortableDefaultOrder. Here the layout names a field and says nothing
    // about direction, so the FIELD decides. A runtime grid answering "asc" here would
    // render the opposite way from both the generated grid and the endpoint it queries.
    const doc = SUBSCRIBER([
      { "layout.dataGrid": { name: "default", "@defaultSortField": "createdAt" } },
    ]) as unknown as {
      "metadata.root": { children: { "object.entity": { children: unknown[] } }[] };
    };
    doc["metadata.root"].children[0]!["object.entity"].children.unshift({
      "field.timestamp": { name: "createdAt", "@sortableDefaultOrder": "desc" },
    });

    const { config } = buildGrid(await loadObject(doc, "Subscriber"));
    expect(config.defaultSort).toEqual({ field: "createdAt", order: "desc" });
  });

  test("a layout order still WINS over the field's declared one", async () => {
    // Precedence, the other half of the contract: the field fills in a MISSING
    // direction, it never overrides a present one.
    const doc = SUBSCRIBER([
      { "layout.dataGrid": {
        name: "default",
        "@defaultSortField": "createdAt",
        "@defaultSortOrder": "asc",
      } },
    ]) as unknown as {
      "metadata.root": { children: { "object.entity": { children: unknown[] } }[] };
    };
    doc["metadata.root"].children[0]!["object.entity"].children.unshift({
      "field.timestamp": { name: "createdAt", "@sortableDefaultOrder": "desc" },
    });

    const { config } = buildGrid(await loadObject(doc, "Subscriber"));
    expect(config.defaultSort).toEqual({ field: "createdAt", order: "asc" });
  });

  test("a named field declaring nothing falls back to ascending", async () => {
    const grid = { "layout.dataGrid": { name: "default", "@defaultSortField": "firstName" } };
    const { config } = buildGrid(await loadObject(SUBSCRIBER([grid]), "Subscriber"));
    expect(config.defaultSort).toEqual({ field: "firstName", order: "asc" });
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

// A declared display label must reach the column header.
//
// The header read `view.ownAttr("label")`, and `@label` is registered by NO provider
// in any port — `@title` is the documentation commonAttr chartered as the display
// label. So the read answered `undefined` for every field that ever declared one, and
// every grid header silently fell back to the humanized field name. Nothing here
// covered the path, which is why 49 green tests said nothing about it.
//
// Same shape as `attr("isArray")`: an unregistered name answers `undefined`, which is
// indistinguishable from "the author did not set it".
describe("a declared @title reaches the column header", () => {
  const WITH_TITLE = {
    "metadata.root": {
      package: "demo",
      children: [
        { "object.entity": { name: "Subscriber", children: [
          { "field.long": { name: "id" } },
          { "field.string": { name: "firstName", children: [
            { "view.text": { name: "display", "@title": "Given Name" } },
          ] } },
          { "identity.primary": { name: "id", "@fields": "id" } },
        ] } },
      ],
    },
  };

  test("the header is the declared title, not the humanized field name", async () => {
    const obj = await loadObject(WITH_TITLE, "Subscriber");
    const { columns } = buildGrid(obj);
    const firstName = columns.find((c) => c.field === "firstName");
    expect(firstName?.header).toBe("Given Name");
    // Stated in the negative too: the humanized fallback is what the broken read
    // produced, so a positive-only assertion would pass against the defect if the
    // field name happened to humanize to the same string.
    expect(firstName?.header).not.toBe("First Name");
  });

  test("a field with no title still humanizes", async () => {
    const obj = await loadObject(WITH_TITLE, "Subscriber");
    const { columns } = buildGrid(obj);
    expect(columns.find((c) => c.field === "id")?.header).toBe("Id");
  });

  test("a title INHERITED through extends is honoured", async () => {
    // ADR-0039: the read was `ownAttr` on an `ownViews()` result, so both halves
    // dropped what a parent contributed. A concrete field extending an abstract one
    // must see the parent's view AND its title.
    const doc = {
      "metadata.root": {
        package: "demo",
        children: [
          { "object.entity": { name: "Base", abstract: true, children: [
            { "field.string": { name: "firstName", children: [
              { "view.text": { name: "display", "@title": "Given Name" } },
            ] } },
          ] } },
          { "object.entity": { name: "Subscriber", children: [
            { "field.long": { name: "id" } },
            { "field.string": { name: "firstName", extends: "Base.firstName" } },
            { "identity.primary": { name: "id", "@fields": "id" } },
          ] } },
        ],
      },
    };
    const obj = await loadObject(doc, "Subscriber");
    const { columns } = buildGrid(obj);
    expect(columns.find((c) => c.field === "firstName")?.header).toBe("Given Name");
  });
});
