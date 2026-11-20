/**
 * `bun run measure`: the numbers in docs/features/metadata-driven-runtime.md.
 *
 * Two questions, both answered by running code, neither by estimate:
 *
 *   1. Size. How much code is the metadata-driven path, against what the existing reference
 *      generators emit for the same model? The generators are run here, in memory, on this
 *      example's metadata; nothing is written.
 *   2. Cost. What does reading metadata at runtime cost, per request and per row?
 *
 * Prints Markdown. Timings are medians and move with the machine; the sizes do not.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { defineConfig, runGen } from "@metaobjectsdev/codegen-ts";
import { barrel, entityFile, namesFile, queriesFile, routesFile } from "@metaobjectsdev/codegen-ts/generators";
import { formFile } from "@metaobjectsdev/codegen-ts-react";
import { tanstackGrid, tanstackGridHook, tanstackQuery } from "@metaobjectsdev/codegen-ts-tanstack";
import type { Generator } from "@metaobjectsdev/codegen-ts";
import { loadMemory } from "@metaobjectsdev/sdk";
import { buildClientModel, type ClientModel } from "../src/client/model";
import { displayValue } from "../src/client/format";
import { WorkOrderNames } from "../src/generated/WorkOrder.names";
import type { WorkOrder } from "../src/generated/WorkOrder";
import { API_PREFIX, buildApp } from "../src/server/app";
import { readListQuery } from "../src/server/list-query";
import { openRuntime } from "../src/server/runtime";
import { seed } from "../src/server/seed";
import { SERVED_ROUTE_PATH, type ServedInfo } from "../src/served";

const PROJECT_DIR = resolve(import.meta.dir, "..");
const SRC = join(PROJECT_DIR, "src");

// ---------------------------------------------------------------------------------------
// Size
// ---------------------------------------------------------------------------------------

/** Lines that are code: not blank, and not only a comment. The same rule for both sides. */
function codeLines(text: string): number {
  let inBlock = false;
  let count = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (inBlock) {
      if (line.includes("*/")) inBlock = false;
      continue;
    }
    if (line === "" || line.startsWith("//")) continue;
    if (line.startsWith("/*")) {
      if (!line.includes("*/")) inBlock = true;
      continue;
    }
    count++;
  }
  return count;
}

interface Size {
  readonly files: number;
  readonly lines: number;
}
const sizeOf = (texts: readonly string[]): Size => ({ files: texts.length, lines: texts.reduce((sum, text) => sum + codeLines(text), 0) });
const add = (a: Size, b: Size): Size => ({ files: a.files + b.files, lines: a.lines + b.lines });
const read = (...parts: string[]): string => readFileSync(join(SRC, ...parts), "utf8");

/**
 * The metadata-driven path, by what each file is for. Every file under src/ is in exactly
 * one group, which `assertEveryFileCounted` checks, so a file added later cannot go missing
 * from the table.
 */
const DYNAMIC_GROUPS: readonly { readonly label: string; readonly mechanism: boolean; readonly files: readonly string[] }[] = [
  {
    label: "Server: one route mount, the list contract, write checks, the model and its schema",
    mechanism: true,
    files: ["server/app.ts", "server/routes.ts", "server/list-query.ts", "server/write-checks.ts", "server/runtime.ts", "served.ts"],
  },
  {
    label: "Client: the model reader, `<MetaGrid>`, `<MetaForm>` and their controls",
    mechanism: true,
    files: [
      "client/api.ts", "client/model.ts", "client/context.tsx", "client/format.ts", "client/references.ts",
      "client/form-values.ts", "client/controls.tsx", "client/meta-grid.tsx", "client/meta-form.tsx",
    ],
  },
  {
    label: "Demo shell: the page, the dev server, seed rows",
    mechanism: false,
    files: ["client/app.tsx", "client/main.tsx", "client/index.html", "client/app.css", "server/main.ts", "server/client-bundle.ts", "server/seed.ts"],
  },
  { label: "Hand-written business rules", mechanism: false, files: ["server/business-rules.ts"] },
];

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [relative(SRC, join(dir, entry.name))],
  );
}

function assertEveryFileCounted(): void {
  const counted = new Set(DYNAMIC_GROUPS.flatMap((group) => group.files));
  const uncounted = filesUnder(SRC).filter((file) => !file.startsWith("generated/") && !counted.has(file));
  if (uncounted.length > 0) throw new Error(`src/ files in no measurement group: ${uncounted.join(", ")}`);
}

/**
 * The reference generators that write what the metadata-driven path does at runtime, in
 * dependency order: each is run after the ones before it, and its files are the ones the
 * run gained.
 */
