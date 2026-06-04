// Task 3 — the `api-docs` GENERATOR: it wires the Task-1 ApiModel builder +
// Task-2 renderers into the codegen pipeline. This gate proves:
//   • the emitted file set: one `docs/api/<Node>.md` per entity + template, plus
//     `docs/api/README.md` (the human index) and `docs/api/AGENT-API.md`;
//   • per-unit page + index + agent content match the Task-2 renderers exactly
//     (no re-derivation — the generator reuses them);
//   • index links resolve to files actually emitted in the run, in BOTH flat and
//     package layout (collision-safe docPageHref placement);
//   • the multi-package short-name collision contract is the SAME docs-paths
//     guard docsFile() reuses: flat hard-errors, package folds under subdirs;
//   • the `api-docs` entry is registered NATIVE + the factory constructs.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { apiDocsFile } from "../../src/generators/api-docs-file.js";
import { buildApiModel } from "../../src/generators/api-model.js";
import {
  renderEntityApiPage,
  renderApiIndex,
  renderAgentApi,
} from "../../src/generators/api-doc-render.js";
import { projectProvider } from "../../src/render-engine/framework-provider.js";
import { generatorRegistry } from "../../src/generator-registry.js";
import { makeRenderContext } from "../../src/render-context.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";
import type { GenContext } from "../../src/generator.js";
import type { OutputLayout } from "../../src/import-path.js";

const API_DIR = "docs/api";

// A multi-entity model (CRUD entity + value object) plus a template unit, in a
// single package — exercises the entity vs template grouping + every section.
const SHOP = JSON.stringify({
  "metadata.root": {
    package: "acme::shop",
    children: [
      {
        "object.entity": {
          name: "Product",
          children: [
            { "field.long": { name: "id" } },
            { "field.string": { name: "name" } },
            { "identity.primary": { "@fields": "id", "@generation": "increment" } },
            { "source.rdb": { "@table": "products" } },
          ],
        },
      },
      {
        "object.value": {
          name: "SummaryVO",
          children: [{ "field.string": { name: "headline", "@required": true } }],
        },
      },
      {
        "template.output": {
          name: "ProductSummary",
          "@kind": "document",
          "@payloadRef": "SummaryVO",
          "@textRef": "out/product-summary",
          "@format": "json",
        },
      },
    ],
  },
});

// Same short name `Order` across two packages, different node types (kept
// distinct by the loader) — the realistic cross-package docs collision.
const SALES_ORDER = JSON.stringify({
  "metadata.root": {
    package: "acme::sales",
    children: [
      { "object.value": { name: "Order", children: [{ "field.string": { name: "sku" } }] } },
    ],
  },
});
const COMMS_ORDER_TEMPLATE = JSON.stringify({
  "metadata.root": {
    package: "acme::comms",
    children: [
      {
        "template.output": {
          name: "Order",
          "@kind": "document",
          "@payloadRef": "Order",
          "@textRef": "comms/order",
          "@format": "json",
        },
      },
    ],
  },
});

async function loadRoot(sources: string[]) {
  const srcs = sources.map(
    (s, i) => new InMemoryStringSource(s, { id: `src${i}.json`, format: "json" }),
  );
  const res = await new MetaDataLoader().load(srcs);
  expect(res.errors).toEqual([]);
  return res.root;
}

function makeCtx(
  root: Awaited<ReturnType<typeof loadRoot>>,
  layout?: OutputLayout,
): GenContext {
  const renderContext = makeRenderContext({
    dialect: "sqlite",
    loadedRoot: root,
    outDir: "/tmp",
    dbImport: "~/db",
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
  });
  return {
    entities: root.objects(),
    loadedRoot: root,
    matches: () => true,
    config: {
      outDir: "/tmp",
      extStyle: "none",
      dbImport: "~/db",
      dialect: "sqlite",
      ...(layout !== undefined ? { outputLayout: layout } : {}),
    } as never,
    renderContext,
    warn: () => {},
  };
}

const provider = projectProvider(undefined);

