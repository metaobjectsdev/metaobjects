// ApiModel IR + builder (api-docs Task 1).
//
// buildApiModel derives — from loaded metadata — the API an adopter's codegen
// produces, accurate BY CONSTRUCTION because it reuses the real generators' own
// naming/signature logic. These tests pin the EXACT symbol names the real
// generators emit (verified against queries.ts / routes-file.ts / extractor.ts /
// render-helper.ts), prove the queries SKIP rules (value object / TPH subtype /
// @emitRoutes:false), and prove the template format/kind gating for the
// extractor + render symbols.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildApiModel, type ApiModel, type ApiUnitDoc } from "../src/generators/api-model.js";
import { TPH_POLYMORPHIC_VERBS } from "../src/routes-expose.js";

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

// A TPH discriminator base (@discriminator) + two subtypes (@discriminatorValue).
// The subtypes get NO standalone queries/routes/validation file — their CRUD
// surface lives in the base's polymorphic file — so the ApiModel must NOT invent
// per-subtype find<Sub>ById/create<Sub>/REST/validation symbols. A TPH subtype
// contributes ONLY a model symbol, exactly like a value object.
const AUTH_TPH = [
  {
    "object.entity": {
      name: "Auth",
      "@discriminator": "type",
      children: [
        { "source.rdb": { "@table": "auths" } },
        { "field.enum": { name: "type", "@values": ["Bridge", "Copay"] } },
        { "field.long": { name: "id" } },
        { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } },
      ],
    },
  },
  {
    "object.entity": {
      name: "BridgeAuth",
      extends: "Auth",
      "@discriminatorValue": "Bridge",
      children: [{ "field.int": { name: "quantity" } }],
    },
  },
];

// An entity carrying the RETIRED `@emitRoutes: false` — deliberately, so the attribute's
// inertness is pinned by a real carrier rather than by the absence of an assertion. It was
// never registered metamodel vocabulary: the strict loader `meta verify` runs rejects it
// with ERR_UNKNOWN_ATTR, while the non-strict loader `meta gen` runs accepts it and the
// routes generator used to honour it. Nothing reads it now, so this entity is documented
// exactly like any other queryable one.
const STALE_EMIT_ROUTES = {
  "object.entity": {
    name: "Ledger",
    "@emitRoutes": false,
    children: [
      { "field.long": { name: "id" } },
      { "field.string": { name: "memo" } },
      { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } },
      { "source.rdb": { "@table": "ledgers" } },
    ],
  },
};

