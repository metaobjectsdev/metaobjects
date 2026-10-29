import { expect, test } from "bun:test";
import { existsSync, readFileSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSite } from "../src/site";

test("generates all pages for the fixture", async () => {
  const out = mkdtempSync(join(tmpdir(), "site-"));
  const r = await generateSite({ sourceDirs: [join(import.meta.dir, "fixture/input/acme")], outDir: out, title: "Fixture", stamp: "2026-01-01", commit: "abc1234" });
  for (const p of ["index.html", "coverage.html", "enums.html", "acme/shop/index.html", "acme/shop/Order.html", "acme/ai/npcReview.html", "acme/ai/npcReviewOutput.html", "assets/site.css", "assets/site.js", "assets/search-index.json"])
    expect(existsSync(join(out, p))).toBe(true);
  expect(readFileSync(join(out, "acme/ai/npcReview.html"), "utf8")).toContain("mu-sec");
  expect(r.pages.length).toBeGreaterThan(10);
  expect(r.dangling).toEqual([]);
});

test("assetsDir override: a consumer site.css wins over the bundled one", async () => {
  const overrideDir = mkdtempSync(join(tmpdir(), "assets-override-"));
  writeFileSync(join(overrideDir, "site.css"), "/* OWNED CSS MARKER */", "utf8");
  const out = mkdtempSync(join(tmpdir(), "site-out-"));
  await generateSite({
    sourceDirs: [join(import.meta.dir, "fixture/input/acme")],
    outDir: out, title: "Fixture", stamp: "2026-01-01", commit: "abc1234",
    assetsDir: overrideDir,
  });
  expect(readFileSync(join(out, "assets/site.css"), "utf8")).toBe("/* OWNED CSS MARKER */");
  // an asset NOT present in the override still comes from the bundled dir
  expect(readFileSync(join(out, "assets/site.js"), "utf8").length).toBeGreaterThan(0);
});

// ─── Nav scaling ──────────────────────────────────────────────────────────────

/**
 * The sidebar used to render EVERY member of EVERY package into EVERY page, which made the site
 * quadratic: n pages each carrying an n-link tree. On a real 656-page model that was 62 MB of the
 * 69 MB output — 90% of the site — and 574 of the 654 anchors on any given page sat inside a
 * COLLAPSED <details>, in the DOM and never rendered.
 *
 * Members are now listed only for the package the current page belongs to. Other packages are a
 * link to their own index, which is where their members are listed.
 */
test("nav lists members only for the current page's package", async () => {
  const out = mkdtempSync(join(tmpdir(), "site-nav-"));
  await generateSite({ sourceDirs: [join(import.meta.dir, "fixture/input/acme")], outDir: out, title: "Fixture", stamp: "2026-01-01", commit: "abc1234" });

  const navOf = (page: string): string => {
    const m = /<nav\b[\s\S]*?<\/nav>/.exec(readFileSync(join(out, page), "utf8"));
    if (m === null) throw new Error(`no <nav> in ${page}`);
    return m[0];
  };

  const shopNav = navOf("acme/shop/Order.html");
  // Its OWN package's members are listed...
  expect(shopNav).toContain("Order.html");
  // ...every package is still reachable by its index...
  expect(shopNav).toContain("ai/index.html");
  // ...but a foreign package's MEMBERS are not inlined.
  expect(shopNav).not.toContain("npcReview.html");
  expect(shopNav).not.toContain("npcReviewOutput.html");

  // And symmetrically from the other side, so this cannot pass by listing nothing at all.
  const aiNav = navOf("acme/ai/npcReview.html");
  expect(aiNav).toContain("npcReviewOutput.html");
  expect(aiNav).toContain("shop/index.html");
  expect(aiNav).not.toContain("Order.html");
});

// ─── assetBase ────────────────────────────────────────────────────────────────

const htmlFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? htmlFiles(join(dir, e.name)) : e.name.endsWith(".html") ? [join(dir, e.name)] : [],
  );

test("assetBase replaces the jsDelivr base in every page's stylesheet and script tags", async () => {
  const out = mkdtempSync(join(tmpdir(), "site-assetbase-"));
  await generateSite({
    sourceDirs: [join(import.meta.dir, "fixture/input/acme")],
    outDir: out, title: "Fixture", stamp: "2026-01-01", commit: "abc1234",
    assetBase: "https://assets.example.test/npm/",
  });
  const pages = htmlFiles(out);
  expect(pages.length).toBeGreaterThan(10);
  for (const page of pages) {
    const html = readFileSync(page, "utf8");
    expect(html).not.toContain("cdn.jsdelivr.net");
    expect(html).toContain('<link rel="stylesheet" href="https://assets.example.test/npm/daisyui@5.5.19/daisyui.css">');
    expect(html).toContain('<link rel="stylesheet" href="https://assets.example.test/npm/daisyui@5.5.19/themes.css">');
    expect(html).toContain('<script src="https://assets.example.test/npm/@tailwindcss/browser@4.2.4/dist/index.global.js"></script>');
    expect(html).toContain('<script src="https://assets.example.test/npm/mermaid@11/dist/mermaid.min.js"></script>');
    expect(html).toContain('<script src="https://assets.example.test/npm/svg-pan-zoom@3.6.2/dist/svg-pan-zoom.min.js"></script>');
  }
});

test("a root-relative assetBase is written as given, at every page depth", async () => {
  const out = mkdtempSync(join(tmpdir(), "site-assetbase-abs-"));
  await generateSite({
    sourceDirs: [join(import.meta.dir, "fixture/input/acme")],
    outDir: out, title: "Fixture", stamp: "2026-01-01", commit: "abc1234",
    assetBase: "/vendor",
  });
  for (const page of ["index.html", "acme/shop/Order.html"])
    expect(readFileSync(join(out, page), "utf8")).toContain('<script src="/vendor/mermaid@11/dist/mermaid.min.js"></script>');
});

test("the default assetBase is jsDelivr", async () => {
  const out = mkdtempSync(join(tmpdir(), "site-assetbase-default-"));
  await generateSite({ sourceDirs: [join(import.meta.dir, "fixture/input/acme")], outDir: out, title: "Fixture", stamp: "2026-01-01", commit: "abc1234" });
  expect(readFileSync(join(out, "index.html"), "utf8")).toContain('<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>');
});
