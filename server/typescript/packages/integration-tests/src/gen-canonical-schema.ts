// gen-canonical-schema.ts — (re)generate the committed canonical schema artifact.
//
// Run: `bun run gen:schema` (from this package). Pure metadata→SQL — no DB.
// Writes fixtures/persistence-conformance/canonical/schema.postgres.sql.

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import {
  CANONICAL_SCHEMA_SQL_PATH,
  describeRegenReplacement,
  generateCanonicalSchemaSql,
} from "./canonical-schema.ts";
import { loadMetadataDir } from "./load-metadata.ts";
import { CANONICAL_DIR } from "./paths.ts";

async function main(): Promise<void> {
  const root = await loadMetadataDir(CANONICAL_DIR);
  const sql = await generateCanonicalSchemaSql(root);

  // Overwrite unconditionally — this artifact is generated-wins, and refusing here would
  // block the command that repairs a red drift gate — but never SILENTLY. See
  // describeRegenReplacement for why saying so is the whole fix.
  const existing = existsSync(CANONICAL_SCHEMA_SQL_PATH)
    ? readFileSync(CANONICAL_SCHEMA_SQL_PATH, "utf8")
    : undefined;
  const replaced = describeRegenReplacement(existing, sql);

  writeFileSync(CANONICAL_SCHEMA_SQL_PATH, sql, "utf8");
  /* eslint-disable no-console */
  if (replaced !== undefined) console.warn(replaced);
  console.log(`wrote ${CANONICAL_SCHEMA_SQL_PATH} (${sql.length} bytes)`);
  /* eslint-enable no-console */
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
