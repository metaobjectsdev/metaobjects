// ApiModel IR + builder (api-docs Task 1).
//
// buildApiModel derives — from loaded metadata — the API an adopter's codegen
// produces, accurate BY CONSTRUCTION because it reuses the real generators' own
// naming/signature logic. These tests pin the EXACT symbol names the real
// generators emit (verified against queries.ts / routes-file.ts / extractor.ts /
// render-helper.ts), prove the queries SKIP rules (no-PK / value object), and
// prove the template format/kind gating for the extractor + render symbols.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildApiModel, type ApiModel, type ApiUnitDoc } from "../src/generators/api-model.js";

async function loadRoot(children: unknown[]) {
  const res = await new MetaDataLoader().load([
    new InMemoryStringSource(
      JSON.stringify({ "metadata.root": { package: "acme::shop", children } }),
      { id: "meta.json", format: "json" },
    ),
  ]);
  expect(res.errors).toEqual([]);
  return res.root;
}

// An entity WITH a PK + fields + a field.enum + a writable rdb source (so it
// flows through the full CRUD code path).
const PRODUCT = {
  "object.entity": {
    name: "Product",
    children: [
      { "field.long": { name: "id" } },
      { "field.string": { name: "name" } },
      { "field.enum": { name: "status", "@values": ["active", "discontinued"] } },
      { "identity.primary": { "@fields": "id", "@generation": "increment" } },
      { "source.rdb": { "@table": "products" } },
    ],
  },
};

// A value object — has NO primary identity. The queries generator skips it
// entirely (no findById/create/update/delete/list), so the ApiModel must too.
const STAMP = {
  "object.value": {
    name: "Stamp",
    children: [{ "field.string": { name: "label" } }],
  },
};

// A template.output (document) over a payload VO, format json so the extractor
// API exists; render kind=document → render<Name> returns string.
const SUMMARY_VO = {
  "object.value": {
    name: "SummaryVO",
    children: [{ "field.string": { name: "headline", "@required": true } }],
  },
};
const SUMMARY_DOC = {
  "template.output": {
    name: "ProductSummary",
    "@kind": "document",
    "@payloadRef": "SummaryVO",
    "@textRef": "out/product-summary",
    "@format": "json",
  },
};

// An email template.output → render<Name> returns EmailDocument.
const WELCOME_EMAIL = {
  "template.output": {
    name: "WelcomeEmail",
    "@kind": "email",
    "@payloadRef": "SummaryVO",
    "@subjectRef": "emails/welcome.subject",
    "@htmlBodyRef": "emails/welcome.html",
    "@format": "json",
  },
};

function unit(model: ApiModel, node: string): ApiUnitDoc {
  const u = model.units.find((x) => x.node === node);
  if (!u) throw new Error(`no ApiUnitDoc for node "${node}"`);
  return u;
}
function names(model: ApiModel, node: string): string[] {
  return unit(model, node).symbols.map((s) => s.name);
}

describe("buildApiModel — entity with a PK", () => {
  test("emits model + the 5 real data-access helper names verbatim", async () => {
    const root = await loadRoot([PRODUCT]);
    const model = buildApiModel(root, { loadedRoot: root });

    const u = unit(model, "Product");
    expect(u.nodeKind).toBe("entity");

    // The model symbol is the bare entity name (entity-file emits `Product`).
    const modelSyms = u.symbols.filter((s) => s.kind === "model");
    expect(modelSyms.map((s) => s.name)).toEqual(["Product"]);

    // Data-access names must match queries.ts EXACTLY: find<E>ById, list<Plural>,
    // create<E>, update<E> (NOT updateById), delete<E>ById.
    const da = u.symbols.filter((s) => s.kind === "data-access").map((s) => s.name);
    expect(da).toEqual([
      "findProductById",
      "listProducts",
      "createProduct",
      "updateProduct",
      "deleteProductById",
    ]);
  });

  test("emits the insert + update validation schema names verbatim", async () => {
    const root = await loadRoot([PRODUCT]);
    const model = buildApiModel(root, { loadedRoot: root });
    const validation = unit(model, "Product")
      .symbols.filter((s) => s.kind === "validation")
      .map((s) => s.name);
    expect(validation).toEqual(["ProductInsertSchema", "ProductUpdateSchema"]);
  });

  test("emits a REST symbol per CRUD verb (method + path), keyed off the entity $path", async () => {
    const root = await loadRoot([PRODUCT]);
    const model = buildApiModel(root, { loadedRoot: root });
    const rest = unit(model, "Product").symbols.filter((s) => s.kind === "rest");
    // The routes generator mounts the 5 standard verbs. Assert the verb+path set.
    const methodsPaths = rest.map((s) => s.signature).sort();
    expect(methodsPaths).toEqual(
      [
        "DELETE /products/:id",
        "GET /products",
        "GET /products/:id",
        "PATCH /products/:id",
        "POST /products",
      ].sort(),
    );
  });
});

