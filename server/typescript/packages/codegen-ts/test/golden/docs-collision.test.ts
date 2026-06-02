// Cross-package short-name COLLISION safety for docsFile().
//
// The bug: docs pages are placed by SHORT NAME. Two nodes that share a short
// name across different packages — here `object acme::sales::Order` and
// `template.output acme::comms::Order` — both want `Order.md`. (Two same-type
// same-short-name roots are collapsed upstream by the loader's (type,name)
// merge, so the realistic, reproducible docs-level collision is between nodes
// of DIFFERENT type that the loader keeps distinct.) In flat layout the
// generator MUST hard-error (never silently overwrite); in package layout the
// pages fold under package-path subdirs and BOTH survive with correct relative
// cross-links.

import { describe, it, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { docsFile } from "../../src/generators/docs-file.js";
import { makeRenderContext } from "../../src/render-context.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";
import type { GenContext } from "../../src/generator.js";
import type { OutputLayout } from "../../src/import-path.js";

// `object.value Order` in acme::sales + `template.output Order` (using that
// entity as @payloadRef, so cross-links are exercised) in acme::comms. Same
// short name, different packages, different node types → kept distinct by the
// loader, collide at docs placement.
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
          "@format": "html",
        },
      },
    ],
  },
});
// A template in a THIRD package with a DISTINCT short name — exercises a
// cross-package relative link that is NOT a same-name collision.
const COMMS_TEMPLATE = JSON.stringify({
  "metadata.root": {
    package: "acme::comms",
    children: [
      {
        "template.output": {
          name: "OrderEmail",
          "@kind": "document",
          "@payloadRef": "Order",
          "@textRef": "comms/orderemail",
          "@format": "html",
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

describe("docsFile() — cross-package short-name collision safety", () => {
  it("flat layout: two Order nodes in different packages → HARD ERROR naming both FQNs + path", async () => {
    const root = await loadRoot([SALES_ORDER, COMMS_ORDER_TEMPLATE]);
    const gen = docsFile();
    let err: Error | undefined;
    try {
      await gen.generate(makeCtx(root)); // flat (default)
    } catch (e) {
      err = e as Error;
    }
    expect(err, "expected a hard error on duplicate output path").toBeDefined();
    expect(err!.message).toContain("Order.md");
    expect(err!.message).toContain("acme::sales::Order");
    expect(err!.message).toContain("acme::comms::Order");
  });

  it("package layout: both Order pages emitted under package subdirs — NO collision", async () => {
    const root = await loadRoot([SALES_ORDER, COMMS_ORDER_TEMPLATE]);
    const out = await docsFile().generate(makeCtx(root, "package"));
    const paths = out.map((f) => f.path).sort();
    expect(paths).toContain("acme/sales/Order.md");
    expect(paths).toContain("acme/comms/Order.md");
    // Distinct paths, one per node.
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("package layout: every cross-link href resolves to a real emitted page", async () => {
    const root = await loadRoot([SALES_ORDER, COMMS_TEMPLATE]);
    const out = await docsFile().generate(makeCtx(root, "package"));
    const emitted = new Set(out.map((f) => f.path));

    // Pull every markdown link href out of every page and resolve it against
    // the page's own directory; it must land on a file in the output set.
    const linkRe = /\]\(([^)]+\.md)\)/g;
    for (const file of out) {
      const dir = file.path.includes("/")
        ? file.path.slice(0, file.path.lastIndexOf("/"))
        : "";
      let m: RegExpExecArray | null;
      while ((m = linkRe.exec(file.content)) !== null) {
        const href = m[1]!;
        // Normalize the relative href against the page's dir (POSIX).
        const segs = (dir === "" ? href : `${dir}/${href}`).split("/");
        const stack: string[] = [];
        for (const s of segs) {
          if (s === "." || s === "") continue;
          if (s === "..") stack.pop();
          else stack.push(s);
        }
        const resolved = stack.join("/");
        expect(
          emitted.has(resolved),
          `link "${href}" in ${file.path} → "${resolved}" not in output set`,
        ).toBe(true);
      }
    }
  });

  it("N documented nodes → N distinct output paths (package layout, repeated short names)", async () => {
    // entity Order (sales) + template Order (comms) + template OrderEmail (comms).
    const root = await loadRoot([SALES_ORDER, COMMS_ORDER_TEMPLATE, COMMS_TEMPLATE]);
    const out = await docsFile().generate(makeCtx(root, "package"));
    // 1 entity + 2 template.output nodes = 3 documented nodes.
    const templateNodes = root
      .ownChildren()
      .filter((c) => c.type === "template").length;
    const docCount = root.objects().length + templateNodes;
    expect(docCount).toBe(3);
    // docsFile() ALSO emits one neutral overview/index page (README.md) at the
    // docs root in addition to the per-node pages.
    const OVERVIEW_PAGES = 1;
    expect(out.length).toBe(docCount + OVERVIEW_PAGES);
    expect(out.filter((f) => f.path === "README.md").length).toBe(OVERVIEW_PAGES);
    expect(new Set(out.map((f) => f.path)).size).toBe(out.length);
  });

  it("single-package flat (back-compat): pages are <name>.md with ./<name>.md links", async () => {
    const single = JSON.stringify({
      "metadata.root": {
        package: "acme::shop",
        children: [
          { "object.value": { name: "Cart", children: [{ "field.string": { name: "id" } }] } },
          {
            "template.output": {
              name: "CartEmail",
              "@kind": "document",
              "@payloadRef": "Cart",
              "@textRef": "shop/cart",
              "@format": "html",
            },
          },
        ],
      },
    });
    const root = await loadRoot([single]);
    const out = await docsFile().generate(makeCtx(root)); // flat default
    const paths = out.map((f) => f.path).sort();
    // Per-node pages + the additive neutral overview/index (README.md).
    expect(paths).toEqual(["Cart.md", "CartEmail.md", "README.md"]);
    // The overview links both pages with same-dir ./<name>.md hrefs in flat.
    const readme = out.find((f) => f.path === "README.md")!;
    expect(readme.content).toContain("](./Cart.md)");
    expect(readme.content).toContain("](./CartEmail.md)");
    // Cross-links are same-dir ./<name>.md in flat.
    const cart = out.find((f) => f.path === "Cart.md")!;
    const tpl = out.find((f) => f.path === "CartEmail.md")!;
    expect(cart.content).toContain("](./CartEmail.md)");
    expect(tpl.content).toContain("](./Cart.md)");
  });
});
