// gen-api-contract-report-schema.ts — (re)generate the committed report sub-corpus schema.
//
// Run: `bun run gen:report-api-schema` (from this package). Pure metadata→SQL — no DB.
// Writes fixtures/api-contract-conformance/report/schema.postgres.sql, schema.sqlite.sql and schema.mysql.sql.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { generateReportApiMysqlSchemaSql } from "./api-contract-report-mysql-schema.ts";
import { generateReportApiSchemaSql } from "./api-contract-report-schema.ts";
import { describeRegenReplacement } from "./canonical-schema.ts";
import { loadMetadataFile } from "./load-metadata.ts";
import {
  API_CONTRACT_REPORT_DIR,
  API_CONTRACT_REPORT_MYSQL_SCHEMA_SQL_PATH,
  API_CONTRACT_REPORT_SCHEMA_SQL_PATH,
  API_CONTRACT_REPORT_SQLITE_SCHEMA_SQL_PATH,
} from "./paths.ts";

async function main(): Promise<void> {
  const root = await loadMetadataFile(join(API_CONTRACT_REPORT_DIR, "meta.json"));
  const artifacts = [
    { path: API_CONTRACT_REPORT_SCHEMA_SQL_PATH, dialect: "postgres" },
    { path: API_CONTRACT_REPORT_SQLITE_SCHEMA_SQL_PATH, dialect: "sqlite" },
  ] as const;
  const mysqlArtifact = { path: API_CONTRACT_REPORT_MYSQL_SCHEMA_SQL_PATH, sql: generateReportApiMysqlSchemaSql(root) };
  const outputs = [
    ...(await Promise.all(artifacts.map(async ({ path, dialect }) => ({ path, sql: await generateReportApiSchemaSql(root, dialect) })))),
    mysqlArtifact,
  ];
  for (const { path, sql } of outputs) {
    // Generated-wins, never silent: same policy as gen-canonical-schema.ts.
    const existing = existsSync(path) ? readFileSync(path, "utf8") : undefined;
    const replaced = describeRegenReplacement(existing, sql);

    writeFileSync(path, sql, "utf8");
    /* eslint-disable no-console */
    if (replaced !== undefined) console.warn(replaced);
    console.log(`wrote ${path} (${sql.length} bytes)`);
    /* eslint-enable no-console */
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
