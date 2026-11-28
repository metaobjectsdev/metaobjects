// The metamodel reference pages' data (FR-033 S3), held to the shared corpus.
//
// `coreMetamodelDocsPages` builds each page's template data from the registry vocabulary
// manifest and the embedded provider definitions. fixtures/metamodel-docs/data/ pins that
// data, the input every port's builder must reproduce before its template render is held to
// fixtures/metamodel-docs/expected/ (the codegen-ts metamodel-docs test renders the pages).

import { test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  coreMetamodelDocsPages,
  coreProviderDescriptions,
  METAMODEL_INDEX_PAGE_REF,
  METAMODEL_PROVIDERS_PAGE_REF,
  METAMODEL_TYPE_PAGE_REF,
} from "../src/metamodel-docs/index.js";

// test → metadata → packages → typescript → server → repo root.
const REPO_ROOT = join(import.meta.dir, "../../../../..");
const DATA_DIR = join(REPO_ROOT, "fixtures/metamodel-docs/data");

function listFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    const rel = prefix === "" ? name : `${prefix}/${name}`;
    if (statSync(abs).isDirectory()) out.push(...listFiles(abs, rel));
    else out.push(rel);
  }
  return out;
}

type Row = Record<string, unknown>;

function pageData(path: string): Row {
  const page = coreMetamodelDocsPages().find((p) => p.path === path);
  if (page === undefined) throw new Error(`no page ${path}`);
  return page.data;
}

function section(family: string, typeSubType: string): Row {
  const sections = pageData(`types/${family}.md`).sections as Row[];
  const s = sections.find((x) => x.typeSubType === typeSubType);
  if (s === undefined) throw new Error(`no section ${typeSubType}`);
  return s;
}

test("each page's data equals fixtures/metamodel-docs/data", () => {
  const pages = coreMetamodelDocsPages();
  expect(pages.map((p) => `${p.path}.json`).sort()).toEqual(listFiles(DATA_DIR));
  for (const page of pages) {
    const pinned = JSON.parse(readFileSync(join(DATA_DIR, `${page.path}.json`), "utf8"));
    expect(page.data).toEqual(pinned);
  }
});

test("pages come in output order, each naming its shared template", () => {
  const pages = coreMetamodelDocsPages();
  expect(pages[0]!.path).toBe("INDEX.md");
  expect(pages[0]!.template).toBe(METAMODEL_INDEX_PAGE_REF);
  expect(pages[1]!.path).toBe("providers.md");
  expect(pages[1]!.template).toBe(METAMODEL_PROVIDERS_PAGE_REF);
  const typePages = pages.slice(2);
  expect(typePages.every((p) => p.template === METAMODEL_TYPE_PAGE_REF)).toBe(true);
  const paths = typePages.map((p) => p.path);
  expect(paths).toEqual([...paths].sort());
});

test("ownership comes from the provider definitions: core owns, concerns contribute", () => {
  const currency = section("field", "field.currency");
  expect(currency.owner).toBe("metaobjects-core-types");
  const attrs = currency.attrs as Row[];
  const by = (name: string) => attrs.find((a) => a.name === name)!;
  expect(by("currency").provider).toBe("metaobjects-core-types");
  expect(by("currency").default).toBe("`USD`");
  expect(by("column").provider).toBe("metaobjects-db");
  expect(by("filterable").provider).toBe("metaobjects-ui");
  // index.lookup is registered by the core index definition.
  expect(section("index", "index.lookup").owner).toBe("metaobjects-core-types");
});

test("documentation attrs are listed once, on the providers page", () => {
  const providers = pageData("providers.md").providers as Row[];
  const doc = providers.find((p) => p.id === "metaobjects-documentation")!;
  expect(doc.universal).toContain("`@description`");
  const field = section("field", "field.string");
  expect((field.attrs as Row[]).some((a) => a.name === "description")).toBe(false);
});

test("templates/metamodel/provider-descriptions.json equals the core providers' descriptions", () => {
  const shipped = JSON.parse(
    readFileSync(join(REPO_ROOT, "templates/metamodel/provider-descriptions.json"), "utf8"),
  ) as Record<string, string>;
  expect(shipped).toEqual(Object.fromEntries(coreProviderDescriptions()));
});
