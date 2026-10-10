// api-contract-report-generated-server.ts — boots the GENERATED report routes (the
// deployed artifact) over HTTP and drives them against the FR-044 report corpus.
//
// The model is three writable entities (`Invoice`; `Product` and `Sale`, a parent and its
// child) and five `object.report` nodes; four declare `source.rdb @kind:view` and are
// served, `InvoiceDays` declares no source and must emit nothing. It:
//   1. runs the real codegen (runGen) over report/meta.json into a temp dir and fails
//      if a routes file was emitted for the sourceless report;
//   2. provisions the base tables by hand in the EMITTED snake_case spelling, then
//      creates each view from buildReportViews (the real lowering, the real view SQL)
//      under the emitted names, so the route reads through the real view;
//   3. imports the four EMITTED <Report>.routes.ts files unmodified and mounts them.
//
// Generated lane only, and on every port — see the corpus README.

import Fastify, { type FastifyInstance } from "fastify";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runGen, defineConfig, buildReportViews } from "@metaobjectsdev/codegen-ts";
import {
  DEFAULT_COLUMN_NAMING_STRATEGY, resolveColumnName, resolveTableName, type MetaRoot,
} from "@metaobjectsdev/metadata";
import { entityFile, routesFile } from "@metaobjectsdev/test-generators";
import pg from "pg";
import { executeSql } from "./postgres-sql.ts";
import { loadMetadataFile } from "./load-metadata.ts";

/** One value of a base-table row in seed.json. */
export type SeedValue = string | number | boolean | null;

/** A base-table row of seed.json, keyed by the model's field names. */
export type SeedRow = Record<string, SeedValue>;

/**
 * report/seed.json. `reports` is what the views return: the seam lanes serve it, and it
 * is not a table. Every other top-level key is a base table, named by its physical table
 * name and listed parents first, so inserting the tables in file order satisfies every
 * foreign key.
 */
export interface ReportSeed {
  reports?: Record<string, Array<Record<string, unknown>>>;
  [table: string]: SeedRow[] | Record<string, Array<Record<string, unknown>>> | undefined;
}

/** The one top-level key of seed.json that is not a base table. */
export const SEED_REPORTS_KEY = "reports";

/** One row to insert, in the EMITTED column spelling. */
export interface SeedInsert {
  table: string;
  columns: string[];
  values: SeedValue[];
}

/**
 * The rows of every base table of `seed`, in file order (parents first). A key must be the
 * table of an entity of `root` and a row key one of its fields; the column is the field's
 * emitted spelling, `resolveColumnName` under the default naming strategy, as the codegen
 * spells it. Anything else throws, so a seed the model cannot hold fails loudly.
 */
export function seedInserts(root: MetaRoot, seed: ReportSeed): SeedInsert[] {
  const out: SeedInsert[] = [];
  for (const [table, rows] of Object.entries(seed)) {
    if (table === SEED_REPORTS_KEY) continue;
    if (!Array.isArray(rows)) throw new Error(`seed.json: '${table}' is not an array of rows`);
    const entity = root.objects().find((o) => o.isEntity() && resolveTableName(o) === table);
    if (entity === undefined) throw new Error(`seed.json: '${table}' is not the table of an entity of the model`);
    const fields = new Map(entity.fields().map((f) => [f.name, f]));
    for (const row of rows) {
      const columns: string[] = [];
      const values: SeedValue[] = [];
      for (const [name, value] of Object.entries(row)) {
        const field = fields.get(name);
        if (field === undefined) throw new Error(`seed.json: '${table}' row names '${name}', not a field of ${entity.name}`);
        if (value !== null && !["string", "number", "boolean"].includes(typeof value)) {
          throw new Error(`seed.json: '${table}.${name}' is not a scalar: ${JSON.stringify(value)}`);
        }
        columns.push(resolveColumnName(field, DEFAULT_COLUMN_NAMING_STRATEGY));
        values.push(value);
      }
      out.push({ table, columns, values });
    }
  }
  return out;
}

/** paidShare compares numerically (a decimal's spelling is the engine's own); every other key strictly. */
export function rowsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a).sort();
  if (keys.join(",") !== Object.keys(b).sort().join(",")) return false;
  return keys.every((k) => (k === "paidShare" ? Number(a[k]) === Number(b[k]) : a[k] === b[k]));
}

/**
 * The base tables, parents first, in the EMITTED snake_case spelling. The routes read the
 * views and the views read these, so they are provisioned by hand rather than generated.
 */
const BASE_TABLES: ReadonlyArray<{ name: string; ddl: string }> = [
  {
    name: "invoices",
    ddl: `
    CREATE TABLE IF NOT EXISTS "invoices" (
      "id" bigserial PRIMARY KEY,
      "reference" varchar(40) NOT NULL,
      "status" varchar(20) NOT NULL,
      "amount_cents" bigint NOT NULL,
      "issued_on" date NOT NULL
    );`,
  },
  {
    name: "products",
    ddl: `
    CREATE TABLE IF NOT EXISTS "products" (
      "id" bigserial PRIMARY KEY,
      "name" text NOT NULL
    );`,
  },
  {
    name: "sales",
    ddl: `
    CREATE TABLE IF NOT EXISTS "sales" (
      "id" bigserial PRIMARY KEY,
      "product_id" bigint NOT NULL REFERENCES "products" ("id"),
      "amount_cents" bigint NOT NULL
    );`,
  },
];

