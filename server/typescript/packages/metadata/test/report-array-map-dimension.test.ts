// Rule: a derived report field whose source field is an array (isArray) or a field.map is neither
// filterable nor sortable. The read model carries no @filterable on it, and every allowlist built
// from the read model (filter, sort) therefore leaves it out.

import { describe, expect, test } from "bun:test";
import { FIELD_ATTR_FILTERABLE, InMemoryStringSource, MetaDataLoader, reportReadModel } from "../src/index.js";

const model = {
  "metadata.root": {
    package: "acme",
    children: [
      {
        "object.entity": {
          name: "Event",
          children: [
            { "source.rdb": { "@table": "events" } },
            { "field.long": { name: "id" } },
            { "field.string": { name: "kind" } },
            { "field.string": { name: "tags", isArray: true } },
            { "field.map": { name: "attrs", "@valueType": "string" } },
            { "identity.primary": { name: "id", "@fields": ["id"] } },
            { "dimension.attribute": { name: "kind", "@of": "Event.kind" } },
            { "dimension.attribute": { name: "tags", "@of": "Event.tags" } },
            { "dimension.attribute": { name: "attrs", "@of": "Event.attrs" } },
            { "measure.aggregate": { name: "events", "@agg": "count", "@of": "Event.id" } },
          ],
        },
      },
      {
        "object.report": {
          name: "EventCounts", "@from": "Event", "@dimensions": ["kind", "tags", "attrs"], "@measures": ["events"],
          children: [{ "source.rdb": { "@kind": "view", "@view": "v_event_counts" } }],
        },
      },
    ],
  },
};

describe("array- and map-valued report dimensions", () => {
  test("only the scalar dimension and the measure are filterable", async () => {
    const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(model))]);
    expect(errors).toEqual([]);
    const rm = reportReadModel(root.objects().find((o) => o.name === "EventCounts")!, root);
    const filterable = Object.fromEntries(rm.fields().map((f) => [f.name, f.attr(FIELD_ATTR_FILTERABLE) === true]));
    expect(filterable).toEqual({ kind: true, tags: false, attrs: false, events: true });
  });
});
