// Overview/index page (README.md) — the neutral docs landing page emitted by
// docsFile(). It carries the whole-model Mermaid ER diagram (reusing the single
// shared `renderMermaidErBlock()` builder) plus a navigable index linking every
// entity page and every template.output page. Links are computed with
// `docPageHref` so they resolve in BOTH flat and package layouts.
//
// Neutrality (ADR-0020): the index makes NO assumption about the implementing
// language — Mermaid + entity/template names + relationships only, no language
// types, no `.ts`/Zod/helper signatures.

import { describe, it, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { docsFile } from "../src/generators/docs-file.js";
import { makeRenderContext } from "../src/render-context.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";
import type { GenContext } from "../src/generator.js";
import type { OutputLayout } from "../src/import-path.js";

function makeCtx(
  root: Awaited<ReturnType<MetaDataLoader["load"]>>["root"],
  layout: OutputLayout = "flat",
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
    config: { outDir: "/tmp", extStyle: "none", dbImport: "~/db", dialect: "sqlite", outputLayout: layout } as never,
    renderContext,
    warn: () => {},
  };
}

async function renderDocs(json: string, layout: OutputLayout = "flat"): Promise<Map<string, string>> {
  const res = await new MetaDataLoader().load([
    new InMemoryStringSource(json, { id: "meta.json", format: "json" }),
  ]);
  expect(res.errors).toEqual([]);
  const out = await docsFile().generate(makeCtx(res.root, layout));
  const byName = new Map<string, string>();
  for (const f of out) byName.set(f.path, f.content);
  return byName;
}

// A multi-entity + template.output model with a relationship (Order references
// Customer) — exercises the ER diagram AND the entity/template index grouping.
const MODEL_JSON = JSON.stringify({
  "metadata.root": {
    package: "acme::shop",
    children: [
      {
        "object.entity": {
          name: "Customer",
          package: "acme::shop",
          "@description": "A buyer.",
          children: [
            { "source.rdb": { "@table": "customers" } },
            { "field.long": { name: "id" } },
            { "field.string": { name: "email", "@required": true } },
            { "identity.primary": { "@fields": ["id"], "@generation": "increment" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Order",
          package: "acme::shop",
          "@description": "A placed order.",
          children: [
            { "source.rdb": { "@table": "orders" } },
            { "field.long": { name: "id" } },
            { "field.long": { name: "customerId", "@required": true } },
            { "identity.primary": { "@fields": ["id"], "@generation": "increment" } },
            {
              "identity.reference": {
                name: "customerRef",
                "@fields": ["customerId"],
                "@references": "Customer",
              },
            },
          ],
        },
      },
      {
        "object.value": {
          name: "OrderSummary",
          package: "acme::shop",
          children: [
            { "field.string": { name: "reference" } },
            { "field.string": { name: "total" } },
          ],
        },
      },
      {
        "template.output": {
          name: "OrderEmail",
          "@kind": "email",
          "@payloadRef": "OrderSummary",
          "@subjectRef": "shop/order-subject",
          "@htmlBodyRef": "shop/order-body",
          "@format": "html",
        },
      },
    ],
  },
});

describe("docs overview — README.md index page", () => {
  it("emits a README.md with a mermaid erDiagram block", async () => {
    const docs = await renderDocs(MODEL_JSON);
    const readme = docs.get("README.md");
    expect(readme, "README.md should be emitted").toBeDefined();
    const md = readme!;
    // The fenced mermaid ER diagram for the whole model.
    expect(md).toContain("```mermaid");
    expect(md).toContain("erDiagram");
    // Relationship topology surfaces.
    expect(md).toContain("Customer");
    expect(md).toContain("Order");
  });

  it("links every entity page AND every template page, and each link resolves to an emitted file (flat)", async () => {
    const docs = await renderDocs(MODEL_JSON);
    const readme = docs.get("README.md")!;

    // Every emitted page (other than the index itself) is linked from the index.
    const emitted = [...docs.keys()].filter((p) => p !== "README.md");
    expect(emitted.length).toBeGreaterThan(0);
    for (const path of emitted) {
      // Flat layout href is `./<path>`.
      const href = `./${path}`;
      expect(md_includesLink(readme, href), `index should link ${href}`).toBe(true);
    }

    // And every link target in the index resolves to an actually-emitted page.
    for (const href of extractMdLinks(readme)) {
      const target = href.replace(/^\.\//, "");
      expect(docs.has(target), `link ${href} should resolve to an emitted page`).toBe(true);
    }

    // Entities and templates are grouped distinctly.
    expect(readme).toContain("Customer.md");
    expect(readme).toContain("Order.md");
    expect(readme).toContain("OrderEmail.md");
  });

  it("is NEUTRAL — no language tokens", async () => {
    const docs = await renderDocs(MODEL_JSON);
    const readme = docs.get("README.md")!;
    // `.md` links are allowed; nothing else language-specific.
    const stripped = readme.replace(/\.md\b/g, "");
    expect(readme).not.toContain("Zod");
    expect(readme).not.toContain("EmailDocument");
    expect(readme).not.toContain(": string");
    expect(readme).not.toContain("## Generated code");
    expect(stripped).not.toMatch(/\.ts\b/);
    expect(stripped).not.toMatch(/\.cs\b/);
    expect(stripped).not.toMatch(/\.kt\b/);
    expect(stripped).not.toMatch(/\.py\b/);
  });

  it("package layout: index links use correct relative paths to nested pages (resolve)", async () => {
    const docs = await renderDocs(MODEL_JSON, "package");
    const readme = docs.get("README.md");
    expect(readme, "README.md should be emitted at docs root in package layout").toBeDefined();
    const md = readme!;

    // Nested pages exist under the package path.
    const emitted = [...docs.keys()].filter((p) => p !== "README.md");
    expect(emitted.some((p) => p.includes("/")), "package layout should nest pages").toBe(true);

    // Every index link resolves to an emitted nested page, relative to root.
    const links = extractMdLinks(md);
    expect(links.length).toBeGreaterThan(0);
    for (const href of links) {
      const target = href.replace(/^\.\//, "");
      expect(docs.has(target), `link ${href} should resolve to an emitted nested page`).toBe(true);
    }
    // The nested entity page is reachable from root.
    expect(emitted).toContain("acme/shop/Order.md");
    expect(md).toContain("acme/shop/Order.md");
  });
});

/** All markdown link hrefs `[text](href)` in `md`. */
function extractMdLinks(md: string): string[] {
  const out: string[] = [];
  const re = /\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) out.push(m[1]!);
  return out;
}

function md_includesLink(md: string, href: string): boolean {
  return extractMdLinks(md).includes(href);
}
