// schema-artifact-engines.test.ts — drift-check for the committed SQLite and MySQL canonical
// schema artifacts. No DB required: metadata -> SQL, byte-compared with the committed file.
// The Postgres twin is schema-artifact.test.ts. Regenerate all three with `bun run gen:schema`.
//
// SQLite's tables and views come from `meta migrate`'s own diff/emit (dialect sqlite). MySQL's
// tables are the adopter's hand-written DDL (ADR-0015) and its views `buildReportViews`.

import { describe, expect, test } from "bun:test";
import { buildReportViews } from "@metaobjectsdev/codegen-ts";

import {
  CANONICAL_COLUMN_NAMING,
  canonicalSchemaSqlPath,
  generateCanonicalSchemaSql,
  readCanonicalSchemaSql,
} from "../src/canonical-schema.ts";
import {
  CANONICAL_MYSQL_SCHEMA_SQL_PATH,
  generateCanonicalMysqlSchemaSql,
  readCanonicalMysqlSchemaSql,
} from "../src/canonical-schema-mysql.ts";
import { loadMetadataDir } from "../src/load-metadata.ts";
import { CANONICAL_DIR } from "../src/paths.ts";

describe("canonical schema artifacts for the other engines", () => {
  test("schema.sqlite.sql matches what TS generates from metadata (no drift)", async () => {
    const root = await loadMetadataDir(CANONICAL_DIR);
    const generated = await generateCanonicalSchemaSql(root, { dialect: "sqlite" });
    if (generated !== readCanonicalSchemaSql("sqlite")) {
      throw new Error(
        `SQLite schema artifact is stale: ${canonicalSchemaSqlPath("sqlite")} differs from what TS ` +
          `generates. Run \`bun run gen:schema\` and commit the result.`,
      );
    }
  });

  test("schema.mysql.sql matches what TS generates from metadata (no drift)", async () => {
    const root = await loadMetadataDir(CANONICAL_DIR);
    if (generateCanonicalMysqlSchemaSql(root) !== readCanonicalMysqlSchemaSql()) {
      throw new Error(
        `MySQL schema artifact is stale: ${CANONICAL_MYSQL_SCHEMA_SQL_PATH} differs from what TS ` +
          `generates. Run \`bun run gen:schema\` and commit the result.`,
      );
    }
  });

  test("every report view is created in each engine's artifact", async () => {
    // Derived from the model, not a hand list: a report added to canonical/meta.fitness.json
    // must appear in every engine's artifact, and a lowering that emitted zero views is a
    // failure, not an empty loop.
    const root = await loadMetadataDir(CANONICAL_DIR);
    const views = buildReportViews(root, { dialect: "mysql", columnNamingStrategy: CANONICAL_COLUMN_NAMING }).map((v) => v.name);
    expect(views.length).toBeGreaterThan(0);
    const sqlite = readCanonicalSchemaSql("sqlite");
    const mysql = readCanonicalMysqlSchemaSql();
    for (const v of views) {
      expect(sqlite).toContain(`CREATE VIEW "${v}" AS`);
      expect(mysql).toContain(`CREATE VIEW \`${v}\` AS`);
    }
  });
});
