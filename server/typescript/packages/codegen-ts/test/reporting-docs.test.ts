// FR-044 Plan 3, Table G: what `meta docs` shows for a report.
//
//   model surface  a page for EVERY report (served or not), built from `reportShape`,
//                  and a "Reporting" section on the `@from` entity's page
//   api surface    one unit for a SERVED report: the row model, the list query function
//                  and `GET <served path>`. No by-id, no write, no validation schema, no
//                  hook. No unit for a report that is not served.
//
// The model pair is the one every port's FR-044 inert test shares
// (fixtures/codegen-noop/reporting/). `without/` is the no-churn half: its pages are
// pinned by a snapshot taken BEFORE this feature landed, so a model with no report
// renders what it always did.

import { describe, test, expect, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MetaDataLoader, InMemoryStringSource, type MetaObject, type MetaRoot } from "@metaobjectsdev/metadata";
import { docsFile } from "../src/generators/docs-file.js";
import { apiDocsFile } from "../src/generators/api-docs-file.js";
import { buildApiModel, type ApiUnitDoc } from "../src/generators/api-model.js";
import { makeRenderContext } from "../src/render-context.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";
import { entityFile } from "../src/generators/entity-file.js";
import { queriesFile } from "../src/generators/queries-file.js";
import { routesFile } from "../src/generators/routes-file.js";
import { routesFileHono } from "../src/generators/index.js";
import { generatableObjects } from "../src/source-detect.js";
import type { GenContext, Generator } from "../src/generator.js";
import type { OutputLayout } from "../src/import-path.js";

// test → codegen-ts → packages → typescript → server → repo root
const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..", "..");
const MODELS = join(REPO_ROOT, "fixtures", "codegen-noop", "reporting");

/** Both variants load under ONE source id: a page prints its source file, so the two
 *  must not differ by the directory they were read from. */
async function load(variant: "with" | "without"): Promise<MetaRoot> {
  const json = readFileSync(join(MODELS, variant, "meta.shop.json"), "utf8");
  const res = await new MetaDataLoader().load([
    new InMemoryStringSource(json, { id: "meta.shop.json", format: "json" }),
  ]);
  expect(res.errors).toEqual([]);
  return res.root;
}

async function loadJson(model: unknown): Promise<MetaRoot> {
  const res = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify(model), { id: "meta.json", format: "json" }),
  ]);
  expect(res.errors).toEqual([]);
  return res.root;
}

function ctxFor(root: MetaRoot, layout: OutputLayout = "flat"): GenContext {
  return {
    entities: root.objects(),
    loadedRoot: root,
    matches: () => true,
    config: {
      outDir: "docs", extStyle: "none", dbImport: "", dialect: "postgres", outputLayout: layout,
      includeHonoRoutes: true, includeUiTier: true,
    } as never,
    renderContext: makeRenderContext({
      dialect: "postgres", loadedRoot: root, outDir: "docs", dbImport: "", apiPrefix: "/api",
      pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
    }),
    warn: () => {},
  };
}

const API_SURFACES = [{ label: "TypeScript", subDir: "api/ts" }];

async function modelPages(root: MetaRoot, layout: OutputLayout = "flat"): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of await docsFile({ apiSurfaces: API_SURFACES }).generate(ctxFor(root, layout))) out[f.path] = f.content;
  return out;
}

async function apiPages(root: MetaRoot): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of await apiDocsFile({ subDir: "api/ts", modelSurface: true }).generate(ctxFor(root))) out[f.path] = f.content;
  return out;
}

function apiUnits(root: MetaRoot): ApiUnitDoc[] {
  return buildApiModel(root, { loadedRoot: root, apiPrefix: "/api", includeHonoRoutes: true }).units;
}

let withReporting: MetaRoot;
let withoutReporting: MetaRoot;

beforeAll(async () => {
  withReporting = await load("with");
  withoutReporting = await load("without");
});

