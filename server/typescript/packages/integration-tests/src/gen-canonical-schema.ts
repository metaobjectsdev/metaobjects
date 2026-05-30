// gen-canonical-schema.ts — (re)generate the committed canonical schema artifact.
//
// Run: `bun run gen:schema` (from this package). Pure metadata→SQL — no DB.
// Writes fixtures/persistence-conformance/canonical/schema.postgres.sql.

import { writeFileSync } from "node:fs";

import {
  CANONICAL_SCHEMA_SQL_PATH,
  generateCanonicalSchemaSql,
} from "./canonical-schema.ts";
import { CANONICAL_DIR } from "./paths.ts";
import { loadMetadataDir } from "./load-metadata.ts";

async function main(): Promise<void> {
  const root = await loadMetadataDir(CANONICAL_DIR);
  const sql = await generateCanonicalSchemaSql(root);
  writeFileSync(CANONICAL_SCHEMA_SQL_PATH, sql, "utf8");
  // eslint-disable-next-line no-console
  console.log(`wrote ${CANONICAL_SCHEMA_SQL_PATH} (${sql.length} bytes)`);
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
