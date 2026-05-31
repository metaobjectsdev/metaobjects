package com.metaobjects.integration.kotlin

import com.metaobjects.integration.kotlin.tables.AssetTable
import com.metaobjects.integration.kotlin.tables.MeasurementTable
import org.jetbrains.exposed.sql.Database
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.transactions.transaction
import org.junit.jupiter.api.Test
import java.math.BigDecimal
import java.sql.DriverManager
import java.time.OffsetDateTime
import java.time.temporal.Temporal
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * SP-D Unit 4 — runtime return-type gate (Kotlin port).
 *
 * Pins ADR-0019: the Exposed-backed runtime surfaces NATIVE, in-process JVM
 * types from its query path — NOT canonicalized wire-strings. Wire
 * canonicalization (the [Normalization] forms) is a boundary concern applied at
 * the persistence-runner seam, never inside the runtime. This reads the value
 * Exposed materializes for a column (`row[col]`) BEFORE any normalization and
 * asserts each native type:
 *
 *  - `Measurement.id` (BIGINT)          → [Long]            (a native integer).
 *  - `Measurement.preciseKg` (NUMERIC)  → [BigDecimal]      (exact native decimal).
 *  - `Asset.recordedAt` (TIMESTAMPTZ)   → [OffsetDateTime]  (native temporal, NOT a String).
 *  - `Asset.payload` (jsonb)            → [String]          (Exposed surfaces the open-JSON
 *    column via identity decode; the parse-to-Map step is a harness concern. We assert what
 *    the runtime genuinely returns — raw JSON text, not a pre-canonicalized/key-sorted string).
 *
 * Per-port gate (native types differ per language), not a byte-identical
 * cross-port corpus. Catches the Python-outlier class of regression: a runtime
 * baking wire-strings into its query path.
 *
 * NOT part of the default Maven reactor build — run via
 * `mvn -f server/java/integration-tests-kotlin/pom.xml test`.
 */
class RuntimeReturnTypeTest {

    @Test
    fun `runtime returns native types not wire-strings`() {
        PostgresContainer().use { pg ->
            val db = Database.connect(pg.jdbcUrl, user = pg.username, password = pg.password)

            // Provision schema from the committed canonical DDL (ADR-0015) + seed one
            // Measurement and one Asset row.
            execSql(pg, ScenarioLoader.readCanonicalSchema(ScenarioLoader.findCorpusRoot()))
            execSql(
                pg,
                """
                INSERT INTO "measurements" ("id","tempC","massKg","preciseKg")
                VALUES (1, 1.5, 0.125, 12.5000);
                """.trimIndent(),
            )
            execSql(
                pg,
                """
                INSERT INTO "assets"
                  ("id","ownerId","externalId","payload","recordedAt","observedAt","asOfDate","atTime")
                VALUES
                  ('11111111-1111-4111-8111-111111111111',
                   'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                   '22222222-2222-4222-8222-222222222222',
                   '{"b": 2, "a": 1}',
                   '2026-05-30T14:30:00.123Z', '2026-05-30T14:30:00.123', '2026-05-30', '14:30:00.123');
                """.trimIndent(),
            )

            transaction(db) {
                // --- Measurement: native integer + native exact decimal ---------------
                val m = MeasurementTable.selectAll().single()
                val id = m[MeasurementTable.id]
                @Suppress("USELESS_IS_CHECK")
                assertTrue(id is Long, "field.long Measurement.id must be a native Long, got: ${id!!::class}")

                val preciseKg = m[MeasurementTable.preciseKg]
                assertNotNull(preciseKg, "Measurement.preciseKg should be present")
                assertTrue(
                    preciseKg is BigDecimal,
                    "field.decimal Measurement.preciseKg must be a native exact BigDecimal " +
                        "(ADR-0019), got: ${preciseKg::class}",
                )

                // --- Asset: native temporal + native jsonb representation -------------
                val a = AssetTable.selectAll().single()
                val recordedAt = a[AssetTable.recordedAt]
                assertNotNull(recordedAt, "Asset.recordedAt should be present")
                assertTrue(
                    recordedAt is OffsetDateTime,
                    "field.timestamp Asset.recordedAt (TIMESTAMPTZ) must be a native temporal " +
                        "(OffsetDateTime), NOT a String. Got: ${recordedAt::class}",
                )
                assertTrue(recordedAt is Temporal, "Asset.recordedAt must be a java.time temporal")
                assertTrue(recordedAt !is String, "Asset.recordedAt must not be a wire-string")

                // jsonb: Exposed surfaces the open-JSON column via identity decode → raw JSON
                // text (String). The parse-to-Map (key-sorting) step is a harness concern
                // (QueryScenarioRunner.rowToMap), NOT baked into the runtime. We assert the
                // runtime's genuine native return and document that canonicalization happens
                // at the boundary.
                val payload = a[AssetTable.payload]
                assertNotNull(payload, "Asset.payload should be present")
                assertTrue(
                    payload is String,
                    "Asset.payload (jsonb) is surfaced via Exposed identity decode as raw JSON " +
                        "text; got: ${payload::class}",
                )
            }
        }
    }

    private fun execSql(pg: PostgresContainer, sql: String) {
        DriverManager.getConnection(pg.jdbcUrl, pg.username, pg.password).use { c ->
            c.createStatement().use { it.execute(sql) }
        }
    }
}
