// An enum's @maxLength is its column length, not an input rule: the UI descriptor emits no
// maxLength rule for it (the member list is the rule), while a string's @maxLength still is one.
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, type MetaObject } from "@metaobjectsdev/metadata";
import { buildUiFieldDescriptor } from "../src/templates/entity-ui-descriptor.js";

describe("UI descriptor — @maxLength", () => {
  test("an enum's column length is not a form rule; a string's maxLength still is", async () => {
    const json = JSON.stringify({ "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Ticket", children: [
        { "source.rdb": {} },
        { "field.long": { name: "id" } },
        { "field.enum": { name: "status", "@values": ["OPEN", "CLOSED"], "@maxLength": 16 } },
        { "field.string": { name: "title", "@maxLength": 40 } },
        { "identity.primary": { name: "pk", "@fields": "id" } },
      ] } },
    ] } });
    const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
    expect(errors).toEqual([]);
    const ticket = root.findObject("Ticket") as MetaObject;
    const rules = (name: string) =>
      JSON.stringify(buildUiFieldDescriptor(ticket.fields().find((f) => f.name === name)!, root));
    expect(rules("status")).not.toContain("maxLength");
    expect(rules("title")).toContain("maxLength");
  });
});