describe("buildApiModel — SKIP rules", () => {
  test("a value object (no primary identity) gets NO data-access / REST / validation symbols", async () => {
    const root = await loadRoot([PRODUCT, STAMP]);
    const model = buildApiModel(root, { loadedRoot: root });

    // The queries + routes generators filter object.value out entirely. So the
    // Stamp unit, if present at all, must carry ONLY a model symbol.
    const stamp = model.units.find((u) => u.node === "Stamp");
    if (stamp) {
      const kinds = new Set(stamp.symbols.map((s) => s.kind));
      expect(kinds.has("data-access")).toBe(false);
      expect(kinds.has("rest")).toBe(false);
      expect(kinds.has("validation")).toBe(false);
    }
    // And it definitely must not invent findStampById etc.
    const allStampNames = stamp?.symbols.map((s) => s.name) ?? [];
    expect(allStampNames).not.toContain("findStampById");
    expect(allStampNames).not.toContain("createStamp");
  });
});

describe("buildApiModel — template.output extractor + render symbols", () => {
  test("document template emits extract<Name>/extractLenient<Name> + render<Name>:string", async () => {
    const root = await loadRoot([SUMMARY_VO, SUMMARY_DOC]);
    const model = buildApiModel(root, { loadedRoot: root });

    const u = unit(model, "ProductSummary");
    expect(u.nodeKind).toBe("template");

    const extractors = u.symbols.filter((s) => s.kind === "extractor").map((s) => s.name);
    expect(extractors).toEqual(["extractProductSummary", "extractLenientProductSummary"]);

    const renders = u.symbols.filter((s) => s.kind === "render");
    expect(renders.map((s) => s.name)).toEqual(["renderProductSummary"]);
    // document kind → returns a string
    expect(renders[0]!.returns).toBe("string");
  });

  test("email template render<Name> returns EmailDocument", async () => {
    const root = await loadRoot([SUMMARY_VO, WELCOME_EMAIL]);
    const model = buildApiModel(root, { loadedRoot: root });

    const renders = unit(model, "WelcomeEmail").symbols.filter((s) => s.kind === "render");
    expect(renders.map((s) => s.name)).toEqual(["renderWelcomeEmail"]);
    expect(renders[0]!.returns).toBe("EmailDocument");
  });

  test("extractor symbols are gated on json/xml format (a text template has none)", async () => {
    const TEXT_DOC = {
      "template.output": {
        name: "PlainNote",
        "@kind": "document",
        "@payloadRef": "SummaryVO",
        "@textRef": "out/note",
        "@format": "text",
      },
    };
    const root = await loadRoot([SUMMARY_VO, TEXT_DOC]);
    const model = buildApiModel(root, { loadedRoot: root });
    const u = unit(model, "PlainNote");
    const extractors = u.symbols.filter((s) => s.kind === "extractor");
    expect(extractors).toEqual([]);
    // render still present (render works for any format)
    expect(u.symbols.filter((s) => s.kind === "render").map((s) => s.name)).toEqual([
      "renderPlainNote",
    ]);
  });
});

describe("buildApiModel — no invented names", () => {
  test("every entity data-access name is one the queries generator actually emits", async () => {
    const root = await loadRoot([PRODUCT]);
    const model = buildApiModel(root, { loadedRoot: root });
    // The full closed set of CRUD spellings the queries generator emits for an
    // entity named Product. Any data-access name outside this set is invented.
    const allowed = new Set([
      "findProductById",
      "listProducts",
      "createProduct",
      "updateProduct",
      "deleteProductById",
    ]);
    for (const s of unit(model, "Product").symbols.filter((x) => x.kind === "data-access")) {
      expect(allowed.has(s.name)).toBe(true);
    }
  });
});