describe("FR-044 no-churn: a model with no report renders every docs page as before", () => {
  test("model pages are the pre-feature snapshot", async () => {
    expect(await modelPages(withoutReporting)).toMatchSnapshot();
  });

  test("api pages are the pre-feature snapshot", async () => {
    expect(await apiPages(withoutReporting)).toMatchSnapshot();
  });

  test("an entity the with-model leaves without reporting nodes keeps its page byte for byte", async () => {
    // Program declares no dimension, measure or segment and no report names it.
    const before = await modelPages(withoutReporting);
    const after = await modelPages(withReporting);
    expect(after["Program.md"]).toBe(before["Program.md"]!);
  });
});

describe("FR-044 model surface: a page for every report", () => {
  test("each report has a page, linked from the index under Reports", async () => {
    const pages = await modelPages(withReporting);
    for (const name of ["StoreTotals", "ProgramEngagement", "DailyRevenue", "ProgramCatalogue"]) {
      expect(Object.keys(pages)).toContain(`${name}.md`);
    }
    const index = pages["README.md"]!;
    expect(index).toContain(
      "## Reports\n\n- [DailyRevenue](./DailyRevenue.md)\n- [ProgramCatalogue](./ProgramCatalogue.md)\n" +
        "- [ProgramEngagement](./ProgramEngagement.md)\n- [StoreTotals](./StoreTotals.md)\n",
    );
    // A report is not an entity: the entity list is the one the model without reports has.
    const entities = (md: string): string => {
      const start = md.indexOf("## Entities");
      return md.slice(start, md.indexOf("\n## ", start + 1));
    };
    expect(entities(index)).toBe(entities((await modelPages(withoutReporting))["README.md"]!));
  });

  test("a served report names its @from, its view and its columns with their Table B types", async () => {
    const page = (await modelPages(withReporting))["StoreTotals.md"]!;
    expect(page).toContain("**Type:** `object.report`");
    expect(page).toContain("## Report");
    expect(page).toContain("**From:** [Purchase](./Purchase.md)");
    expect(page).toContain("**View:** `v_store_totals`");
    expect(page).not.toContain("Not served");
    expect(page).toContain(
      "| Column | Type | Nullable | Role | Definition |\n" +
      "|---|---|---|---|---|\n" +
      "| `purchases` | `long` | no | measure | count of `Purchase.id` where segment `active` |\n" +
      "| `buyers` | `long` | no | measure | count of distinct `Purchase.customerEmail` where segment `active` |\n" +
      "| `revenue` | `currency` | yes | measure | sum of `Purchase.amountCents` where segment `active` |\n",
    );
    // A served report has an api unit, so its page links to it.
    expect(page).toContain("**API reference:** [TypeScript](./api/ts/StoreTotals.md)");
  });

  test("a sourceless report says it is not served, and still lists its columns and row scope", async () => {
    const pages = await modelPages(withReporting);
    const engagement = pages["ProgramEngagement.md"]!;
    expect(engagement).toContain("**From:** [WorkoutEvent](./WorkoutEvent.md)");
    expect(engagement).toContain("**View:** Not served: declares no view source");
    expect(engagement).toContain("**Row scope:** segment `completions`");
    expect(engagement).toContain("| `program` | `long` | yes | dimension | `WorkoutEvent.programId` |");
    expect(engagement).toContain(
      "| `daysEngaged` | `long` | no | measure | count of distinct (`WorkoutEvent.programId`, `WorkoutEvent.customerEmail`, `WorkoutEvent.weekNumber`, `WorkoutEvent.dayNumber`) |",
    );
    // `@default: 0`: never null, so the ratio's null rule gives way to the default.
    expect(engagement).toContain(
      "| `avgDaysPerStarter` | `decimal` | no | measure | `daysEngaged` / `starters`; `0` when there is nothing to aggregate |",
    );
    expect(engagement).toContain("| `lastActivityAt` | `timestamp` | yes | measure | max of `WorkoutEvent.occurredAt` |");
    // No api unit exists for it, so nothing links to one.
    expect(engagement).not.toContain("API reference");

    const daily = pages["DailyRevenue.md"]!;
    expect(daily).toContain("**View:** Not served: declares no view source");
    // A filter prints in its canonical form (a bare value is `eq`), as the loader holds it.
    expect(daily).toContain('**Row scope:** filter `{"purchasedAt":{"gte":{"now":"-P90D"}}}`');
    expect(daily).toContain("| `purchasedAtDay` | `date` | yes | dimension | `Purchase.purchasedAt` truncated to day, UTC |");
    expect(daily).not.toContain("API reference");
    // Neither declares @spine: no Rows line, and a row scope reads as it always did.
    for (const page of [engagement, daily]) expect(page).not.toContain("**Rows:**");
  });

  test("a @spine report says where its rows come from, and its row scope aggregates only", async () => {
    const page = (await modelPages(withReporting))["ProgramCatalogue.md"]!;
    const block = page.slice(page.indexOf("## Report\n"));
    expect(block.slice(0, block.indexOf("\n\n| Column"))).toBe(
      "## Report\n\n" +
      "**From:** [Purchase](./Purchase.md)\n" +
      "**View:** Not served: declares no view source\n" +
      "**Rows:** one row per distinct dimension tuple among the rows of `Program`, reached by `Purchase.program`, " +
        "including those no `Purchase` refers to\n" +
      '**Row scope:** aggregating only filter `{"refunded":{"eq":false}}`',
    );
    // A dimension over the spine entity's primary key is never null; one over another of
    // its columns follows that column.
    expect(page).toContain("| `programKey` | `long` | no | dimension | `Program.id` via `Purchase.program` |");
    expect(page).toContain("| `programTitle` | `string` | yes | dimension | `Program.title` via `Purchase.program` |");
    expect(page).toContain("| `revenue` | `currency` | yes | measure | sum of `Purchase.amountCents` where segment `active` |");
    expect(page).not.toContain("API reference");
  });

  test("the @from entity's page has a Reporting section: dimensions, measures, segments, reports", async () => {
    const page = (await modelPages(withReporting))["Purchase.md"]!;
    const section = page.slice(page.indexOf("## Reporting"));
    expect(section).toBe(
      "## Reporting\n\n" +
      "**Dimensions**\n\n" +
      "- `program` — `Purchase.programId`\n" +
      "- `programTitle` — `Program.title` via `Purchase.program`\n" +
      "- `purchasedAt` (time) — `Purchase.purchasedAt`; grains: day, week, month, quarter, year\n" +
      "- `programCreatedAt` (time) — `Program.createdAt` via `Purchase.program`; grains: month, year\n" +
      "- `programKey` — `Program.id` via `Purchase.program`\n\n" +
      "**Measures**\n\n" +
      "- `refundedPurchases` — count of `Purchase.id` where filter `{\"refunded\":{\"eq\":true}}`\n" +
      "- `purchases` — count of `Purchase.id` where segment `active`\n" +
      "- `buyers` — count of distinct `Purchase.customerEmail` where segment `active`\n" +
      "- `revenue` — sum of `Purchase.amountCents` where segment `active`\n\n" +
      "**Segments**\n\n" +
      "- `active` — `{\"status\":{\"eq\":\"active\"}}`\n\n" +
      "**Reports**\n\n" +
      "- [DailyRevenue](./DailyRevenue.md)\n" +
      "- [ProgramCatalogue](./ProgramCatalogue.md)\n" +
      "- [StoreTotals](./StoreTotals.md)\n",
    );
    // Everything above the section is the page the model without reporting nodes has.
    const before = (await modelPages(withoutReporting))["Purchase.md"]!;
    expect(page.slice(0, page.indexOf("\n## Reporting"))).toBe(before);
  });

  test("report and @from links resolve in package layout", async () => {
    const pages = await modelPages(withReporting, "package");
    expect(pages["acme/shop/StoreTotals.md"]).toContain("**From:** [Purchase](./Purchase.md)");
    expect(pages["acme/shop/Purchase.md"]).toContain("- [StoreTotals](./StoreTotals.md)");
    expect(pages["README.md"]).toContain("- [StoreTotals](./acme/shop/StoreTotals.md)");
  });

  test("a time dimension reached by @via, and a measure scoped by segment and filter, read in full", async () => {
    const root = await loadJson({
      "metadata.root": {
        package: "acme::billing",
        children: [
          { "object.entity": { name: "Customer", children: [
            { "source.rdb": { "@table": "customers" } },
            { "field.long": { name: "id" } },
            { "field.timestamp": { name: "joinedAt" } },
            { "identity.primary": { name: "id", "@fields": ["id"] } },
          ] } },
          { "object.entity": { name: "Invoice", children: [
            { "source.rdb": { "@table": "invoices" } },
            { "field.long": { name: "id" } },
            { "field.long": { name: "customerId" } },
            { "field.currency": { name: "amountCents" } },
            { "field.string": { name: "status" } },
            { "field.boolean": { name: "voided" } },
            { "identity.primary": { name: "id", "@fields": ["id"] } },
            { "identity.reference": { name: "customerRef", "@references": "Customer", "@fields": ["customerId"] } },
            { "relationship.association": { name: "customer", "@objectRef": "Customer", "@cardinality": "one" } },
            { "dimension.time": { name: "customerJoinedAt", "@of": "Customer.joinedAt", "@via": "Invoice.customer", "@grains": ["hour", "month"] } },
            { "measure.aggregate": { name: "paidCents", "@agg": "sum", "@of": "Invoice.amountCents", "@segment": "paid", "@filter": { voided: false } } },
            { "segment.filter": { name: "paid", "@filter": { status: "paid" } } },
          ] } },
          { "object.report": { name: "PaidByCohort", "@from": "Invoice",
            "@dimensions": ["customerJoinedAt:month"], "@measures": ["paidCents"],
            "@segment": "paid", "@filter": { voided: false },
            children: [{ "source.rdb": { "@kind": "view", "@table": "v_paid_by_cohort" } }] } },
        ],
      },
    });
    const page = (await modelPages(root))["PaidByCohort.md"]!;
    expect(page).toContain('**Row scope:** segment `paid` and filter `{"voided":{"eq":false}}`');
    expect(page).toContain(
      "| `customerJoinedAtMonth` | `date` | yes | dimension | `Customer.joinedAt` via `Invoice.customer`, truncated to month, UTC |",
    );
    expect(page).toContain(
      '| `paidCents` | `currency` | yes | measure | sum of `Invoice.amountCents` where segment `paid` and filter `{"voided":{"eq":false}}` |',
    );
  });
});

