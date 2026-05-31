// runtime-return-types.test.ts — SP-D Unit 4 runtime return-type gate (TS port).
//
// Pins ADR-0019: the runtime-ts ObjectManager (Kysely on Postgres) returns the
// NATIVE in-process types node-postgres produces — it applies NO read-side
// canonicalization for Postgres (see runtime-ts/type-coercer.ts: `coerceRowOnRead`
// returns the row unchanged for any non-sqlite dialect). Wire canonicalization is a
// boundary concern: the persistence-conformance harness registers PROCESS-GLOBAL pg
// temporal parsers (temporal-parsers.ts) that rewrite temporals to canonical wire
// STRINGS — but that lives in the test harness, NOT in runtime-ts.
//
// To observe runtime-ts's GENUINE native return regardless of that global harness
// mutation (bun shares module state across files in one run), this test pins the
// connection's parsers to node-postgres' pristine defaults via a per-Pool `types`
// option (pg-pristine-default-types.ts) — the same isolation pattern as
// pg-bigint-number-types.ts. The native types runtime-ts then surfaces:
//
//   * Measurement.id (BIGINT)         → string  ("1") — node-postgres' int8 default;
//                                       JS has no safe 64-bit int, so bigint→string.
//   * Measurement.preciseKg (NUMERIC) → string  ("12.5000") — TS has no native exact
//                                       decimal type; string preserves precision (ADR-0019).
//   * Asset.recordedAt (TIMESTAMPTZ)  → Date    — a native JS temporal, NOT a re-canonicalized
//                                       string. runtime-ts hands back the driver's Date; the
//                                       canonical `…Z` wire string is produced only at the boundary.
//   * Asset.payload (jsonb)           → object  — a native JS object, NOT a raw JSON string.
//
// The point: runtime-ts does not bake wire-strings into its query path. This catches
// the Python-outlier class of regression per-port (TS native types differ from the
// other ports — this is not a byte-identical cross-port corpus).

import { describe, expect, test } from "bun:test";
import { ObjectManager } from "@metaobjectsdev/runtime-ts";
import { kyselyDriver } from "@metaobjectsdev/runtime-ts/drivers";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

import { CANONICAL_COLUMN_NAMING, readCanonicalSchemaSql } from "../src/canonical-schema.ts";
import { loadMetadataDir } from "../src/load-metadata.ts";
import { CANONICAL_DIR } from "../src/paths.ts";
import { pristineDefaultTypes } from "../src/pg-pristine-default-types.ts";
import { executeSql } from "../src/postgres-sql.ts";
import { startPostgres } from "../src/postgres-container.ts";

const MEASUREMENT_SEED = `
INSERT INTO "measurements" ("id","tempC","massKg","preciseKg")
VALUES (1, 1.5, 0.125, 12.5000);
`;

const ASSET_SEED = `
INSERT INTO "assets"
  ("id","ownerId","externalId","payload","recordedAt","observedAt","asOfDate","atTime")
VALUES
  ('11111111-1111-4111-8111-111111111111',
   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   '22222222-2222-4222-8222-222222222222',
   '{"b": 2, "a": 1}',
   '2026-05-30T14:30:00.123Z', '2026-05-30T14:30:00.123', '2026-05-30', '14:30:00.123');
`;

describe("SP-D Unit 4 — runtime returns native types, not wire-strings", () => {
  test("ObjectManager surfaces native pg types (decimal=string, temporal=Date, jsonb=object)", async () => {
    const pg = await startPostgres();
    try {
      // Provision the committed TS-produced canonical schema (ADR-0015) + seed.
      await executeSql(pg.connectionUri, readCanonicalSchemaSql());
      await executeSql(pg.connectionUri, MEASUREMENT_SEED);
      await executeSql(pg.connectionUri, ASSET_SEED);

      const root = await loadMetadataDir(CANONICAL_DIR);

      // Pristine per-pool parsers isolate this read from the global temporal-parser
      // mutation the query runner installs — so we see runtime-ts's genuine native return.
      const kysely = new Kysely<Record<string, never>>({
        dialect: new PostgresDialect({
          pool: new Pool({ connectionString: pg.connectionUri, types: pristineDefaultTypes }),
        }),
      });
      try {
        const driver = kyselyDriver({ db: kysely as never, dialect: "postgres" });
        const om = new ObjectManager({
          metadata: root,
          driver,
          columnNamingStrategy: CANONICAL_COLUMN_NAMING,
        });

        // --- Measurement: native integer wire form + native decimal-as-string -----
        const m = await om.findById("Measurement", 1);
        expect(m).not.toBeNull();
        const measurement = m as Record<string, unknown>;

        // id is BIGINT → node-postgres surfaces a string ("1"). This is the native
        // runtime return for a 64-bit integer in JS (no lossy Number coercion baked in).
        expect(typeof measurement.id).toBe("string");
        expect(measurement.id).toBe("1");

        // preciseKg is NUMERIC → string (ADR-0019: TS has no native exact-decimal type;
        // string preserves full precision). Crucially it is NOT pre-canonicalized: the
        // raw scale-preserving DB text "12.5000" comes through, NOT the wire form "12.5"
        // (which is produced only by the boundary normalizer).
        expect(typeof measurement.preciseKg).toBe("string");
        expect(measurement.preciseKg).toBe("12.5000");

        // --- Asset: native temporal (Date) + native jsonb (object) ----------------
        const a = await om.findById("Asset", "11111111-1111-4111-8111-111111111111");
        expect(a).not.toBeNull();
        const asset = a as Record<string, unknown>;

        // recordedAt is TIMESTAMPTZ → a native JS Date, NOT a re-canonicalized string.
        expect(asset.recordedAt).toBeInstanceOf(Date);
        expect(typeof asset.recordedAt).not.toBe("string");

        // payload is jsonb → a native JS object, NOT a raw JSON string.
        expect(typeof asset.payload).toBe("object");
        expect(asset.payload).not.toBeNull();
        expect(asset.payload).toEqual({ b: 2, a: 1 });
      } finally {
        await kysely.destroy();
      }
    } finally {
      await pg.stop();
    }
  }, { timeout: 60_000 });
});