const GENERATED_STACK: readonly { readonly label: string; readonly generator: () => Generator; readonly kept?: true }[] = [
  { label: "`entity`: types, Zod schemas and the Drizzle table", generator: () => entityFile() },
  { label: "`names`: name constants", generator: () => namesFile(), kept: true },
  { label: "`queries`: typed query helpers", generator: () => queriesFile() },
  { label: "`routes`: Fastify CRUD routes", generator: () => routesFile() },
  { label: "`hooks`: TanStack Query hooks", generator: () => tanstackQuery() },
  { label: "`grid`: TanStack Table columns", generator: () => tanstackGrid() },
  { label: "`grid-hook`: grid state hook", generator: () => tanstackGridHook() },
  { label: "`form`: React form component", generator: () => formFile() },
  { label: "`barrel`: index.ts", generator: () => barrel() },
];

async function generatedSizes(): Promise<{ label: string; size: Size; kept: boolean }[]> {
  const metadata = await loadMemory(PROJECT_DIR);
  // A dry run renders in memory and touches no file. The directory only gives the run a
  // project root that is not this example, whose own generated state it must not read.
  const scratch = mkdtempSync(join(process.env["DEV_SCRATCH"] ?? tmpdir(), "dynamic-grid-measure-"));
  try {
    const seen = new Set<string>();
    const sizes: { label: string; size: Size; kept: boolean }[] = [];
    for (let i = 0; i < GENERATED_STACK.length; i++) {
      const step = GENERATED_STACK[i];
      if (step === undefined) continue;
      const result = await runGen({
        config: defineConfig({
          outDir: "generated",
          outputLayout: "flat",
          extStyle: "none",
          dialect: "sqlite",
          dbImport: "../db",
          generators: GENERATED_STACK.slice(0, i + 1).map((s) => s.generator()),
        }),
        metadata,
        projectRoot: scratch,
        dryRun: true,
      });
      const rendered = result.rendered;
      if (rendered === undefined) throw new Error("the dry run returned no rendered files");
      const gained = [...rendered].filter(([path]) => !seen.has(path));
      for (const [path] of gained) seen.add(path);
      sizes.push({ label: step.label, size: sizeOf(gained.map(([, text]) => text)), kept: step.kept === true });
    }
    return sizes;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------------------

/** The median time of `run`, in milliseconds, over `rounds` timed rounds after a warm-up. */
async function medianMs(rounds: number, run: () => unknown | Promise<unknown>): Promise<number> {
  for (let i = 0; i < 3; i++) await run();
  const times: number[] = [];
  for (let i = 0; i < rounds; i++) {
    const started = performance.now();
    await run();
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)] ?? Number.NaN;
}

const ROWS = 1000;

async function costs(): Promise<string[]> {
  const runtime = await openRuntime({ projectDir: PROJECT_DIR });
  try {
    const { om, served } = runtime.current();
    await seed(om);
    const workOrder = served.get("work_orders");
    if (workOrder === undefined) throw new Error("the model serves no work_orders");

    // A table big enough that a page of it is a real page: copies of one seeded work order.
    const template = (await om.findById(WorkOrderNames.name, 1)) as (WorkOrder & { id?: number }) | null;
    if (template === null) throw new Error("the seed has no work order 1");
    const { id: _id, ...copy } = template;
    await om.createMany(WorkOrderNames.name, Array.from({ length: ROWS }, () => ({ ...copy })));

    // Server, per request: reading the query against the model (allowlists, operators, values).
    const query = { filter: { status: { in: "open,blocked" }, dueOn: { gte: "2026-01-01" } }, sort: "dueOn:desc", limit: "25", offset: "50" };
    const PARSES = 2000;
    const parseMs = await medianMs(15, () => {
      for (let i = 0; i < PARSES; i++) readListQuery(workOrder, query, undefined);
    });

    // Server, per row: the ObjectManager against the same SELECT written by hand. The
    // difference is what resolving columns and codecs from metadata costs.
    const table = WorkOrderNames.sources.primary.table;
    const omMs = await medianMs(15, () => om.findMany(WorkOrderNames.name, {}, { limit: ROWS }));
    const rawMs = await medianMs(15, () => runtime.db.selectFrom(table).selectAll().limit(ROWS).execute());

    // Client, once per model load, and per cell. (Run here, in Bun, not in a browser.)
    const app = buildApp({ runtime });
    const meta: unknown = JSON.parse((await app.inject({ method: "GET", url: `${API_PREFIX}/_meta` })).body);
    const metaBytes = Buffer.byteLength(JSON.stringify(meta));
    const info = JSON.parse((await app.inject({ method: "GET", url: `${API_PREFIX}${SERVED_ROUTE_PATH}` })).body) as ServedInfo;
    await app.close();
    const buildMs = await medianMs(15, () => buildClientModel(meta, info));
    const model: ClientModel = buildClientModel(meta, info);
    const entity = model.entity(WorkOrderNames.name);
    if (entity === undefined) throw new Error("the client model has no WorkOrder");
    const rows = await om.findMany(WorkOrderNames.name, {}, { limit: ROWS });
    const columns = entity.grid.columns.flatMap((column) => entity.field(column.field) ?? []);
    const cellsMs = await medianMs(15, () => {
      for (const row of rows) for (const field of columns) displayValue(field, row[field.name]);
    });
    // The same cells with no metadata in the loop: what a generated column's accessor does.
    const plainMs = await medianMs(15, () => {
      for (const row of rows) for (const field of columns) String(row[field.name] ?? "");
    });

    const us = (ms: number): string => `${(ms * 1000).toFixed(1)} µs`;
    const perRow = (ms: number): string => us(ms / ROWS);
    return [
      "| What | Cost | Paid |",
      "|---|---|---|",
      `| Server: read and check a list query against the model (two filters, a sort, paging) | ${us(parseMs / PARSES)} | per request |`,
      `| Server: \`ObjectManager.findMany\`, ${ROWS} rows of 9 columns | ${omMs.toFixed(2)} ms (${perRow(omMs)} a row) | per request |`,
      `| Server: the same \`SELECT\` through Kysely with no metadata | ${rawMs.toFixed(2)} ms (${perRow(rawMs)} a row) | per request |`,
      `| Server: **metadata overhead per row** (the difference) | **${perRow(omMs - rawMs)}** | per row |`,
      `| Browser: build the client model from \`/_meta\` (${(metaBytes / 1024).toFixed(1)} KB of JSON) | ${buildMs.toFixed(2)} ms | once per model load |`,
      `| Browser: format ${ROWS} rows of ${columns.length} columns from field metadata | ${cellsMs.toFixed(2)} ms (${perRow(cellsMs)} a row) | per page drawn |`,
      `| Browser: the same cells as plain \`String(value)\` | ${plainMs.toFixed(2)} ms (${perRow(plainMs)} a row) | per page drawn |`,
      `| Browser: **metadata overhead per row** (the difference) | **${perRow(cellsMs - plainMs)}** | per row |`,
    ];
  } finally {
    await runtime.close();
  }
}

// ---------------------------------------------------------------------------------------

assertEveryFileCounted();

const generated = await generatedSizes();
const keptGenerated = sizeOf(filesUnder(join(SRC, "generated")).map((file) => read(file)));
const dynamic = DYNAMIC_GROUPS.map((group) => ({ ...group, size: sizeOf(group.files.map((file) => read(file))) }));
const mechanism = dynamic.filter((group) => group.mechanism).reduce((sum, group) => add(sum, group.size), { files: 0, lines: 0 });
const generatedTotal = generated.reduce((sum, row) => add(sum, row.size), { files: 0, lines: 0 });
// One names file per entity (a value object has types but no names file).
const entityCount = filesUnder(join(SRC, "generated")).filter((file) => file.endsWith(".names.ts")).length;

const row = (label: string, size: Size): string => `| ${label} | ${size.files} | ${size.lines} |`;
const out: string[] = [];
out.push(`### Size, for this model (${entityCount} entities and a value object)`, "");
out.push("| Metadata-driven path (hand-written once, names no entity) | Files | Lines of code |", "|---|---:|---:|");
for (const group of dynamic.filter((g) => g.mechanism)) out.push(row(group.label, group.size));
out.push(row("**The mechanism: paid once, whatever the model**", mechanism));
out.push(row("**Generated and kept: types and name constants (`src/generated/`), which grow with the model**", keptGenerated));
out.push("");
out.push("| Generated path (the reference generators, same model) | Files | Lines of code |", "|---|---:|---:|");
for (const item of generated) out.push(row(item.label, item.size));
out.push(row("**Total, all of which grows with the model**", generatedTotal));
out.push("");
out.push("| Not in either total | Files | Lines of code |", "|---|---:|---:|");
for (const group of dynamic.filter((g) => !g.mechanism)) out.push(row(group.label, group.size));
out.push("");
const perObject = generatedTotal.lines / entityCount;
const keptPerObject = keptGenerated.lines / entityCount;
out.push(
  `Per entity, the generated path adds about ${Math.round(perObject)} lines in ${(generatedTotal.files / entityCount).toFixed(1)} files; ` +
    `the metadata-driven path adds about ${Math.round(keptPerObject)} (its types and name constants) and no hand-written code. ` +
    `The mechanism's ${mechanism.lines} lines are paid once, so the two paths are the same size at about ` +
    `${Math.ceil(mechanism.lines / (perObject - keptPerObject))} entities.`,
);
out.push("", "### Cost of reading metadata at runtime", "");
out.push(...(await costs()));
console.log(out.join("\n"));
