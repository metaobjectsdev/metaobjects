// FR-033 S3 — the metamodel-docs generator.
//
// The pages are the shared templates/metamodel/ Mustache set rendered over the page data
// `coreMetamodelDocsPages` builds. The byte gate holds every page to
// fixtures/metamodel-docs/expected/, the corpus every port renders; the content tests
// below pin what the pages must say (a subtype description, an attr row with the right
// provider tag, the child rules) so a regenerated corpus cannot quietly lose it.

import { test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { metamodelDocsFile } from "../src/generators/metamodel-docs-file.js";
import type { GenContext } from "../src/generator.js";

// The fixture lives at the REPO ROOT (test → codegen-ts → packages → typescript → server → root).
const EXPECTED_DIR = join(import.meta.dir, "../../../../../fixtures/metamodel-docs/expected");

/** The pages as the generator writes them, keyed by their path under the target root. */
async function docs(): Promise<Map<string, string>> {
  // No project templates directory: the shipped templates render.
  const ctx = { inputRoot: join(import.meta.dir, "no-such-project") } as unknown as GenContext;
  const files = await metamodelDocsFile({ subDir: "" }).generate(ctx);
  return new Map(files.map((f) => [f.path, f.content]));
}

/** Every expected file, relative to EXPECTED_DIR, sorted. */
function listExpected(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    const rel = prefix === "" ? name : `${prefix}/${name}`;
    if (statSync(abs).isDirectory()) out.push(...listExpected(abs, rel));
    else out.push(rel);
  }
  return out;
}

test("the pages match fixtures/metamodel-docs/expected byte for byte", async () => {
  const out = await docs();
  const expected = listExpected(EXPECTED_DIR);
  expect([...out.keys()].sort()).toEqual(expected);
  for (const rel of expected) {
    const committed = readFileSync(join(EXPECTED_DIR, rel), "utf8").replace(/\r\n/g, "\n");
    if (out.get(rel) !== committed) {
      throw new Error(
        `metamodel docs drifted for "${rel}": regenerate with \`bun run scripts/regen-metamodel-docs.ts\` ` +
          `(a vocabulary, description or template change must regenerate the corpus).`,
      );
    }
  }
});

test("emits INDEX.md, providers.md and one page per type family", async () => {
  const out = await docs();
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

test("every file carries a @generated DO-NOT-EDIT header naming the regen command", async () => {
  const out = await docs();
  for (const [path, content] of out) {
    expect(content.startsWith("<!--")).toBe(true);
    expect(content).toContain("@generated");
    expect(content).toContain("DO NOT EDIT");
    expect(content).toContain("Regenerate with your port's gen command (the metamodel-docs generator)");
    expect(path).toBeTruthy();
  }
});

test("INDEX.md lists field.currency with its one-line description + anchor link", async () => {
  const out = await docs();
  const index = out.get("INDEX.md")!;
  // A row keyed by the full type.subType, linking to the type page anchor.
  expect(index).toContain("`field.currency`");
  expect(index).toContain("types/field.md#fieldcurrency");
  // The one-liner is the registry description (first sentence is enough to pin).
  expect(index).toContain("integer minor units");
});

test("INDEX.md is sorted by type.subType", async () => {
  const out = await docs();
  const index = out.get("INDEX.md")!;
  const order = [...index.matchAll(/\| `([a-z]+\.[A-Za-z]+)` \|/g)].map((m) => m[1]!);
  const sorted = [...order].sort();
  expect(order).toEqual(sorted);
  expect(order.length).toBeGreaterThan(10);
});

test("field.md documents field.currency with @currency (core), @filterable (ui), @column (db)", async () => {
  const out = await docs();
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

test("field.base shows its allowed children (validator/view/origin wildcards) with cardinality", async () => {
  const out = await docs();
  const page = out.get("types/field.md")!;
  expect(page).toContain("### field.base");
  // The Allowed children section lists wildcard structural children, unbounded.
  expect(page).toMatch(/`validator\.\*`.*0\.\.\*/);
  expect(page).toMatch(/`view\.\*`.*0\.\.\*/);
});

test("array-valued attr renders its type with a [] suffix (e.g. @values on field.enum)", async () => {
  const out = await docs();
  const page = out.get("types/field.md")!;
  expect(page).toContain("### field.enum");
  // @values is a required string[] on field.enum.
  expect(page).toMatch(/\| `@values` \| string\[\] \| yes \|/);
});

test("documentation common attrs are mentioned once, not repeated per type", async () => {
  const out = await docs();
  const fieldPage = out.get("types/field.md")!;
  // @description (a universal common attr) must NOT appear as a per-subtype attr row.
  expect(fieldPage).not.toMatch(/\| `@description` \|/);
  // It IS documented on the providers page (documentation provider).
  const providers = out.get("providers.md")!;
  expect(providers).toContain("metaobjects-documentation");
  expect(providers).toContain("@description");
});

test("providers.md indexes every concern provider and pack with descriptions", async () => {
  const out = await docs();
  const providers = out.get("providers.md")!;
  for (const id of [
    "metaobjects-core-types",
    "metaobjects-db",
    "metaobjects-documentation",
    "metaobjects-prompt",
    "metaobjects-ui",
    "metaobjects-ui-web",
    "metaobjects-rules",
    "metaobjects-view-expressions",
  ]) {
    expect(providers).toContain(id);
  }
});

test("providers.md 'Owns' and INDEX carry the kind-1 view.* controls, marked on their pages", async () => {
  const out = await docs();
  const providers = out.get("providers.md")!;
  // The generic view.* controls are cross-port vocabulary only TypeScript implements so
  // far: IN the manifest, so the docs cover them like any other subtype.
  const ownsMatch = providers.match(/\*\*Owns \(registers\):\*\* (.+)/);
  expect(ownsMatch).not.toBeNull();
  const owns = ownsMatch![1];
  for (const control of ["view.base", "view.currency", "view.text", "view.textarea", "view.image", "view.web"]) {
    expect(owns).toContain(`\`${control}\``);
  }
  const index = out.get("INDEX.md")!;
  expect(index).toContain("`view.text`");
  expect(index).toContain("`view.currency`");
  const viewPage = [...out.entries()].find(([k]) => k.includes("view"))![1];
  expect(viewPage).toContain("**Implemented in:** typescript so far");
});

test("ownership: core owns index.lookup and field.currency; concern providers tag their attrs", async () => {
  const out = await docs();
  const indexPage = out.get("types/index.md")!;
  expect(indexPage).toContain("### index.lookup\n\nA non-unique lookup index");
  expect(indexPage).toMatch(/### index\.lookup[\s\S]*?\*\*Owning provider:\*\* metaobjects-core-types/);
  expect(indexPage).toMatch(/\| `@fields` \|.*\| metaobjects-core-types \|/);
  const fieldPage = out.get("types/field.md")!;
  expect(fieldPage).toMatch(/### field\.currency[\s\S]*?\*\*Owning provider:\*\* metaobjects-core-types/);
});

test("output is deterministic (re-render is byte-identical)", async () => {
  const a = await docs();
  const b = await docs();
  expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
  for (const [k, v] of a) {
    expect(b.get(k)).toBe(v);
  }
});
