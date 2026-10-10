// api-contract-report-mysql-server.ts — boots the GENERATED report routes on a real MySQL 8.4
// and drives them over HTTP. The Postgres twin is api-contract-report-generated-server.ts, the
// SQLite one api-contract-report-sqlite-server.ts.
//
// Same shape: run the real codegen over report/meta.json (dialect mysql), provision the base
// tables by hand in the EMITTED snake_case spelling (MetaObjects does not own a MySQL schema,
// ADR-0015), create each view from buildReportViews (the real lowering, `dialect: "mysql"`),
// import the EMITTED <Report>.routes.ts files unmodified and mount them.

import Fastify, { type FastifyInstance } from "fastify";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runGen, defineConfig, buildReportViews } from "@metaobjectsdev/codegen-ts";
import { DEFAULT_COLUMN_NAMING_STRATEGY } from "@metaobjectsdev/metadata";
import { entityFile, routesFile } from "@metaobjectsdev/test-generators";
import mysql from "mysql2/promise";
import { seedInserts, SERVED_REPORTS, type ReportSeed } from "./api-contract-report-generated-server.ts";
import { loadMetadataFile } from "./load-metadata.ts";

export interface MysqlReportServerHandle {
  baseUrl: string;
  applySeed(seed: ReportSeed): Promise<void>;
  close(): Promise<void>;
}

/** The base tables, parents first, in the EMITTED snake_case spelling. */
const BASE_TABLES: ReadonlyArray<{ name: string; ddl: string }> = [
  {
    name: "invoices",
    ddl: `CREATE TABLE \`invoices\` (
      \`id\` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      \`reference\` VARCHAR(40) NOT NULL,
      \`status\` VARCHAR(20) NOT NULL,
      \`amount_cents\` BIGINT NOT NULL,
      \`issued_on\` DATE NOT NULL
    )`,
  },
  {
    name: "products",
    ddl: `CREATE TABLE \`products\` (
      \`id\` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      \`name\` VARCHAR(200) NOT NULL
    )`,
  },
  {
    name: "sales",
    ddl: `CREATE TABLE \`sales\` (
      \`id\` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      \`product_id\` BIGINT NOT NULL,
      \`amount_cents\` BIGINT NOT NULL,
      FOREIGN KEY (\`product_id\`) REFERENCES \`products\` (\`id\`)
    )`,
  },
];

export async function startMysqlReportServer(mysqlUrl: string, metaPath: string): Promise<MysqlReportServerHandle> {
  const here = dirname(fileURLToPath(import.meta.url));
  const genTmpRoot = join(here, "..", ".gen-tmp");
  mkdirSync(genTmpRoot, { recursive: true });
  const tmp = mkdtempSync(join(genTmpRoot, "api-contract-report-mysql-"));

  const root = await loadMetadataFile(metaPath);
  const lr = await runGen({
    config: defineConfig({
      outDir: tmp,
      extStyle: "none",
      dbImport: "./db",
      dialect: "mysql",
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
    rmSync(tmp, { recursive: true, force: true });
    throw new Error(`codegen produced warnings: ${lr.warnings.join("; ")}`);
  }

  // A BIGINT is a JS number while it fits (supportBigNumbers without bigNumberStrings), the
  // spelling the Postgres lane gets from its bigint-as-number type parser; a DECIMAL stays text.
  const dbModule = `
import { drizzle } from "drizzle-orm/mysql2";
import { createPool } from "mysql2";
export const pool = createPool({ uri: ${JSON.stringify(mysqlUrl)}, timezone: "Z", supportBigNumbers: true });
export const db = drizzle(pool);
`;
  writeFileSync(join(tmp, "db.ts"), dbModule, "utf8");
  const dbMod = (await import(pathToFileURL(join(tmp, "db.ts")).href)) as { pool: { end(cb: () => void): void } };

  const admin = await mysql.createConnection({ uri: mysqlUrl, timezone: "Z" });
  const views = buildReportViews(root, { dialect: "mysql", columnNamingStrategy: DEFAULT_COLUMN_NAMING_STRATEGY });
  for (const v of views) await admin.query(`DROP VIEW IF EXISTS \`${v.name}\``);
  for (const t of [...BASE_TABLES].reverse()) await admin.query(`DROP TABLE IF EXISTS \`${t.name}\``);
  for (const t of BASE_TABLES) await admin.query(t.ddl);
  for (const v of views) {
    if (v.sql === undefined) throw new Error(`view ${v.name} has no SQL`);
    await admin.query(`CREATE VIEW \`${v.name}\` AS ${v.sql}`);
  }

  const fastify = Fastify();
  for (const r of SERVED_REPORTS) {
    const mod = (await import(pathToFileURL(join(tmp, `${r.name}.routes.ts`)).href)) as Record<
      string,
      (f: FastifyInstance) => Promise<void>
    >;
    const registrar = mod[r.registrar];
    if (registrar === undefined) throw new Error(`${r.name}.routes.ts does not export ${r.registrar}`);
    await fastify.register(registrar);
  }
  await fastify.ready();
  const baseUrl = await fastify.listen({ host: "127.0.0.1", port: 0 });

  return {
    baseUrl,
    applySeed: async (seed: ReportSeed) => {
      // Children before parents on the way out; the seed's file order (parents first) on the way in.
      for (const t of [...BASE_TABLES].reverse()) await admin.query(`DELETE FROM \`${t.name}\``);
      for (const r of seedInserts(root, seed)) {
        await admin.query(
          `INSERT INTO \`${r.table}\` (${r.columns.map((c) => `\`${c}\``).join(",")}) ` +
            `VALUES (${r.columns.map(() => "?").join(",")})`,
          r.values,
        );
      }
    },
    close: async () => {
      await fastify.close();
      await new Promise<void>((done) => dbMod.pool.end(done));
      for (const v of views) await admin.query(`DROP VIEW IF EXISTS \`${v.name}\``);
      for (const t of [...BASE_TABLES].reverse()) await admin.query(`DROP TABLE IF EXISTS \`${t.name}\``);
      await admin.end();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}
