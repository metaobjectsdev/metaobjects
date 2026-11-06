// #524: a `field.object @storage: flattened` is flat on the write surface (`shipToStreet`), so the
// generated form must bind the member keys the InsertSchema accepts, not a nested `shipTo` it strips.
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, type MetaObject } from "@metaobjectsdev/metadata";
import { renderFormFile } from "../src/templates/form-file.js";
import { makeRenderContext, buildPkMap, buildRelationMap } from "@metaobjectsdev/codegen-ts";

describe("generated form — flattened value object", () => {
  test("binds each member under its flat key and no nested path", async () => {
    const { root, errors } = await new MetaDataLoader().load([
      new InMemoryStringSource(
        JSON.stringify({
          "metadata.root": {
            package: "demo",
            children: [
              { "object.value": { name: "Address", children: [{ "field.string": { name: "street" } }, { "field.string": { name: "city" } }] } },
              { "object.entity": { name: "Shipment", children: [
                { "source.rdb": { "@table": "shipments" } },
                { "field.long": { name: "id" } },
                { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
                { "field.object": { name: "shipTo", "@objectRef": "Address", "@storage": "flattened" } },
              ] } },
            ],
          },
        }),
        { id: "shipment.json" },
      ),
    ]);
    expect(errors).toEqual([]);
    const shipment = root.objects().find((o) => o.name === "Shipment")! as MetaObject;
    const out = renderFormFile(
      shipment,
      makeRenderContext({
        dialect: "postgres", loadedRoot: root, outDir: "/x", dbImport: "../db", extStyle: "none",
        apiPrefix: "/api", pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
      }),
    );
    expect(out).toContain("form.input.shipToStreet");
    expect(out).toContain("form.input.shipToCity");
    expect(out).not.toMatch(/\bshipTo\b/);
  });
});
