// The model explorer site (`generateExplorerSite`) over the public fixtures: the shop
// explorer-conformance fixture (requirements, a prompt, an unclaimed entity) and the
// persistence-conformance fitness model (projections, reports, no requirements).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { MetaDataLoader, canonicalSerializeEffective } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";
import {
  buildExplorer,
  EXPLORER_ASSET_NAMES,
  generateExplorerSite,
  readPromptTexts,
  type ExplorerJson,
} from "../src/index.js";

const REPO = resolve(import.meta.dir, "../../../../..");
const SHOP = join(REPO, "fixtures/explorer-conformance/shop");
const FITNESS = join(REPO, "fixtures/persistence-conformance/canonical");

const dirs: string[] = [];
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), "explorer-site-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((f) => f.isFile())
    .map((f) => relative(dir, join(f.parentPath, f.name)).split("\\").join("/"))
    .sort();
}

const shopExplorer = (): ExplorerJson => JSON.parse(readFileSync(join(SHOP, "expected.json"), "utf8")) as ExplorerJson;

function buildShop(): { out: string; pages: string[]; files: string[]; page: (p: string) => string } {
  const explorer = shopExplorer();
  const out = scratch();
  const r = generateExplorerSite({
    explorer,
    outDir: out,
    title: "Shop",
    texts: readPromptTexts(explorer, [join(SHOP, "project/prompts"), join(SHOP, "project")]),
  });
  return { out, pages: r.pages, files: r.files, page: (p) => readFileSync(join(out, p), "utf8") };
}

async function buildFitness(): Promise<{ page: (p: string) => string; files: string[] }> {
  const root = (await new MetaDataLoader().load([new FileSource(join(FITNESS, "meta.fitness.json"))])).root;
  const explorer = buildExplorer({ model: JSON.parse(canonicalSerializeEffective(root)) as unknown });
  const out = scratch();
  const r = generateExplorerSite({ explorer, outDir: out, title: "Fitness", texts: readPromptTexts(explorer, [join(FITNESS, "prompts"), FITNESS]) });
  return { files: r.files, page: (p) => readFileSync(join(out, p), "utf8") };
}

describe("explorer site over explorer-conformance/shop", () => {
  const shop = buildShop();

  test("writes every screen, one page per object, prompt and requirement, and passes its own link check", () => {
    for (const p of [
      "index.html", "map.html", "matrix.html", "trace.html", "prompts.html", "api.html", "gaps.html",
      "requirements/features.html", "requirements/qualities.html", "model/index.html",
      "model/acme/shop/Order.html", "model/acme/shop/AuditEntry.html", "model/acme/shop/OrderNotePrompt.html",
      "requirements/acme/shop/Shop.html", "requirements/acme/shop/Shop.Checkout.Orders.Recorded.Quotable.html",
      "requirements/acme/shop/Addressable.html",
    ]) expect(shop.pages).toContain(p);
    // generateExplorerSite throws on a dangling link, so reaching here is the link check passing.
    for (const a of EXPLORER_ASSET_NAMES) expect(shop.files).toContain(`assets/${a}`);
    expect(shop.files).toContain("assets/explorer-data.js");
    expect(shop.files).toContain("explorer.json");
    expect(filesUnder(shop.out)).toEqual([...shop.files].sort());
  });

  test("is deterministic: a second build writes the same bytes", () => {
    const again = buildShop();
    for (const f of shop.files) expect(again.page(f)).toBe(shop.page(f));
  });

  test("the explorer.json it ships is the one it read", () => {
    expect(shop.page("explorer.json")).toBe(readFileSync(join(SHOP, "expected.json"), "utf8"));
  });

  test("S1, the main page: what the software does, from the counts and the requirement tree", () => {
    const index = shop.page("index.html");
    expect(index).toContain("<h1>What Shop does</h1>");
    expect(index.match(/class="card tile"/g)?.length).toBe(6);
    expect(index).toContain('<div class="n">2/3</div>');
    expect(index).toContain("requirements: 8 features, 1 quality");
    // A feature card: level badge, declared status, the roll-up bar, the level below.
    expect(index).toContain('<span class="lvl" title="Level 1">L1</span>');
    expect(index).toContain('href="requirements/acme/shop/Shop.html"');
    expect(index).toContain('<div class="bar" role="img"');
    // The summary slot stays folded and empty: this build makes no LLM call.
    expect(index).toContain('<details class="summary">');
    expect(index).toContain("No summary is generated in this build.");
  });

  test("a declared status is a filled chip with its glyph; a gate verdict is an outline", () => {
    const refunded = shop.page("requirements/acme/shop/Shop.Checkout.Orders.Refunded.html");
    expect(refunded).toContain('class="chip s-planned"');
    expect(refunded).toContain("○ planned");
    const shipping = shop.page("requirements/acme/shop/Shop.Checkout.Shipping.html");
    expect(shipping).toContain('class="chip s-live"');
    expect(shipping).toContain('class="chip v-warn"');
    const css = shop.page("assets/explorer.css");
    for (const v of ["v-error", "v-warn"]) {
      const rule = css.split("\n").find((l) => l.includes(`.${v}`) && l.includes("{")) ?? "";
      expect(rule).toContain("background: transparent");
    }
    // Nothing on any page claims a test result.
    for (const p of shop.pages) expect(shop.page(p)).not.toMatch(/class="[^"]*\b(test-pass|test-fail|passed|failed)\b/);
  });

  test("an entity no requirement claims carries the gate's unclaimed outline and its warning", () => {
    const audit = shop.page("model/acme/shop/AuditEntry.html");
    expect(audit).toContain("chip v-unclaimed");
    expect(audit).toContain("WARN_REQUIREMENT_OBJECT_UNCLAIMED");
  });

  test("an object page says why it exists, holds its fields and lists what was generated from it", () => {
    const order = shop.page("model/acme/shop/Order.html");
    expect(order).toContain("Why it exists");
    expect(order).toContain('href="../../../requirements/acme/shop/Shop.Checkout.Orders.Recorded.html"');
    expect(order).toContain('id="m-reference"');
    expect(order).toContain("src/generated/acme/shop/Order.queries.ts");
    expect(order).toContain('<div id="cymini" class="graph" data-node="acme::shop::Order"');
  });

  test("a prompt page shows its payload, reply and text, and which payload fields the text uses", () => {
    const prompt = shop.page("model/acme/shop/OrderNotePrompt.html");
    expect(prompt).toContain("OrderNoteRequest");
    expect(prompt).toContain('<b class="var">{{reference}}</b>');
  });

  test("a requirement page links its slice and its trace by query string", () => {
    const orders = shop.page("requirements/acme/shop/Shop.Checkout.Orders.html");
    expect(orders).toContain(`../../../map.html?slice=${encodeURIComponent("requirement:acme::shop::Shop.Checkout.Orders")}`);
    expect(orders).toContain("What the build proves about this entry");
  });

  test("every page is searchable by Pagefind and phone-ready", () => {
    for (const p of shop.pages) {
      const html = shop.page(p);
      expect(html).toContain("<main data-pagefind-body>");
      expect(html).toContain('name="viewport"');
    }
    expect(shop.page("assets/explorer.css")).toContain("@media (max-width: 700px)");
  });

  test("the graph library loads only on the pages that draw a graph", () => {
    expect(shop.page("map.html")).toContain("cytoscape@3.30.2/dist/cytoscape.min.js");
    expect(shop.page("gaps.html")).not.toContain("cytoscape");
  });
});