describe("FR-044 api surface: one unit for a served report, none for the rest", () => {
  test("StoreTotals has a unit; the sourceless reports have none", () => {
    const names = apiUnits(withReporting).map((u) => u.node);
    expect(names).toContain("StoreTotals");
    expect(names).not.toContain("ProgramEngagement");
    expect(names).not.toContain("DailyRevenue");
    expect(names).not.toContain("ProgramCatalogue");
  });

  test("the unit is the row model, the list query and GET <served path>, per route surface", () => {
    const unit = apiUnits(withReporting).find((u) => u.node === "StoreTotals")!;
    expect(unit.symbols.map((s) => [s.kind, s.name])).toEqual([
      ["model", "StoreTotals"],
      ["data-access", "listStoreTotals"],
      ["rest", "GET /api/store_totals"],
      ["rest-hono", "GET /api/store_totals"],
    ]);
    // The row model is the derived shape (the declared node has no fields to read).
    expect(unit.symbols[0]!.fields).toEqual([
      { name: "purchases", type: "number", optional: false },
      { name: "buyers", type: "number", optional: false },
      { name: "revenue", type: "number", optional: true },
    ]);
    // No worked create/find flow: a report has neither.
    expect(unit.example).toBeUndefined();
  });

  test("with the Hono variant off, GET <served path> is the only REST symbol", () => {
    const unit = buildApiModel(withReporting, { loadedRoot: withReporting, apiPrefix: "/api" }).units.find((u) => u.node === "StoreTotals")!;
    expect(unit.symbols.filter((s) => s.kind === "rest" || s.kind === "rest-hono").map((s) => s.name))
      .toEqual(["GET /api/store_totals"]);
  });

  test("nothing in the unit is a hook, a by-id, a write or a validation schema", async () => {
    const unit = apiUnits(withReporting).find((u) => u.node === "StoreTotals")!;
    for (const s of unit.symbols) {
      expect(s.name).not.toMatch(/^use[A-Z]/);
      expect(s.name).not.toMatch(/:id|ById|Schema$|^(create|update|delete)/);
    }
    const page = (await apiPages(withReporting))["api/ts/StoreTotals.md"]!;
    expect(page).toBeDefined();
    expect(page).not.toMatch(/\buse[A-Z]\w*\(/);
    expect(page).not.toContain(":id");
    expect(page).not.toContain("InsertSchema");
  });

  test("every documented symbol is one the real generators emit for the report", async () => {
    // The accuracy gate's rule, applied to the report: run the generators over what
    // `runGen` hands them (the served report swapped for its read model) and find each
    // documented name in the file that owns it.
    const ctx: GenContext = { ...ctxFor(withReporting), entities: generatableObjects(withReporting.objects(), withReporting) };
    const emitted = async (gen: Generator): Promise<string> => {
      const matches = (o: MetaObject): boolean => (gen.filter ? gen.filter(o) : true);
      const files = await gen.generate({ ...ctx, entities: ctx.entities.filter(matches), matches });
      return files.filter((f) => f.path.includes("StoreTotals")).map((f) => f.content).join("\n");
    };
    const entity = await emitted(entityFile());
    const queries = await emitted(queriesFile());
    const routes = await emitted(routesFile());
    const hono = await emitted(routesFileHono());
    expect(entity).toMatch(/export (type|interface) StoreTotals\b/);
    expect(queries).toContain("export async function listStoreTotals(");
    expect(queries).not.toContain("ById");
    expect(routes).toContain("storeTotalsRoutes");
    expect(routes).toContain("itemRoutes: false");
    expect(hono).toContain("registerStoreTotalsRoutes");
    // And the address: the descriptor's $path under the configured prefix.
    expect(entity).toContain('"/store_totals"');
    const unit = apiUnits(withReporting).find((u) => u.node === "StoreTotals")!;
    expect(unit.symbols.find((s) => s.kind === "rest")!.registrar).toBe("storeTotalsRoutes");
    expect(unit.symbols.find((s) => s.kind === "rest-hono")!.registrar).toBe("registerStoreTotalsRoutes");
  });

  test("the api pages differ from the no-report model by exactly the report's page and its index entries", async () => {
    const before = await apiPages(withoutReporting);
    const after = await apiPages(withReporting);
    expect(Object.keys(after).filter((p) => !(p in before))).toEqual(["api/ts/StoreTotals.md"]);
    for (const [path, content] of Object.entries(before)) {
      if (path.endsWith("README.md") || path.endsWith("AGENT-API.md")) {
        expect(after[path]).toContain("StoreTotals");
        expect(after[path]).not.toContain("ProgramEngagement");
        expect(after[path]).not.toContain("DailyRevenue");
        expect(after[path]).not.toContain("ProgramCatalogue");
        continue;
      }
      expect({ path, content: after[path] }).toEqual({ path, content });
    }
  });
});

describe("FR-044 answer 4: a keyless projection documents no item surface", () => {
  const model = (withId: boolean) => ({
    "metadata.root": {
      package: "acme::shop",
      children: [
        { "object.entity": { name: "Sale", children: [
          { "source.rdb": { "@table": "sales" } },
          { "field.long": { name: "id" } },
          { "field.string": { name: "region" } },
          { "identity.primary": { name: "id", "@fields": ["id"] } },
        ] } },
        { "object.projection": { name: "RegionTotals", children: [
          { "source.rdb": { "@kind": "view", "@table": "v_region_totals", "@unmanaged": true } },
          ...(withId ? [{ "field.long": { name: "id" } }] : []),
          { "field.string": { name: "region" } },
        ] } },
      ],
    },
  });
  const names = (root: MetaRoot): string[] =>
    apiUnits(root).find((u) => u.node === "RegionTotals")!.symbols.map((s) => s.name);

  test("no identity and no id column: no /:id endpoint and no by-id query", async () => {
    const symbols = names(await loadJson(model(false)));
    expect(symbols).toContain("GET /api/region_totals");
    expect(symbols).toContain("listRegionTotals");
    expect(symbols.filter((n) => n.includes(":id"))).toEqual([]);
    expect(symbols).not.toContain("findRegionTotalsById");
  });

  test("an id column by convention is not a declared key: no item surface either", async () => {
    const symbols = names(await loadJson(model(true)));
    expect(symbols).toContain("GET /api/region_totals");
    expect(symbols.filter((n) => n.includes(":id"))).toEqual([]);
    expect(symbols).not.toContain("findRegionTotalsById");
  });
});