export interface GeneratedReportServerHandle {
  baseUrl: string;
  applySeed(seed: ReportSeed): Promise<void>;
  close(): Promise<void>;
}

/** The served reports: emitted registrar, and the route the corpus calls. One list for every
 * engine's generated-report server — adding a report must reach all lanes at once. */
export const SERVED_REPORTS = [
  { name: "InvoiceStatusTotals", registrar: "invoiceStatusTotalsRoutes" },
  { name: "InvoicesByMonth", registrar: "invoicesByMonthRoutes" },
  { name: "InvoiceTotals", registrar: "invoiceTotalsRoutes" },
  { name: "ProductRevenue", registrar: "productRevenueRoutes" },
] as const;

export async function startGeneratedReportServer(
  connectionUri: string,
  metaPath: string,
): Promise<GeneratedReportServerHandle> {
  const here = dirname(fileURLToPath(import.meta.url));
  const genTmpRoot = join(here, "..", ".gen-tmp");
  mkdirSync(genTmpRoot, { recursive: true });
  const tmp = mkdtempSync(join(genTmpRoot, "api-contract-report-"));

  // 1. Emit the real artifacts for the report model.
  const root = await loadMetadataFile(metaPath);
  const lr = await runGen({
    config: defineConfig({
      outDir: tmp,
      extStyle: "none",
      dbImport: "./db",
      dialect: "postgres",
      apiPrefix: "/api",
      generators: [entityFile(), routesFile()],
    }),
    metadata: root,
  });
  if (existsSync(join(tmp, "InvoiceDays.routes.ts"))) {
    rmSync(tmp, { recursive: true, force: true });
    throw new Error("codegen emitted a routes file for the sourceless report InvoiceDays");
  }
  if (lr.warnings.length > 0) {
    throw new Error(`codegen produced warnings: ${lr.warnings.join("; ")}`);
  }

  // 2. db module the emitted routes import (`import { db } from "./db"`).
  const bigintTypesImport = pathToFileURL(join(here, "pg-bigint-number-types.ts")).href;
  const dbModule = `
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { bigintAsNumberTypes } from ${JSON.stringify(bigintTypesImport)};
export const pool = new pg.Pool({ connectionString: ${JSON.stringify(connectionUri)}, types: bigintAsNumberTypes });
export const db = drizzle(pool);
`;
  writeFileSync(join(tmp, "db.ts"), dbModule, "utf8");

  // 3. Provision the base tables (snake_case, the EMITTED Drizzle tables' spelling) and
  //    each view from the real lowering under the same naming strategy.
  const views = buildReportViews(root, {
    dialect: "postgres",
    columnNamingStrategy: DEFAULT_COLUMN_NAMING_STRATEGY,
  });
  const createViews = views
    .map((v) => {
      if (v.sql === undefined) throw new Error(`view ${v.name} has no SQL`);
      return `CREATE VIEW "${v.name}" AS ${v.sql};`;
    })
    .join("\n");
  await executeSql(connectionUri, `
    ${BASE_TABLES.map((t) => t.ddl).join("\n")}
    ${createViews}
  `);

  // 4. Import the EMITTED route files unmodified and mount every served report.
  const fastify = Fastify();
  for (const r of SERVED_REPORTS) {
    const mod = (await import(pathToFileURL(join(tmp, `${r.name}.routes.ts`)).href)) as Record<
      string,
      (f: FastifyInstance) => Promise<void>
    >;
    const registrar = mod[r.registrar];
    if (registrar === undefined) {
      throw new Error(`${r.name}.routes.ts does not export ${r.registrar}`);
    }
    await fastify.register(registrar);
  }
  const dbMod = (await import(pathToFileURL(join(tmp, "db.ts")).href)) as { pool: pg.Pool };
  await fastify.ready();
  const baseUrl = await fastify.listen({ host: "127.0.0.1", port: 0 });

  return {
    baseUrl,
    applySeed: async (seed: ReportSeed) => {
      await seedReport(connectionUri, root, seed);
    },
    close: async () => {
      await fastify.close();
      await dbMod.pool.end();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/**
 * Truncate every base table, then insert each base table of the seed in file order
 * (parents first). `reports` is not inserted: the views derive it on read.
 */
export async function seedReport(connectionUri: string, root: MetaRoot, seed: ReportSeed): Promise<void> {
  const truncate = `TRUNCATE TABLE ${BASE_TABLES.map((t) => `"${t.name}"`).join(", ")} RESTART IDENTITY CASCADE;`;
  const inserts = seedInserts(root, seed).map(
    (r) =>
      `INSERT INTO "${r.table}" (${r.columns.map((c) => `"${c}"`).join(",")}) ` +
      `VALUES (${r.values.map(sqlLiteral).join(", ")});`,
  );
  await executeSql(connectionUri, [truncate, ...inserts].join("\n"));
}

function sqlLiteral(v: SeedValue): string {
  if (v === null) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return `'${v.replace(/'/g, "''")}'`;
}
