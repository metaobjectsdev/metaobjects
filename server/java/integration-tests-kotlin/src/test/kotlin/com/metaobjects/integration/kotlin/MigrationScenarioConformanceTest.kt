package com.metaobjects.integration.kotlin

import com.metaobjects.integration.kotlin.tables.ProgramTable
import com.metaobjects.integration.kotlin.tables.WeekTable
import org.jetbrains.exposed.sql.Database
import org.jetbrains.exposed.sql.SchemaUtils
import org.jetbrains.exposed.sql.transactions.transaction
import org.junit.jupiter.api.Test
import java.sql.DriverManager
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Migration scenario coverage for the Kotlin/Exposed substrate. Exposed's
 * `SchemaUtils.create(*tables)` is the analogue of the sibling Java port's
 * "emit + apply CREATE DDL against the live connection" loop — both produce
 * the canonical base-table set from an empty Postgres.
 *
 * We exercise the `bootstrap-canonical-from-empty` scenario specifically: it
 * is the simplest migration in the corpus and its post-condition (the
 * `apply-up-then-query` block) lists the expected base-table set, which is
 * the natural assertion for the Exposed substrate.
 *
 * NOT registered in the parent reactor — run via:
 *   mvn -f server/java/integration-tests-kotlin/pom.xml test
 */
internal class MigrationScenarioConformanceTest {

    @Test
    fun `bootstrap canonical from empty creates the expected base tables`() {
        val corpus = ScenarioLoader.findCorpusRoot()
        val scenarios = ScenarioLoader.loadMigrations(corpus.resolve("migrations"))
        val bootstrap = scenarios.singleOrNull { it.name == BOOTSTRAP_NAME }
            ?: error("Expected scenario '$BOOTSTRAP_NAME' in corpus")

        PostgresContainer().use { pg ->
            val db = Database.connect(pg.jdbcUrl, user = pg.username, password = pg.password)

            // 1. Apply the canonical schema via Exposed's full-CREATE path —
            //    Exposed's analogue of the sibling SchemaMigrationEngine.emit() flow.
            transaction(db) {
                SchemaUtils.create(ProgramTable, WeekTable)
            }

            // 2. Run the scenario's apply-up-then-query post-condition: it queries
            //    information_schema for the BASE TABLE set in 'public' and lists the
            //    expected rows. We compare via Normalization-canonical JSON so the
            //    assertion line is byte-equal to the sibling Java port's.
            val auq = bootstrap.expect.applyUpThenQuery
                ?: error("Bootstrap scenario must declare apply-up-then-query")

            val actualRows = DriverManager.getConnection(pg.jdbcUrl, pg.username, pg.password).use { c ->
                c.createStatement().use { stmt ->
                    stmt.executeQuery(auq.sql).use { rs ->
                        val out = mutableListOf<Map<String, Any?>>()
                        val meta = rs.metaData
                        while (rs.next()) {
                            val row = LinkedHashMap<String, Any?>(meta.columnCount)
                            for (i in 1..meta.columnCount) row[meta.getColumnLabel(i)] = rs.getObject(i)
                            out.add(row)
                        }
                        out
                    }
                }
            }

            val expectedJson = Normalization.canonicalRowsJson(auq.rows)
            val actualJson = Normalization.canonicalRowsJson(actualRows)
            assertEquals(expectedJson, actualJson, "bootstrap-canonical-from-empty base-table set mismatch")

            // 3. Sanity: assert each expected table also has columns we declared.
            //    (Catches the failure mode where SchemaUtils silently no-ops because
            //    the Table object's column list was empty.)
            assertColumnsExist(pg, "programs", listOf("id", "title", "priceCents", "status", "createdAt"))
            assertColumnsExist(pg, "weeks", listOf("id", "programId", "label"))
        }
    }

    private fun assertColumnsExist(pg: PostgresContainer, table: String, expectedColumns: List<String>) {
        val sql = """
            SELECT column_name FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = '$table'
             ORDER BY column_name
        """.trimIndent()
        val actualColumns = DriverManager.getConnection(pg.jdbcUrl, pg.username, pg.password).use { c ->
            c.createStatement().use { stmt ->
                stmt.executeQuery(sql).use { rs ->
                    val cols = mutableListOf<String>()
                    while (rs.next()) cols.add(rs.getString(1))
                    cols
                }
            }
        }
        for (col in expectedColumns) {
            assertTrue(
                col in actualColumns,
                "table '$table' missing expected column '$col' — got: $actualColumns"
            )
        }
    }

    companion object {
        private const val BOOTSTRAP_NAME = "bootstrap-canonical-from-empty"
    }
}