describe("apiDocsFile() — emitted file set + content reuses the Task-2 renderers", () => {
  test("emits docs/api/<Node>.md per unit + README.md + AGENT-API.md (flat)", async () => {
    const root = await loadRoot([SHOP]);
    const out = await apiDocsFile().generate(makeCtx(root));
    const paths = out.map((f) => f.path).sort();
    expect(paths).toEqual(
      [
        `${API_DIR}/AGENT-API.md`,
        `${API_DIR}/Product.md`,
        `${API_DIR}/ProductSummary.md`,
        `${API_DIR}/README.md`,
        `${API_DIR}/SummaryVO.md`,
      ].sort(),
    );
  });

  test("per-unit page content == renderEntityApiPage (no re-derivation)", async () => {
    const root = await loadRoot([SHOP]);
    const model = buildApiModel(root, { loadedRoot: root });
    const out = await apiDocsFile().generate(makeCtx(root));
    for (const u of model.units) {
      const page = out.find((f) => f.path === `${API_DIR}/${u.node}.md`);
      expect(page, `page for ${u.node}`).toBeDefined();
      expect(page!.content).toBe(renderEntityApiPage(u, provider));
    }
  });

  test("README.md == renderApiIndex (flat) and AGENT-API.md == renderAgentApi", async () => {
    const root = await loadRoot([SHOP]);
    const model = buildApiModel(root, { loadedRoot: root });
    const out = await apiDocsFile().generate(makeCtx(root));
    const readme = out.find((f) => f.path === `${API_DIR}/README.md`)!;
    const agent = out.find((f) => f.path === `${API_DIR}/AGENT-API.md`)!;
    expect(readme.content).toBe(renderApiIndex(model, "flat", provider));
    expect(agent.content).toBe(renderAgentApi(model, provider));
  });

  test("README.md == renderApiIndex (package) when outputLayout is package", async () => {
    const root = await loadRoot([SHOP]);
    const model = buildApiModel(root, { loadedRoot: root });
    const out = await apiDocsFile().generate(makeCtx(root, "package"));
    const readme = out.find((f) => f.path.endsWith("README.md"))!;
    expect(readme.content).toBe(renderApiIndex(model, "package", provider));
  });
});

// The index links must point at pages ACTUALLY emitted in the run — resolve each
// href against the index's own directory and confirm it lands in the output set.
function assertIndexLinksResolve(out: { path: string; content: string }[], indexPath: string) {
  const emitted = new Set(out.map((f) => f.path));
  const index = out.find((f) => f.path === indexPath)!;
  const dir = index.path.includes("/") ? index.path.slice(0, index.path.lastIndexOf("/")) : "";
  const linkRe = /\]\(([^)]+\.md)\)/g;
  let m: RegExpExecArray | null;
  let count = 0;
  while ((m = linkRe.exec(index.content)) !== null) {
    const href = m[1]!;
    const segs = (dir === "" ? href : `${dir}/${href}`).split("/");
    const stack: string[] = [];
    for (const s of segs) {
      if (s === "." || s === "") continue;
      if (s === "..") stack.pop();
      else stack.push(s);
    }
    const resolved = stack.join("/");
    expect(emitted.has(resolved), `index link "${href}" → "${resolved}" not emitted`).toBe(true);
    count++;
  }
  expect(count, "index had at least one link").toBeGreaterThan(0);
}

describe("apiDocsFile() — index links resolve to emitted pages", () => {
  test("flat layout: every README link resolves", async () => {
    const root = await loadRoot([SHOP]);
    const out = await apiDocsFile().generate(makeCtx(root));
    assertIndexLinksResolve(out, `${API_DIR}/README.md`);
  });

  test("package layout: every README link resolves (folded under package subdirs)", async () => {
    const root = await loadRoot([SHOP]);
    const out = await apiDocsFile().generate(makeCtx(root, "package"));
    const paths = out.map((f) => f.path).sort();
    expect(paths).toContain(`${API_DIR}/acme/shop/Product.md`);
    expect(paths).toContain(`${API_DIR}/acme/shop/ProductSummary.md`);
    assertIndexLinksResolve(out, `${API_DIR}/README.md`);
  });
});

describe("apiDocsFile() — cross-package short-name collision (docs-paths guard)", () => {
  test("flat layout: two Order nodes in different packages → HARD ERROR", async () => {
    const root = await loadRoot([SALES_ORDER, COMMS_ORDER_TEMPLATE]);
    let err: Error | undefined;
    try {
      await apiDocsFile().generate(makeCtx(root)); // flat default
    } catch (e) {
      err = e as Error;
    }
    expect(err, "expected a hard error on duplicate output path").toBeDefined();
    expect(err!.message).toContain("Order.md");
    expect(err!.message).toContain("acme::sales::Order");
    expect(err!.message).toContain("acme::comms::Order");
  });

  test("package layout: both Order pages emitted under distinct nested paths", async () => {
    const root = await loadRoot([SALES_ORDER, COMMS_ORDER_TEMPLATE]);
    const out = await apiDocsFile().generate(makeCtx(root, "package"));
    const paths = out.map((f) => f.path).sort();
    expect(paths).toContain(`${API_DIR}/acme/sales/Order.md`);
    expect(paths).toContain(`${API_DIR}/acme/comms/Order.md`);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe("apiDocsFile() — registry registration (ADR-0022 native)", () => {
  test("registered under stable name `api-docs`, tier native, factory constructs", () => {
    const entry = generatorRegistry["api-docs"];
    expect(entry, "api-docs registered").toBeDefined();
    expect(entry!.name).toBe("api-docs");
    expect(entry!.tier).toBe("native");
    const gen = entry!.factory();
    expect(gen.name).toBe("api-docs");
    expect(typeof gen.generate).toBe("function");
  });
});
