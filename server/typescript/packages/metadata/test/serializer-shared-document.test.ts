import { describe, expect, test } from "bun:test";
import { MetaDataLoader, serializeSharedDocument, packageOfResolutionKey } from "../src/index.js";

// Address declares `city` before `street`: a shared document keeps each node's
// AUTHORED child order (own-layer form — only top-level nodes are sorted), and the
// pinned corpus artifact below lists them in that order.
const LIB = JSON.stringify({ "metadata.root": { package: "acme::common", children: [
  { "object.entity": { name: "Customer", children: [
    { "source.rdb": { "@table": "customers" } }, { "field.long": { name: "id" } },
    { "field.string": { name: "email", "@maxLength": 120 } },
    { "identity.primary": { name: "pk", "@fields": ["id"] } } ] } },
  { "object.entity": { name: "Audited", abstract: true, children: [ { "field.timestamp": { name: "createdAt" } } ] } },
  { "object.value": { name: "Address", children: [ { "field.string": { name: "city" } }, { "field.string": { name: "street" } } ] } },
]}});

describe("serializeSharedDocument", () => {
  test("packageOfResolutionKey", () => {
    expect(packageOfResolutionKey("acme::common::Customer")).toBe("acme::common");
    expect(packageOfResolutionKey("Customer")).toBe("");
  });
  test("emits nodes sorted by resolution key with an explicit package and no root package", async () => {
    const { root, errors } = await MetaDataLoader.fromString(LIB, "json");
    expect(errors).toEqual([]);
    const out = serializeSharedDocument(root.objects());
    const doc = JSON.parse(out) as { "metadata.root": { package?: string; children: Record<string, { name: string; package: string }>[] } };
    expect(doc["metadata.root"].package).toBeUndefined();
    const names = doc["metadata.root"].children.map((c) => Object.values(c)[0]!.name);
    expect(names).toEqual(["Address", "Audited", "Customer"]);
    for (const c of doc["metadata.root"].children) expect(Object.values(c)[0]!.package).toBe("acme::common");
    // body key order: name, package, then the rest
    expect(Object.keys(Object.values(doc["metadata.root"].children[1]!)[0]!)).toEqual(["name", "package", "abstract", "children"]);
    expect(out.endsWith("\n")).toBe(true);
    expect(out).toBe(await Bun.file(`${import.meta.dir}/../../../../../fixtures/dependency-conformance/artifacts/acme-common-v1.json`).text());
  });
  test("a re-load of the document yields the same resolution keys", async () => {
    const { root } = await MetaDataLoader.fromString(LIB, "json");
    const again = await MetaDataLoader.fromString(serializeSharedDocument(root.objects()), "json");
    expect(again.errors).toEqual([]);
    expect(again.root.objects().map((o) => o.resolutionKey()).sort()).toEqual(["acme::common::Address", "acme::common::Audited", "acme::common::Customer"]);
  });
  test("a root-level node (empty package) is refused", async () => {
    const { root } = await MetaDataLoader.fromString(JSON.stringify({ "metadata.root": { children: [ { "object.value": { name: "Bare" } } ] } }), "json");
    expect(() => serializeSharedDocument(root.objects())).toThrow(/package/);
  });
});
