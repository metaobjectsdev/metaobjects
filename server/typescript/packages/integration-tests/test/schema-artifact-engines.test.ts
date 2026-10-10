// schema-artifact-engines.test.ts — drift-check for the committed SQLite and MySQL canonical
// schema artifacts. No DB required: metadata -> SQL, byte-compared with the committed file.
// The Postgres twin is schema-artifact.test.ts. Regenerate all three with `bun run gen:schema`.
//
// SQLite's tables and views come from `meta migrate`'s own diff/emit (dialect sqlite). MySQL's
// tables are the adopter's hand-written DDL (ADR-0015) and its views `buildReportViews`.

import { describe, expect, test } from "bun:test";

import {
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

const REPORT_VIEWS = [
  "v_program_minutes", "v_fitness_totals", "v_programs_by_month", "v_programs_by_week",
  "v_recent_programs", "v_asset_activity", "v_program_roster", "v_program_long_weeks",
  "v_fitness_totals_filled",
];

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

  test("every report view is created in each engine's artifact", () => {
    const sqlite = readCanonicalSchemaSql("sqlite");
    const mysql = readCanonicalMysqlSchemaSql();
    for (const v of REPORT_VIEWS) {
      expect(sqlite).toContain(`CREATE VIEW "${v}" AS`);
      expect(mysql).toContain(`CREATE VIEW \`${v}\` AS`);
    }
  });
});
