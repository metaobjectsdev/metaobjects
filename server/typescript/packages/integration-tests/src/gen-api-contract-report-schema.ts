// gen-api-contract-report-schema.ts — (re)generate the committed report sub-corpus schema.
//
// Run: `bun run gen:report-api-schema` (from this package). Pure metadata→SQL — no DB.
// Writes fixtures/api-contract-conformance/report/schema.postgres.sql, schema.sqlite.sql and schema.mysql.sql.

import { join } from "node:path";

import { generateReportApiMysqlSchemaSql } from "./api-contract-report-mysql-schema.ts";
import { generateReportApiSchemaSql } from "./api-contract-report-schema.ts";
import { writeArtifact } from "./canonical-schema.ts";
import { loadMetadataFile } from "./load-metadata.ts";
import {
  API_CONTRACT_REPORT_DIR,
  API_CONTRACT_REPORT_MYSQL_SCHEMA_SQL_PATH,
  API_CONTRACT_REPORT_SCHEMA_SQL_PATH,
  API_CONTRACT_REPORT_SQLITE_SCHEMA_SQL_PATH,
} from "./paths.ts";

async function main(): Promise<void> {
  const root = await loadMetadataFile(join(API_CONTRACT_REPORT_DIR, "meta.json"));
  writeArtifact(API_CONTRACT_REPORT_SCHEMA_SQL_PATH, await generateReportApiSchemaSql(root, "postgres"));
  writeArtifact(API_CONTRACT_REPORT_SQLITE_SCHEMA_SQL_PATH, await generateReportApiSchemaSql(root, "sqlite"));
  writeArtifact(API_CONTRACT_REPORT_MYSQL_SCHEMA_SQL_PATH, generateReportApiMysqlSchemaSql(root));
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