// An entity WITH a PK + fields + a field.enum + a writable rdb source (so it
// flows through the full CRUD code path).
const PRODUCT = {
  "object.entity": {
    name: "Product",
    children: [
      { "field.long": { name: "id" } },
      { "field.string": { name: "name" } },
      { "field.enum": { name: "status", "@values": ["active", "discontinued"] } },
      { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } },
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

  test("the documented endpoint carries the project's apiPrefix", async () => {
    // Every generated route is mounted inside `fastify.register(…, { prefix: apiPrefix })`,
    // so the prefix is part of the address. The builder documented the un-prefixed path,
    // which made the API page — whose stated contract is that its paths "match the
    // generated routes exactly" — wrong for every project that configures one.
    const root = await loadRoot([PRODUCT]);
    const model = buildApiModel(root, { loadedRoot: root, apiPrefix: "/api" });
    const rest = unit(model, "Product").symbols.filter((s) => s.kind === "rest");
    expect(rest.map((s) => s.signature).sort()).toEqual(
      [
        "DELETE /api/products/:id",
        "GET /api/products",
        "GET /api/products/:id",
        "PATCH /api/products/:id",
        "POST /api/products",
      ].sort(),
    );
    // ...and absent, the paths are unchanged — the default is "" and stays byte-identical.
    const bare = buildApiModel(root, { loadedRoot: root });
    expect(unit(bare, "Product").symbols.filter((s) => s.kind === "rest")
      .map((s) => s.signature).sort())
      .toEqual(rest.map((s) => s.signature.replace("/api", "")).sort());
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

  test("a TPH subtype gets ONLY a model symbol (its CRUD lives in the base's polymorphic file)", async () => {
    const root = await loadRoot([...AUTH_TPH]);
    const model = buildApiModel(root, { loadedRoot: root });

    // The queries + routes generators skip TPH subtypes (isTphSubtype), so the
    // BridgeAuth unit must carry ONLY a model symbol — no per-subtype CRUD,
    // routes, or validation.
    const sub = unit(model, "BridgeAuth");
    expect(sub.symbols.map((s) => s.kind)).toEqual(["model"]);

    const subNames = sub.symbols.map((s) => s.name);
    // None of the invented per-subtype symbols (no generator emits these).
    for (const invented of [
      "findBridgeAuthById",
      "listBridgeAuths",
      "createBridgeAuth",
      "updateBridgeAuth",
      "deleteBridgeAuthById",
      "BridgeAuthInsertSchema",
      "BridgeAuthUpdateSchema",
    ]) {
      expect(subNames).not.toContain(invented);
    }
    const kinds = new Set(sub.symbols.map((s) => s.kind));
    expect(kinds.has("data-access")).toBe(false);
    expect(kinds.has("rest")).toBe(false);
    expect(kinds.has("validation")).toBe(false);

    // The base (it carries @discriminator but no @discriminatorValue) is NOT a
    // TPH subtype, so it stays a normal queryable entity.
    const base = unit(model, "Auth");
    expect(new Set(base.symbols.map((s) => s.kind)).has("data-access")).toBe(true);
  });

  test("@emitRoutes is INERT — a stale one no longer suppresses REST symbols", async () => {
    const root = await loadRoot([STALE_EMIT_ROUTES]);
    const model = buildApiModel(root, { loadedRoot: root });

    const u = unit(model, "Ledger");
    // The attribute really is in this model (the non-strict loader accepts it) …
    expect(root.objects().find((o) => o.name === "Ledger")!.hasAttr("emitRoutes")).toBe(true);
    const kinds = new Set(u.symbols.map((s) => s.kind));
    // … and REST is now documented, because the routes generator emits it. This builder
    // mirrors the routes generator's filter (hasAnyRdbSource && !isTphSubtype ==
    // isQueryable); the old @emitRoutes read was a fifth gate that mirrored nothing.
    expect(kinds.has("rest")).toBe(true);
    expect(u.symbols.filter((s) => s.kind === "rest").length).toBeGreaterThan(0);
    // The other kinds are unchanged, which is what makes this a deletion and not a rewrite.
    expect(kinds.has("data-access")).toBe(true);
    expect(kinds.has("validation")).toBe(true);
    expect(kinds.has("model")).toBe(true);
  });
});

// ADR-0052: a responding prompt owns the inbound half. @payloadRef types the
// REQUEST it renders; @responseRef types the REPLY it parses — deliberately two
// different value-objects here, so a unit that documents the wrong one is visible.
const REQUEST_VO = {
  "object.value": {
    name: "AskVO",
    children: [{ "field.string": { name: "question", "@required": true } }],
  },
};
const SUMMARY_PROMPT = {
  "template.prompt": {
    name: "SummarizeProduct",
    "@payloadRef": "AskVO",
    "@responseRef": "SummaryVO",
    "@textRef": "p/summarize",
    "@format": "text",
  },
};

describe("buildApiModel — template.output documents its RENDER only (ADR-0052)", () => {
  test("a document template emits render<Name>:string and NO extractor", async () => {
    const root = await loadRoot([SUMMARY_VO, SUMMARY_DOC]);
    const model = buildApiModel(root, { loadedRoot: root });

    const u = unit(model, "ProductSummary");
    expect(u.nodeKind).toBe("template");

    // The reference used to document extract<Name>/extractLenient<Name> here —
    // functions template.output no longer emits — and typed the result as the
    // @payloadRef VO, which is the thing being rendered OUT, not a reply.
    expect(u.symbols.filter((s) => s.kind === "extractor")).toEqual([]);

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
    // An email generating a parser for text it just rendered was the artifact
    // that motivated ADR-0052.
    expect(unit(model, "WelcomeEmail").symbols.filter((s) => s.kind === "extractor")).toEqual([]);
  });
});

describe("buildApiModel — a responding template.prompt owns the extractor symbols", () => {
  test("emits extract<Name>/extractLenient<Name> typed on @responseRef, not @payloadRef", async () => {
    const root = await loadRoot([REQUEST_VO, SUMMARY_VO, SUMMARY_PROMPT]);
    const model = buildApiModel(root, { loadedRoot: root });

    const u = unit(model, "SummarizeProduct");
    const extractors = u.symbols.filter((s) => s.kind === "extractor");
    expect(extractors.map((s) => s.name)).toEqual([
      "extractSummarizeProduct",
      "extractLenientSummarizeProduct",
    ]);
    // The strict return is the RESPONSE shape. Typing it as @payloadRef would
    // document the request as the parse result — the defect ADR-0052 names.
    expect(extractors[0]!.returns).toBe("SummaryVO");
    expect(extractors[0]!.signature).toContain("): SummaryVO");
    expect(extractors[0]!.importPath).toContain("SummarizeProduct.extractor");

    // The render handle still documents the REQUEST payload.
    const renders = u.symbols.filter((s) => s.kind === "prompt");
    expect(renders[0]!.signature).toContain("payload: AskVO");
  });

  test("a prompt with NO @responseRef documents no extractor at all", async () => {
    const FIRE_AND_FORGET = {
      "template.prompt": {
        name: "Announce",
        "@payloadRef": "AskVO",
        "@textRef": "p/announce",
      },
    };
    const root = await loadRoot([REQUEST_VO, SUMMARY_VO, FIRE_AND_FORGET]);
    const model = buildApiModel(root, { loadedRoot: root });
    expect(unit(model, "Announce").symbols.filter((s) => s.kind === "extractor")).toEqual([]);
  });

  test("the gate is @responseRef presence, not a format value", async () => {
    // @format: text on the prompt BODY must not suppress the reply's extractor —
    // that gate is exactly what left the common case unserved before ADR-0053.
    const root = await loadRoot([REQUEST_VO, SUMMARY_VO, SUMMARY_PROMPT]);
    const model = buildApiModel(root, { loadedRoot: root });
    expect(
      unit(model, "SummarizeProduct").symbols.filter((s) => s.kind === "extractor").length,
    ).toBe(2);
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

describe("buildApiModel — a TPH base documents only the verbs its own mount serves", () => {
  test("no POST/PATCH/DELETE at the base path — those 404", async () => {
    const root = await loadRoot(AUTH_TPH);
    const model = buildApiModel(root, { loadedRoot: root });
    const auth = model.units.find((u) => u.node === "Auth");
    expect(auth).toBeDefined();

    const rest = (auth as ApiUnitDoc).symbols.filter((sym) => sym.kind === "rest");
    const verbs = new Set(rest.map((sym) => sym.signature.split(" ")[0]));
    // `routes-file.ts` builds the polymorphic mount as
    // `intersectExpose(TPH_POLYMORPHIC_VERBS, expose)` — the discriminated union has no
    // single writable shape, so the base path can never carry a write. Writes live on the
    // per-subtype mounts at `<base>/<segment>`, which this surface documents nowhere (a
    // deferral stated in the module header).
    expect([...verbs].sort()).toEqual(["GET"]);
    expect([...TPH_POLYMORPHIC_VERBS].sort()).toEqual(["get", "list"]);

    // The read-only test used to be `isProjection(obj)` alone. A base is not a projection,
    // so all five verbs were published — three of which 404 — under a comment asserting the
    // documented paths "match the generated routes exactly". A vanilla entity is unaffected
    // and still carries the writes, which is what makes this narrowing and not a blanket.
    const vanilla = model.units.find((u) => u.node === "BridgeAuth");
    expect(vanilla?.symbols.some((sym) => sym.kind === "rest")).toBe(false);
  });
});
