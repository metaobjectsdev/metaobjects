// gen-canonical-schema.ts — (re)generate the committed canonical schema artifacts.
//
// Run: `bun run gen:schema` (from this package). Pure metadata→SQL — no DB.
// Writes fixtures/persistence-conformance/canonical/schema.postgres.sql and schema.sqlite.sql,
// then schema.mysql.sql (the adopter's tables plus the views TypeScript lowers: ADR-0015).

import {
  type CanonicalSchemaDialect,
  canonicalSchemaSqlPath,
  generateCanonicalSchemaSql,
  writeArtifact,
} from "./canonical-schema.ts";
import { CANONICAL_MYSQL_SCHEMA_SQL_PATH, generateCanonicalMysqlSchemaSql } from "./canonical-schema-mysql.ts";
import { loadMetadataDir } from "./load-metadata.ts";
import { CANONICAL_DIR } from "./paths.ts";

async function main(): Promise<void> {
  const root = await loadMetadataDir(CANONICAL_DIR);
  for (const dialect of ["postgres", "sqlite"] as const satisfies readonly CanonicalSchemaDialect[]) {
    writeArtifact(canonicalSchemaSqlPath(dialect), await generateCanonicalSchemaSql(root, { dialect }));
  }
  writeArtifact(CANONICAL_MYSQL_SCHEMA_SQL_PATH, generateCanonicalMysqlSchemaSql(root));
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
