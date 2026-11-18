// schema-artifact.test.ts — drift-check for the committed canonical schema DDL.
//
// No DB required: pure metadata→SQL. Regenerates the canonical Postgres schema
// from canonical/meta.fitness.json and asserts it is byte-identical to the
// committed fixtures/persistence-conformance/canonical/schema.postgres.sql.
// This dog-foods "TS owns schema": if metadata changes (or the emit pipeline
// does) without regenerating the artifact, CI fails here.
//
// Regenerate the artifact with: `bun run gen:schema` (in this package).

import { describe, expect, test } from "bun:test";

import {
  CANONICAL_SCHEMA_SQL_PATH,
  generateCanonicalSchemaSql,
  readCanonicalSchemaSql,
} from "../src/canonical-schema.ts";
import { loadMetadataDir } from "../src/load-metadata.ts";
import { CANONICAL_DIR } from "../src/paths.ts";

describe("canonical schema artifact (schema.postgres.sql)", () => {
  test("committed DDL matches what TS generates from metadata (no drift)", async () => {
    const root = await loadMetadataDir(CANONICAL_DIR);
    const generated = await generateCanonicalSchemaSql(root);
    const committed = readCanonicalSchemaSql();

    if (generated !== committed) {
      throw new Error(
        `Canonical schema artifact is stale.\n` +
          `  ${CANONICAL_SCHEMA_SQL_PATH}\n` +
          `differs from what TS generates from canonical/meta.fitness.json.\n` +
          `Run \`bun run gen:schema\` to regenerate, then commit the result.`,
      );
    }
    expect(generated).toBe(committed);
  });

  test("artifact carries the R6 Plan 2 Asset native types + both projection views", async () => {
    // Guards the load-bearing pieces explicitly so a regression in any single
    // emitter (uuid/jsonb/timestamptz/view) is named, not just "drift".
    const committed = readCanonicalSchemaSql();
    // Asset entity — native uuid/jsonb/timestamptz + gen_random_uuid().
    expect(committed).toContain(`"id" UUID DEFAULT gen_random_uuid()`);
    expect(committed).toContain(`"ownerId" UUID NOT NULL`);
    expect(committed).toContain(`"externalId" UUID`);
    expect(committed).toContain(`"payload" JSONB`);
    expect(committed).toContain(`"recordedAt" TIMESTAMPTZ NOT NULL`);
    // Projection views.
    expect(committed).toContain(`CREATE VIEW "v_program" AS`);
    expect(committed).toContain(`CREATE VIEW "v_program_stat" AS`);
  });

  test("Phase B: TS emits Asset temporal columns, weeks.durationMinutes, and sum/avg/min/max aggregates", async () => {
    // Generated directly from metadata (not the committed file) so this names
    // the emit-pipeline behavior independently of the drift check.
    const root = await loadMetadataDir(CANONICAL_DIR);
    const generated = await generateCanonicalSchemaSql(root);

    // Asset temporal columns: plain TIMESTAMP (no tz), DATE, native TIME.
    expect(generated).toContain(`"observedAt" TIMESTAMP NOT NULL`);
    expect(generated).toContain(`"asOfDate" DATE NOT NULL`);
    expect(generated).toContain(`"atTime" TIME NOT NULL`);

    // Week numeric source column for the aggregate projections (field.int → INTEGER).
    expect(generated).toContain(`"durationMinutes" INTEGER NOT NULL`);

    // v_program_stat rolls Week.durationMinutes up via sum/avg/min/max (+ count)
    // through the unified emitter (emitViewDdl): a single LEFT JOIN + GROUP BY,
    // aggregate keyword uppercased over the joined alias, count() de-duped to
    // survive the join. (The prior correlated-subquery form came from the
    // now-deleted migrate-ts view emitter; the two are data-equivalent for a
    // single has-many join — pinned by the projection-aggregate query scenarios.)
    expect(generated).toContain(`COUNT(DISTINCT w.id) AS "weekCount"`);
    expect(generated).toContain(`SUM(w."durationMinutes") AS "totalMinutes"`);
    expect(generated).toContain(`AVG(w."durationMinutes") AS "avgMinutes"`);
    expect(generated).toContain(`MIN(w."durationMinutes") AS "minMinutes"`);
    expect(generated).toContain(`MAX(w."durationMinutes") AS "maxMinutes"`);
    expect(generated).toContain(`LEFT OUTER JOIN weeks w ON w."programId" = p.id`);
    expect(generated).toContain(`GROUP BY p.id`);
  });
});
