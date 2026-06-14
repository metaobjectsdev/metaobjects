// FR-033 S3 — metamodel doc-gen renderer tests.
//
// The renderer is a PURE, deterministic function: (composed registry +
// provenance map) → Map<relativePath, markdown>, byte-stable (everything
// sorted). These tests pin the key content (a known subtype description, an
// attr row carrying the right provider tag, the child rules) BEFORE the
// implementation, then a byte-gate (metamodel-docs-conformance.test.ts) locks
// the full output.

import { test, expect } from "bun:test";
import { composeRegistry } from "../src/provider.js";
import { coreProviders } from "../src/core-types.js";
import {
  buildMetamodelProvenance,
  renderMetamodelDocs,
} from "../src/metamodel-docs/index.js";

function docs(): Map<string, string> {
  const registry = composeRegistry(coreProviders);
  const provenance = buildMetamodelProvenance(registry);
  return renderMetamodelDocs(registry, provenance);
}

test("emits INDEX.md, providers.md and one page per type family", () => {
  const out = docs();
  expect(out.has("INDEX.md")).toBe(true);
  expect(out.has("providers.md")).toBe(true);
  // One page per type family present in the metamodel.
  for (const fam of [
    "field",
    "object",
    "attr",
    "validator",
    "identity",
    "relationship",
    "source",
    "origin",
    "template",
    "layout",
    "metadata",
  ]) {
    expect(out.has(`types/${fam}.md`)).toBe(true);
  }
});

test("every file carries a @generated DO-NOT-EDIT header naming the regen command", () => {
  const out = docs();
  for (const [path, content] of out) {
    expect(content.startsWith("<!--")).toBe(true);
    expect(content).toContain("@generated");
    expect(content).toContain("DO NOT EDIT");
    expect(content).toContain("meta docs --metamodel");
    expect(path).toBeTruthy();
  }
});

test("INDEX.md lists field.currency with its one-line description + anchor link", () => {
  const out = docs();
  const index = out.get("INDEX.md")!;
  // A row keyed by the full type.subType, linking to the type page anchor.
  expect(index).toContain("`field.currency`");
  expect(index).toContain("types/field.md#fieldcurrency");
  // The one-liner is the registry description (first sentence is enough to pin).
  expect(index).toContain("integer minor units");
});

test("INDEX.md is sorted by type.subType", () => {
  const out = docs();
  const index = out.get("INDEX.md")!;
  const order = [...index.matchAll(/\| `([a-z]+\.[A-Za-z]+)` \|/g)].map((m) => m[1]!);
  const sorted = [...order].sort();
  expect(order).toEqual(sorted);
  expect(order.length).toBeGreaterThan(10);
});

test("field.md documents field.currency with @currency (core), @filterable (ui), @column (db)", () => {
  const out = docs();
  const page = out.get("types/field.md")!;
  // The subtype heading + its description.
  expect(page).toContain("### field.currency");
  // The Attributes table header.
  expect(page).toContain(
    "| Attribute | Type | Required | Default | Allowed values | Provider | Description |",
  );
  // @currency is a core attr with a USD default.
  expect(page).toMatch(/\| `@currency` \| string \| no \| `USD` \|.*\| metaobjects-core-types \|/);
  // @filterable is a UI-provider attr.
  expect(page).toMatch(/\| `@filterable` \|.*\| metaobjects-ui \|/);
  // @column is a DB-provider attr.
  expect(page).toMatch(/\| `@column` \|.*\| metaobjects-db \|/);
});

test("field.base shows its allowed children (validator/view/origin wildcards) with cardinality", () => {
  const out = docs();
  const page = out.get("types/field.md")!;
  expect(page).toContain("### field.base");
  // The Allowed children section lists wildcard structural children, unbounded.
  expect(page).toMatch(/`validator\.\*`.*0\.\.\*/);
  expect(page).toMatch(/`view\.\*`.*0\.\.\*/);
});

test("array-valued attr renders its type with a [] suffix (e.g. @values on field.enum)", () => {
  const out = docs();
  const page = out.get("types/field.md")!;
  expect(page).toContain("### field.enum");
  // @values is a required string[] on field.enum.
  expect(page).toMatch(/\| `@values` \| string\[\] \| yes \|/);
});

test("documentation common attrs are mentioned once, not repeated per type", () => {
  const out = docs();
  const fieldPage = out.get("types/field.md")!;
  // @description (a universal common attr) must NOT appear as a per-subtype attr row.
  expect(fieldPage).not.toMatch(/\| `@description` \|/);
  // It IS documented on the providers page (documentation provider).
  const providers = out.get("providers.md")!;
  expect(providers).toContain("metaobjects-documentation");
  expect(providers).toContain("@description");
});

test("providers.md indexes all five concern providers with descriptions", () => {
  const out = docs();
  const providers = out.get("providers.md")!;
  for (const id of [
    "metaobjects-core-types",
    "metaobjects-db",
    "metaobjects-documentation",
    "metaobjects-prompt",
    "metaobjects-ui",
  ]) {
    expect(providers).toContain(id);
  }
});

test("provenance: core owns field.currency; db contributes @column; ui contributes @filterable", () => {
  const registry = composeRegistry(coreProviders);
  const p = buildMetamodelProvenance(registry);
  expect(p.ownerOfType("field", "currency")).toBe("metaobjects-core-types");
  expect(p.ownerOfAttr("field", "currency", "column")).toBe("metaobjects-db");
  expect(p.ownerOfAttr("field", "currency", "filterable")).toBe("metaobjects-ui");
  expect(p.ownerOfAttr("field", "currency", "currency")).toBe("metaobjects-core-types");
  // documentation common attrs are owned by the documentation provider.
  expect(p.ownerOfCommonAttr("description")).toBe("metaobjects-documentation");
});

test("output is deterministic (re-render is byte-identical)", () => {
  const a = docs();
  const b = docs();
  expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
  for (const [k, v] of a) {
    expect(b.get(k)).toBe(v);
  }
});