describe("explorer site over the fitness model", async () => {
  const fitness = await buildFitness();

  test("a projection page shows the read model: its base and each field's origin", () => {
    const stat = fitness.page("model/fitness/ProgramStat.html");
    expect(stat).toContain("Read model");
    expect(stat).toContain("origin.aggregate");
    expect(stat).toContain("view v_program_stat");
  });

  test("a report page shows where its rows come from, its dimensions and its measures", () => {
    const report = fitness.page("model/fitness/ProgramMinutes.html");
    expect(report).toContain("Dimensions");
    expect(report).toContain("Measures");
    expect(report).toContain(`href="../../model/fitness/Week.html#m-totalMinutes"`);
    expect(report).toContain(`<tr><th>From</th><td><a class="k-entity" href="../../model/fitness/Week.html">Week</a>`);
  });

  test("with no requirements the main page says so, and no page claims an L5 column", () => {
    expect(fitness.page("index.html")).toContain("This model declares no requirements yet");
    expect(fitness.page("model/fitness/Program.html")).not.toContain("Claimed at L5");
  });
});

describe("explorer site page paths", () => {
  const model = (pkg: string | undefined, children: unknown[]): unknown => ({
    "metadata.root": { ...(pkg !== undefined ? { package: pkg } : {}), children },
  });
  const entity = (name: string): unknown => ({ "object.entity": { name, children: [{ "field.string": { name: "title" } }] } });

  test("an object named index does not take its package's index page", () => {
    const out = scratch();
    const r = generateExplorerSite({ explorer: buildExplorer({ model: model("acme", [entity("index"), entity("Order")]) }), outDir: out, title: "T" });
    expect(r.pages).toContain("model/acme/index.html");
    expect(r.pages).toContain("model/acme/index.node.html");
    expect(readFileSync(join(out, "model/acme/index.html"), "utf8")).toContain("Order");
  });

  test("a model with no package gets pages under a directory no package name can take", () => {
    const out = scratch();
    const r = generateExplorerSite({ explorer: buildExplorer({ model: model(undefined, [entity("Order")]) }), outDir: out, title: "T" });
    expect(r.pages).toContain("model/-root/Order.html");
  });

  test("a prompt's @textRef is read only below the directories it is given", () => {
    const base = scratch();
    const prompts = join(base, "prompts");
    mkdirSync(prompts);
    writeFileSync(join(prompts, "ok.mustache"), "Hello {{name}}");
    writeFileSync(join(base, "secret.mustache"), "outside");
    const prompt = (name: string, ref: string): unknown => ({ "template.prompt": { name, "@textRef": ref } });
    const explorer = buildExplorer({ model: model("acme", [prompt("Ok", "ok"), prompt("Up", "../secret"), prompt("Abs", join(base, "secret"))]) });
    const texts = readPromptTexts(explorer, [prompts]);
    expect(texts.get("acme::Ok")).toBe("Hello {{name}}");
    expect(texts.has("acme::Up")).toBe(false);
    expect(texts.has("acme::Abs")).toBe(false);
    expect(existsSync(join(base, "secret.mustache"))).toBe(true);
  });
});
