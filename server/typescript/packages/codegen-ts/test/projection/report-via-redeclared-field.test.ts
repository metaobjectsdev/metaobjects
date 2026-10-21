// The rule for a `@via` dimension: the field is the EFFECTIVE field of the entity the `@via`
// reaches. When the reached subtype redeclares a field the base also declares, and `@of` names
// the base, the redeclaration wins: its column in the view, its type in the report shape.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, reportShape } from "@metaobjectsdev/metadata";
import { buildProjectionViews } from "../../src/projection/build-projection-views.js";
import { extractReportSpec } from "../../src/projection/extract-report-spec.js";

const model = {
  "metadata.root": {
    package: "a",
    children: [
      {
        "object.entity": {
          name: "Base",
          abstract: true,
          children: [
            { "field.long": { name: "id" } },
            { "field.string": { name: "label", "@column": "base_label" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Sub",
          extends: "Base",
          children: [
            { "source.rdb": { "@table": "subs" } },
            { "field.int": { name: "label", "@column": "sub_label" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Fact",
          children: [
            { "source.rdb": { "@table": "facts" } },
            { "field.long": { name: "id" } },
            { "field.long": { name: "subId", "@required": true } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
            { "identity.reference": { name: "fkSub", "@fields": ["subId"], "@references": "Sub" } },
            { "dimension.attribute": { name: "label", "@of": "Base.label", "@via": "Fact.fkSub" } },
            { "measure.aggregate": { name: "facts", "@agg": "count", "@of": "Fact.id" } },
          ],
        },
      },
      {
        "object.report": {
          name: "FactLabels",
          "@from": "Fact",
          "@dimensions": ["label"],
          "@measures": ["facts"],
          children: [{ "source.rdb": { "@kind": "view", "@view": "v_fact_labels" } }],
        },
      },
    ],
  },
};

describe("a @via dimension whose @of names the base of a subtype that redeclares the field", () => {
  test("shape, spec and view all use the redeclared field of the reached entity", async () => {
    const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(model))]);
    expect(errors).toEqual([]);
    const rep = root.objects().find((o) => o.name === "FactLabels")!;
    const shape = reportShape(rep, root);
    expect(shape.fields.find((f) => f.name === "label")!.subType).toBe("int");
    const spec = extractReportSpec(rep, root, { columnNamingStrategy: "snake_case" });
    const col = spec.columns.find((c) => c.fieldName === "label")!;
    expect(col.kind === "dimension" && col.ref.endsWith(".sub_label")).toBe(true);
    const sql = buildProjectionViews(root, { dialect: "postgres" }).find((v) => v.name === "v_fact_labels")!.sql!;
    expect(sql).toContain("sub_label");
    expect(sql).not.toContain("base_label");
  });
});
