// SP-G Registry Conformance — TS reference assertion.
//
// Asserts that the manifest emitted from the assembled core TypeRegistry is
// byte-identical to the committed single-source canonical
// fixtures/registry-conformance/expected-registry.json. TS is the reference
// port: this pins both the canonical AND the exact serialization the other four
// ports (C#, Java, Kotlin, Python) must byte-match.
//
// A drift here means either the TS registry changed (the canonical needs
// regenerating + the other ports reconciling) or the emitter changed. See
// fixtures/registry-conformance/README.md for the in/out boundary + the
// fix-at-source-on-divergence rule.

import { test, expect } from "bun:test";
import { join } from "node:path";
import { composeRegistry } from "../src/provider.js";
import { coreProviders } from "../src/core-types.js";
import { buildRegistryManifest, emitRegistryManifest, classifyPerTypeAttr } from "../src/registry-manifest.js";
import { EXCLUDED_PER_TYPE_ATTRS, ExclusionReason } from "../src/registry-manifest-exclusions.js";

// The canonical lives at the REPO ROOT — five `../` levels up from test/
// (test → metadata → packages → typescript → server → repo-root).
const CANONICAL = join(
  import.meta.dir,
  "../../../../../fixtures/registry-conformance/expected-registry.json",
);

/** Normalize line endings so a CRLF checkout cannot fail a content-equal manifest. */
function normalizeNewlines(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

test("TS registry manifest matches the committed canonical", async () => {
  const registry = composeRegistry(coreProviders);
  const emitted = normalizeNewlines(emitRegistryManifest(registry));
  const committed = normalizeNewlines(await Bun.file(CANONICAL).text());

  if (emitted !== committed) {
    throw new Error(
      "TS registry drifted from the committed manifest — regenerate " +
        "(and reconcile the other ports) or fix the registration.",
    );
  }
  expect(emitted).toBe(committed);
});

// SP-G Phase1 Units2-3 — the emitter exclusions (structural keywords, the
// metadata.base anchor, the generic view.* controls) are documented, principled,
// and uniform across all four ports. These assert the contract directly.
test("manifest excludes structural-keyword/commonAttr per-type attrs (isArray/isAbstract/description)", () => {
  const manifest = buildRegistryManifest(composeRegistry(coreProviders));
  for (const t of manifest.types) {
    for (const a of t.attrs) {
      expect(["isArray", "isAbstract", "description"]).not.toContain(a.name);
    }
  }
  // `description` is still carried in the commonAttrs block.
  expect(manifest.commonAttrs.map((a) => a.name)).toContain("description");
});

test("manifest excludes the metadata.base inheritance anchor (keeps metadata.root)", () => {
  const manifest = buildRegistryManifest(composeRegistry(coreProviders));
  const metadataSubTypes = manifest.types
    .filter((t) => t.type === "metadata")
    .map((t) => t.subType);
  expect(metadataSubTypes).not.toContain("base");
  expect(metadataSubTypes).toContain("root");
});

test("manifest cuts the 11 generic view.* controls, keeps view.base + view.currency", () => {
  const manifest = buildRegistryManifest(composeRegistry(coreProviders));
  const viewSubTypes = manifest.types
    .filter((t) => t.type === "view")
    .map((t) => t.subType)
    .sort();
  expect(viewSubTypes).toEqual(["base", "currency"]);
});

// Wave 3b — the in/out boundary is an EXPLICIT classification (a reason category
// per carve-out), not a bare name-match. These assert the classification is
// total and self-documenting: every per-type attr is either INCLUDED (logical)
// or carved out with a declared ExclusionReason — there is no silent default.
test("every registered per-type attr is explicitly classified (no silent default-include)", () => {
  const registry = composeRegistry(coreProviders);
  for (const typeId of registry.allTypes()) {
    for (const attr of registry.attrsOf(typeId.type, typeId.subType)) {
      const c = classifyPerTypeAttr(attr.name);
      // Total function: either INCLUDED or one of the declared reason categories.
      const isReason = Object.values(ExclusionReason).includes(c as ExclusionReason);
      expect(c === "included" || isReason).toBe(true);
    }
  }
});

test("every carved-out per-type attr name carries a declared ExclusionReason", () => {
  const validReasons = new Set(Object.values(ExclusionReason));
  for (const [name, reason] of EXCLUDED_PER_TYPE_ATTRS) {
    expect(validReasons.has(reason)).toBe(true);
    expect(classifyPerTypeAttr(name)).toBe(reason);
  }
  // The structural/OO-shape keywords are classified StructuralKeyword; the
  // ADR-0001/0005 bindings NativeBinding; the per-type description CommonAttrDup.
  expect(classifyPerTypeAttr("extends")).toBe(ExclusionReason.StructuralKeyword);
  expect(classifyPerTypeAttr("isArray")).toBe(ExclusionReason.StructuralKeyword);
  expect(classifyPerTypeAttr("object")).toBe(ExclusionReason.NativeBinding);
  expect(classifyPerTypeAttr("objectAdapter")).toBe(ExclusionReason.NativeBinding);
  expect(classifyPerTypeAttr("description")).toBe(ExclusionReason.CommonAttrDup);
  // A genuinely logical attr is INCLUDED.
  expect(classifyPerTypeAttr("column")).toBe("included");
  expect(classifyPerTypeAttr("maxLength")).toBe("included");
});

// FR-033 Task 5 — the manifest now carries the documentation surface
// (type/attr `description` + optional `rules`/`example`/`whenToUse`) AND the
// structural constraint graph (`children` / `parents` / cardinality). These
// assert the additive shape is present.
test("manifest carries a description on every type, attr, and commonAttr (coverage gate)", () => {
  const manifest = buildRegistryManifest(composeRegistry(coreProviders));
  // A future entry with no description must fail CI (mirrors ADR-0023 strict
  // provenance — descriptions are not optional on the documentation surface).
  for (const t of manifest.types) {
    expect(typeof t.description).toBe("string");
    expect(t.description.length).toBeGreaterThan(0);
    for (const a of t.attrs) {
      expect(typeof a.description).toBe("string");
      expect(a.description.length).toBeGreaterThan(0);
    }
  }
  for (const c of manifest.commonAttrs) {
    expect(typeof c.description).toBe("string");
    expect(c.description.length).toBeGreaterThan(0);
  }
});

test("manifest emits the structural constraint graph (children) per type", () => {
  const manifest = buildRegistryManifest(composeRegistry(coreProviders));
  // Every type carries a `children` array (possibly empty for leaf types).
  for (const t of manifest.types) {
    expect(Array.isArray(t.children)).toBe(true);
  }
  // object.entity is a stable example: it admits field/identity/relationship/
  // validator/layout/source/attr/template children (8 wildcard structural rules).
  const objectEntity = manifest.types.find(
    (t) => t.type === "object" && t.subType === "entity",
  );
  expect(objectEntity).toBeDefined();
  expect(objectEntity!.children.length).toBeGreaterThan(0);
  const childTypes = objectEntity!.children.map((c) => c.childType);
  expect(childTypes).toContain("field");
  expect(childTypes).toContain("identity");
  expect(childTypes).toContain("source");
  // children are canonically sorted by (childType, childSubTypeKey, childName).
  const keys = objectEntity!.children.map(
    (c) =>
      `${c.childType}.${Array.isArray(c.childSubType) ? c.childSubType.join(",") : c.childSubType}.${c.childName}`,
  );
  expect(keys).toEqual([...keys].sort());
});
