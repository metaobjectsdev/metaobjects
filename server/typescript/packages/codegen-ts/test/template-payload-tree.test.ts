import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildEnrichedPayloadTree } from "../src/generators/template-payload-tree.js";

// Multi-file (multi-package) load — one InMemoryStringSource per doc, merged into a
// single root (mirrors fixtures/conformance/loader-same-name-distinct-packages).
async function loadRootFromDocs(...docs: unknown[]) {
  const res = await new MetaDataLoader().load(docs.map((d) => new InMemoryStringSource(JSON.stringify(d))));
  expect(res.errors).toEqual([]);
  return res.root;
}

describe("buildEnrichedPayloadTree — docs annotator payload walk", () => {
  // ADR-0041: two packages each declare an object.value `Note` (alpha: alphaText, beta:
  // betaText), and `Digest` references BOTH by FULLY-QUALIFIED @objectRef. Pre-fix the
  // annotator did stripPackage(ref) then a bare root.findObject, binding BOTH refs to
  // whichever Note loaded first — so the doc node for fromBeta showed alpha's field.
  // FQN-exact resolution binds each ref to its own package.
  test("FQN nested @objectRef binds the exact package across a cross-package short-name collision", async () => {
    const root = await loadRootFromDocs(
      { "metadata.root": { package: "acme::alpha", children: [
        { "object.value": { name: "Note", children: [{ "field.string": { name: "alphaText" } }] } } ] } },
      { "metadata.root": { package: "acme::beta", children: [
        { "object.value": { name: "Note", children: [{ "field.string": { name: "betaText" } }] } } ] } },
      { "metadata.root": { package: "acme::app", children: [
        { "object.value": { name: "Digest", children: [
          { "field.object": { name: "fromAlpha", "@objectRef": "acme::alpha::Note" } },
          { "field.object": { name: "fromBeta", "@objectRef": "acme::beta::Note" } } ] } } ] } },
    );
    const tree = buildEnrichedPayloadTree(root, "Digest", "acme::app");
    const alpha = tree.find((n) => n.name === "fromAlpha");
    const beta = tree.find((n) => n.name === "fromBeta");
    // The inner field name comes from the correctly-bound VO (pre-fix both were alphaText).
    expect(alpha?.fields?.map((f) => f.name)).toEqual(["alphaText"]);
    expect(beta?.fields?.map((f) => f.name)).toEqual(["betaText"]);
  });
});
