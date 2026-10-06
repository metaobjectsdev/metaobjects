// gen-api-contract-report-schema.ts — (re)generate the committed report sub-corpus schema.
//
// Run: `bun run gen:report-api-schema` (from this package). Pure metadata→SQL — no DB.
// Writes fixtures/api-contract-conformance/report/schema.postgres.sql.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { generateReportApiSchemaSql } from "./api-contract-report-schema.ts";
import { describeRegenReplacement } from "./canonical-schema.ts";
import { loadMetadataFile } from "./load-metadata.ts";
import { API_CONTRACT_REPORT_DIR, API_CONTRACT_REPORT_SCHEMA_SQL_PATH } from "./paths.ts";

async function main(): Promise<void> {
  const root = await loadMetadataFile(join(API_CONTRACT_REPORT_DIR, "meta.json"));
  const sql = await generateReportApiSchemaSql(root);

  // Generated-wins, never silent: same policy as gen-canonical-schema.ts.
  const existing = existsSync(API_CONTRACT_REPORT_SCHEMA_SQL_PATH)
    ? readFileSync(API_CONTRACT_REPORT_SCHEMA_SQL_PATH, "utf8")
    : undefined;
  const replaced = describeRegenReplacement(existing, sql);

  writeFileSync(API_CONTRACT_REPORT_SCHEMA_SQL_PATH, sql, "utf8");
  /* eslint-disable no-console */
  if (replaced !== undefined) console.warn(replaced);
  console.log(`wrote ${API_CONTRACT_REPORT_SCHEMA_SQL_PATH} (${sql.length} bytes)`);
  /* eslint-enable no-console */
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
