// FR-044 Plan 3, Table G, the HTML site: a page for every report (served or not), an
// entry for each in its package's object index, a "Reporting" section on the `@from`
// entity's page, and the reporting vocabulary counted as RENDERED by the coverage audit.
//
// The model pair is the one every port's FR-044 inert test shares
// (fixtures/codegen-noop/reporting/). The sentences come from `@metaobjectsdev/metadata`'s
// describers, which the markdown model pages (codegen-ts) print too.

import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { generateSite, type SiteResult } from "../src/site";

const MODELS = join(import.meta.dir, "..", "..", "..", "..", "..", "fixtures", "codegen-noop", "reporting");

function walk(root: string, dir = root): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? walk(root, p) : [relative(root, p).split(sep).join("/")];
  }).sort();
}

interface Site { result: SiteResult; files: Record<string, string>; }

/** Generate the site for one variant. The source dir has the SAME basename for both
 *  variants: a page prints the file its object came from. */
async function site(variant: "with" | "without", edit?: (json: string) => string): Promise<Site> {
  const parent = mkdtempSync(join(tmpdir(), "reporting-site-"));
  try {
    const src = join(parent, "shop");
    const out = join(parent, "out");
    mkdirSync(src);
    const model = readFileSync(join(MODELS, variant, "meta.shop.json"), "utf8");
    writeFileSync(join(src, "meta.shop.json"), edit ? edit(model) : model);
    const result = await generateSite({ sourceDirs: [src], outDir: out, title: "Shop", stamp: "2026-01-01", commit: "abc1234" });
    const files: Record<string, string> = {};
    for (const rel of walk(out)) files[rel] = readFileSync(join(out, rel), "utf8");
    return { result, files };
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

/** The page body with tags dropped and whitespace folded, to assert on what a reader sees. */
function text(html: string): string {
  return html.replace(/<\/?code>/g, "").replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
}

let withSite: Site;
let withoutSite: Site;

beforeAll(async () => {
  withSite = await site("with");
  withoutSite = await site("without");
});

describe("FR-044 no-churn: a model with no report renders the site it always did", () => {
  test("every file of the no-report site hashes to the pre-feature snapshot", () => {
    const hashes: Record<string, string> = {};
    for (const [path, content] of Object.entries(withoutSite.files)) {
      // The stylesheet and script are the same bytes for every model; pinning them here
      // would fail this test on a restyle that has nothing to do with reporting.
      if (path === "assets/site.css" || path === "assets/site.js") continue;
      hashes[path] = createHash("sha256").update(content).digest("hex");
    }
    expect(hashes).toMatchSnapshot();
  });
});

describe("FR-044 the site renders reports", () => {
  const SHOP = "acme/shop";

  test("each report has a page and a row in its package's object index", () => {
    const index = withSite.files[`${SHOP}/index.html`]!;
    for (const name of ["StoreTotals", "ProgramEngagement", "DailyRevenue"]) {
      expect(Object.keys(withSite.files)).toContain(`${SHOP}/${name}.html`);
      expect(index).toContain(`href="${name}.html"`);
    }
    expect(withSite.result.dangling).toEqual([]);
  });

  test("a served report names its @from, its view and its columns", () => {
    const html = withSite.files[`${SHOP}/StoreTotals.html`]!;
    expect(html).toContain('id="s-report"');
    expect(html).toContain('<a class="link font-mono" href="Purchase.html">Purchase</a>');
    const page = text(html);
    expect(page).toContain("view v_store_totals");
    expect(page).not.toContain("Not served");
    // A report declares no fields: its columns are the Report section, not an empty Fields table.
    expect(html).not.toContain('id="s-fields"');
    expect(withSite.files[`${SHOP}/Purchase.html`]).toContain('id="s-fields"');
    expect(page).toContain("purchases long no measure count of Purchase.id where segment active");
    expect(page).toContain("buyers long no measure count of distinct Purchase.customerEmail where segment active");
    expect(page).toContain("revenue currency yes measure sum of Purchase.amountCents where segment active");
  });

  test("a sourceless report is marked not served, and still lists its columns and row scope", () => {
    const engagement = text(withSite.files[`${SHOP}/ProgramEngagement.html`]!);
    expect(engagement).toContain("Not served: declares no view source");
    expect(engagement).toContain("row scope segment completions");
    expect(engagement).toContain("program long yes dimension WorkoutEvent.programId");
    expect(engagement).toContain(
      "daysEngaged long no measure count of distinct (WorkoutEvent.programId, WorkoutEvent.customerEmail, WorkoutEvent.weekNumber, WorkoutEvent.dayNumber)",
    );
    expect(engagement).toContain("avgDaysPerStarter decimal yes measure daysEngaged / starters, null when the denominator is 0");
    expect(engagement).toContain("lastActivityAt timestamp yes measure max of WorkoutEvent.occurredAt");

    const daily = text(withSite.files[`${SHOP}/DailyRevenue.html`]!);
    expect(daily).toContain("Not served: declares no view source");
    expect(daily).toContain('row scope filter {"purchasedAt":{"gte":{"now":"-P90D"}}}');
    expect(daily).toContain("purchasedAtDay date yes dimension Purchase.purchasedAt truncated to day, UTC");
  });

  test("the @from entity's page has a Reporting section: dimensions, measures, segments, reports", () => {
    const html = withSite.files[`${SHOP}/Purchase.html`]!;
    expect(html).toContain('id="s-reporting"');
    expect(html).toContain('href="#s-reporting"');
    const section = text(html.slice(html.indexOf('id="s-reporting"')));
    expect(section).toContain("program Purchase.programId");
    expect(section).toContain("programTitle Program.title via Purchase.program");
    expect(section).toContain("purchasedAt time Purchase.purchasedAt; grains: day, week, month, quarter, year");
    expect(section).toContain('refundedPurchases count of Purchase.id where filter {"refunded":{"eq":true}}');
    expect(section).toContain("revenue sum of Purchase.amountCents where segment active");
    expect(section).toContain('active {"status":{"eq":"active"}}');
    expect(html).toContain('<a class="link font-mono text-xs" href="DailyRevenue.html">DailyRevenue</a>');
    expect(html).toContain('<a class="link font-mono text-xs" href="StoreTotals.html">StoreTotals</a>');
    // An entity with no reporting nodes has no such section.
    expect(withSite.files[`${SHOP}/Program.html`]).not.toContain('id="s-reporting"');
  });

  test("the reporting vocabulary counts as rendered: nothing deferred, no coverage gap", () => {
    const { coverage } = withSite.result;
    expect("deferred" in coverage).toBe(false);
    const reporting = (key: string): boolean => /^(dimension|measure|segment)[.:]/.test(key) || key === "object.report";
    const kinds = coverage.kinds.filter((r) => reporting(r.key));
    expect(kinds.map((r) => r.key)).toEqual([
      "dimension.attribute", "dimension.time", "measure.aggregate", "measure.ratio", "object.report", "segment.filter",
    ]);
    expect(kinds.filter((r) => !r.consumed)).toEqual([]);
    expect(coverage.attrs.filter((r) => reporting(r.key)).length).toBeGreaterThan(0);
    expect(coverage.attrs.filter((r) => reporting(r.key) && !r.consumed)).toEqual([]);
    // The report node's own attrs are rendered too (object:@from and friends).
    expect(coverage.attrs.filter((r) => r.key.startsWith("object:@") && !r.consumed)).toEqual([]);
    expect(coverage.warnings.filter((w) => /deferred|dimension|measure|segment|object\.report/.test(w))).toEqual([]);
    // And the model without reports warns about exactly what the model with them does.
    expect(coverage.warnings).toEqual(withoutSite.result.coverage.warnings);
  });

  test("an attr a reporting node carries that no page prints is reported as not rendered", async () => {
    // The audit marks only the attrs the describers read. `@description` on a measure is
    // legal (a documentation attr of any node) and the Reporting section does not print it.
    const edited = await site("with", (json) => {
      const needle = '"name": "revenue",';
      expect(json.split(needle).length).toBe(2);
      return json.replace(needle, `${needle} "@description": "Gross takings.",`);
    });
    const row = edited.result.coverage.attrs.find((r) => r.key === "measure:@description");
    expect(row).toEqual({ key: "measure:@description", count: 1, consumed: false });
    expect(edited.result.coverage.warnings).toContain("coverage: measure:@description (1) not rendered by any page");
    // The attrs the section does print are still counted as rendered.
    expect(edited.result.coverage.attrs.find((r) => r.key === "measure:@agg")?.consumed).toBe(true);
  });

  test("a report is not an orphan: it is linked to the entity it reads from", () => {
    const orphans = withSite.result.anomalies.filter((a) => a.kind === "orphan").map((a) => a.subject);
    for (const name of ["StoreTotals", "ProgramEngagement", "DailyRevenue"]) expect(orphans).not.toContain(name);
    // The entity shows its reports among what references it.
    expect(text(withSite.files[`${SHOP}/WorkoutEvent.html`]!)).toContain("referenced by ProgramEngagement");
  });
});
