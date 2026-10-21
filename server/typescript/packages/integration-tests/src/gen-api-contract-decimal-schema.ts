// gen-api-contract-decimal-schema.ts — (re)generate the committed decimal sub-corpus schemas.
//
// Run: `bun run gen:decimal-api-schema` (from this package). Pure metadata→SQL — no DB.

import { join } from "node:path";

import { generateDecimalApiSchemaSql } from "./api-contract-decimal-schema.ts";
import { writeArtifact } from "./canonical-schema.ts";
import { loadMetadataFile } from "./load-metadata.ts";
import {
  API_CONTRACT_DECIMAL_DIR,
  API_CONTRACT_DECIMAL_MYSQL_SCHEMA_SQL_PATH,
  API_CONTRACT_DECIMAL_SCHEMA_SQL_PATH,
  API_CONTRACT_DECIMAL_SQLITE_SCHEMA_SQL_PATH,
} from "./paths.ts";

async function main(): Promise<void> {
  const root = await loadMetadataFile(join(API_CONTRACT_DECIMAL_DIR, "meta.json"));
  writeArtifact(API_CONTRACT_DECIMAL_SCHEMA_SQL_PATH, await generateDecimalApiSchemaSql(root, "postgres"));
  writeArtifact(API_CONTRACT_DECIMAL_SQLITE_SCHEMA_SQL_PATH, await generateDecimalApiSchemaSql(root, "sqlite"));
  writeArtifact(API_CONTRACT_DECIMAL_MYSQL_SCHEMA_SQL_PATH, await generateDecimalApiSchemaSql(root, "mysql"));
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
