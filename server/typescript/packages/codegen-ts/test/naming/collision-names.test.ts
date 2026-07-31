import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, resolveObjectRef, type MetaData } from "@metaobjectsdev/metadata";
import { assignEmittedNames, packageQualifiedName } from "../../src/naming/collision-names.js";

/** Multi-file (multi-package) load — one source per (package, children) pair,
 *  merged into a single root. Mirrors payload-codegen.test.ts's ADR-0044
 *  collision-naming fixtures (this module is the extracted pass-2 algorithm
 *  those tests exercise indirectly via generatePayloadInterfaces). */
async function loadMultiPackageRoot(files: { package: string; children: unknown[] }[]) {
  const sources = files.map(
    (f) => new InMemoryStringSource(JSON.stringify({ "metadata.root": { package: f.package, children: f.children } })),
  );
  const res = await new MetaDataLoader().load(sources);
  expect(res.errors).toEqual([]);
  return res.root;
}

/** Build a (resolutionKey -> node) closure map — the same shape
 *  payload-codegen's `collectClosure` produces — from a flat list of FQN
 *  `object.value` refs resolved against `root`. */
function closureOf(root: MetaData, refs: string[]): Map<string, MetaData> {
  const closure = new Map<string, MetaData>();
  for (const ref of refs) {
    const node = resolveObjectRef(root, ref, "").node;
    if (node) closure.set(node.resolutionKey(), node);
  }
  return closure;
}

describe("collision-names — packageQualifiedName", () => {
  test("a root-level (no package) node keeps its bare short name", () => {
    expect(packageQualifiedName("", "Note")).toBe("Note");
  });

  test("PascalCases each `::`-segment of the package, concatenated with the short name", () => {
    expect(packageQualifiedName("acme::alpha", "Note")).toBe("AcmeAlphaNote");
    expect(packageQualifiedName("acme::beta", "Note")).toBe("AcmeBetaNote");
  });
});

describe("collision-names — assignEmittedNames", () => {
  test("a unique bare name in the closure emits the bare name", async () => {
    const root = await loadMultiPackageRoot([
      {
        package: "acme::alpha",
        children: [
          { "object.value": { name: "Note", children: [{ "field.string": { name: "text", "@required": true } }] } },
        ],
      },
    ]);
    const closure = closureOf(root, ["acme::alpha::Note"]);
    const nameMap = assignEmittedNames(closure);
    expect(nameMap.get("acme::alpha::Note")).toBe("Note");
  });

  test("two same-bare-name FQNs both emit package-qualified names", async () => {
    const root = await loadMultiPackageRoot([
      {
        package: "acme::alpha",
        children: [
          { "object.value": { name: "Note", children: [{ "field.string": { name: "alphaText", "@required": true } }] } },
        ],
      },
      {
        package: "acme::beta",
        children: [
          { "object.value": { name: "Note", children: [{ "field.string": { name: "betaText", "@required": true } }] } },
        ],
      },
    ]);
    const closure = closureOf(root, ["acme::alpha::Note", "acme::beta::Note"]);
    const nameMap = assignEmittedNames(closure);
    expect(nameMap.get("acme::alpha::Note")).toBe("AcmeAlphaNote");
    expect(nameMap.get("acme::beta::Note")).toBe("AcmeBetaNote");
  });

  test("a still-colliding derived name FAILS LOUD with ERR_PAYLOAD_NAME_COLLISION (backstop)", async () => {
    // Pathological: "acme::alpha::Note" and "acmeAlpha::Note" both PascalCase-fold
    // to the SAME derived name "AcmeAlphaNote" — qualification cannot disambiguate.
    const root = await loadMultiPackageRoot([
      {
        package: "acme::alpha",
        children: [
          { "object.value": { name: "Note", children: [{ "field.string": { name: "a", "@required": true } }] } },
        ],
      },
      {
        package: "acmeAlpha",
        children: [
          { "object.value": { name: "Note", children: [{ "field.string": { name: "b", "@required": true } }] } },
        ],
      },
    ]);
    const closure = closureOf(root, ["acme::alpha::Note", "acmeAlpha::Note"]);
    expect(() => assignEmittedNames(closure)).toThrow(
      /ERR_PAYLOAD_NAME_COLLISION.*"AcmeAlphaNote".*derives from both.*"acme::alpha::Note".*"acmeAlpha::Note"/,
    );
  });
});
